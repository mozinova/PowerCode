//! Debugging: the `vscode.debug` API and the debug adapters themselves. The
//! host starts each session's adapter (a process, a socket or an inline
//! implementation) and speaks the Debug Adapter Protocol to it; the UI drives
//! the session (initialize, launch, breakpoints, stepping) through
//! `debug/request` and receives the adapter's events as `debug/event`.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { currentEditor, executeCommand } from "./api";
import * as rpc from "./rpc";
import { host, lookup, type ExtensionDescription } from "./state";
import {
  CancellationTokenSource,
  DebugAdapterExecutable,
  DebugAdapterInlineImplementation,
  DebugAdapterNamedPipeServer,
  DebugAdapterServer,
  Disposable,
  EventEmitter,
  FunctionBreakpoint,
  Location,
  Position,
  SourceBreakpoint,
  Uri,
} from "./types";

type Message = { seq: number; type: "request" | "response" | "event"; [key: string]: any };

// ---- Connections ------------------------------------------------------------------

/** A channel to a debug adapter: DAP messages in and out. */
interface Connection {
  send(message: Message): void;
  onMessage(listener: (message: Message) => void): void;
  onClose(listener: (error?: string) => void): void;
  close(): void;
}

/** Content-Length framed DAP over a byte stream (stdio, TCP, named pipe). */
function streamConnection(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream, close: () => void): Connection {
  const messageListeners: ((message: Message) => void)[] = [];
  const closeListeners: ((error?: string) => void)[] = [];
  let buffer = Buffer.alloc(0);
  readable.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      if (buffer.length < headerEnd + 4 + length) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      buffer = buffer.subarray(headerEnd + 4 + length);
      try {
        const message = JSON.parse(body);
        messageListeners.forEach((l) => l(message));
      } catch {
        // A malformed message is skipped.
      }
    }
  });
  let closed = false;
  const fireClose = (error?: string) => {
    if (closed) return;
    closed = true;
    closeListeners.forEach((l) => l(error));
  };
  readable.on("end", () => fireClose());
  readable.on("error", (e: Error) => fireClose(e.message));
  return {
    send(message) {
      const body = Buffer.from(JSON.stringify(message), "utf8");
      writable.write(`Content-Length: ${body.length}\r\n\r\n`);
      writable.write(body);
    },
    onMessage: (l) => void messageListeners.push(l),
    onClose: (l) => void closeListeners.push(l),
    close() {
      close();
      fireClose();
    },
  };
}

function connectSocket(options: net.NetConnectOpts): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    socket.once("connect", () => resolve(streamConnection(socket, socket, () => socket.destroy())));
    socket.once("error", reject);
  });
}

async function connect(descriptor: unknown): Promise<{ connection: Connection; process?: ChildProcess }> {
  if (descriptor instanceof DebugAdapterExecutable || (descriptor as any)?.command) {
    const d = descriptor as DebugAdapterExecutable;
    const child = spawn(d.command, d.args ?? [], {
      cwd: d.options?.cwd,
      env: { ...process.env, ...(d.options?.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // `.cmd`/`.bat` adapters need a shell on Windows.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(d.command),
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.stderr!.on("data", (d: Buffer) => rpc.notify("log", { level: "warning", message: `[debug adapter] ${d.toString().trimEnd()}` }));
    const connection = streamConnection(child.stdout!, child.stdin!, () => child.kill());
    child.on("exit", () => connection.close());
    return { connection, process: child };
  }
  if (descriptor instanceof DebugAdapterServer || typeof (descriptor as any)?.port === "number") {
    const d = descriptor as DebugAdapterServer;
    return { connection: await connectSocket({ port: d.port, host: d.host ?? "127.0.0.1" }) };
  }
  if (descriptor instanceof DebugAdapterNamedPipeServer || typeof (descriptor as any)?.path === "string") {
    return { connection: await connectSocket({ path: (descriptor as DebugAdapterNamedPipeServer).path }) };
  }
  if (descriptor instanceof DebugAdapterInlineImplementation || (descriptor as any)?.implementation) {
    const impl = (descriptor as DebugAdapterInlineImplementation).implementation;
    const messageListeners: ((message: Message) => void)[] = [];
    const closeListeners: ((error?: string) => void)[] = [];
    const subscription = impl.onDidSendMessage((m) => messageListeners.forEach((l) => l(m as Message)));
    return {
      connection: {
        send: (message) => impl.handleMessage(message),
        onMessage: (l) => void messageListeners.push(l),
        onClose: (l) => void closeListeners.push(l),
        close() {
          subscription.dispose();
          impl.dispose?.();
          closeListeners.forEach((l) => l());
        },
      },
    };
  }
  throw new Error("Unknown kind of debug adapter.");
}

// ---- Registries ---------------------------------------------------------------------

const configurationProviders: { type: string; provider: any; triggerKind: number }[] = [];
const descriptorFactories = new Map<string, any>();
const trackerFactories: { type: string; factory: any }[] = [];

/** Set by the host: activates extensions for an activation event (`onDebugResolve:node`, ...). */
let activate: (event: string) => Promise<void> = async () => {};
export function setDebugActivator(fn: (event: string) => Promise<void>) {
  activate = fn;
}

// ---- Sessions -----------------------------------------------------------------------

interface Session {
  id: string;
  api: any;
  connection: Connection;
  process?: ChildProcess;
  seq: number;
  pending: Map<number, { resolve: (body: unknown) => void; reject: (e: Error) => void }>;
  trackers: any[];
  ended: boolean;
}

const sessions = new Map<string, Session>();
let nextSession = 1;
let activeSession: any;

const onDidStartDebugSession = new EventEmitter<any>();
const onDidTerminateDebugSession = new EventEmitter<any>();
const onDidChangeActiveDebugSession = new EventEmitter<any>();
const onDidReceiveDebugSessionCustomEvent = new EventEmitter<any>();
const onDidChangeBreakpoints = new EventEmitter<any>();
const onDidChangeActiveStackItem = new EventEmitter<any>();

/** Events of the protocol itself; the others are "custom" events for extensions. */
const STANDARD_EVENTS = new Set([
  "initialized", "stopped", "continued", "exited", "terminated", "thread", "output", "breakpoint", "module",
  "loadedSource", "process", "capabilities", "progressStart", "progressUpdate", "progressEnd", "invalidated", "memory",
]);

function sendRequest(session: Session, command: string, args?: unknown): Promise<any> {
  if (session.ended) return Promise.reject(new Error("The debug session has ended."));
  const seq = session.seq++;
  const message: Message = { seq, type: "request", command, arguments: args };
  session.trackers.forEach((t) => t.onWillReceiveMessage?.(message));
  return new Promise((resolve, reject) => {
    session.pending.set(seq, { resolve, reject });
    session.connection.send(message);
  });
}

function respond(session: Session, request: Message, body?: unknown, error?: string) {
  const message: Message = {
    seq: session.seq++,
    type: "response",
    request_seq: request.seq,
    command: request.command,
    success: error === undefined,
    message: error,
    body,
  };
  session.trackers.forEach((t) => t.onWillReceiveMessage?.(message));
  session.connection.send(message);
}

/** Requests the adapter makes of the client. */
async function handleReverseRequest(session: Session, request: Message) {
  try {
    if (request.command === "runInTerminal") {
      const result = await rpc.request<{ processId?: number }>("debug/runInTerminal", request.arguments);
      respond(session, request, result ?? {});
    } else if (request.command === "startDebugging") {
      // A child session (js-debug starts one per debugged process).
      const { configuration, request: kind } = request.arguments ?? {};
      await startSession({ ...configuration, request: kind ?? configuration?.request }, { parent: session.api, resolved: true });
      respond(session, request, {});
    } else {
      respond(session, request, undefined, `Unsupported request '${request.command}'.`);
    }
  } catch (e) {
    respond(session, request, undefined, e instanceof Error ? e.message : String(e));
  }
}

function endSession(session: Session, notifyUi: boolean) {
  if (session.ended) return;
  session.ended = true;
  for (const waiting of session.pending.values()) waiting.reject(new Error("The debug session has ended."));
  session.pending.clear();
  session.trackers.forEach((t) => t.onWillStopSession?.());
  try {
    session.connection.close();
  } catch {
    // Already closed.
  }
  session.trackers.forEach((t) => t.onExit?.(session.process?.exitCode ?? undefined, undefined));
  sessions.delete(session.id);
  if (notifyUi) rpc.notify("debug/sessionEnded", { sessionId: session.id });
  onDidTerminateDebugSession.fire(session.api);
  if (activeSession === session.api) {
    activeSession = [...sessions.values()].pop()?.api;
    onDidChangeActiveDebugSession.fire(activeSession);
  }
}

// ---- Configurations -----------------------------------------------------------------

/** Parses JSON with comments and trailing commas, as `launch.json` allows. */
function parseJsonc(text: string): any {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function launchConfigurations(): any[] {
  const root = host.workspaceFolders[0]?.uri.fsPath;
  if (!root) return [];
  try {
    return parseJsonc(fs.readFileSync(path.join(root, ".vscode", "launch.json"), "utf8")).configurations ?? [];
  } catch {
    return [];
  }
}

/** Facts about the editor for `${file}` and friends, sent by the UI when it starts a session. */
export interface DebugContext {
  file?: string;
  lineNumber?: number;
  selectedText?: string;
}

let lastContext: DebugContext = {};

async function substitute(value: unknown, context: DebugContext): Promise<unknown> {
  if (typeof value === "string") {
    const folder = host.workspaceFolders[0]?.uri.fsPath ?? "";
    const file = context.file ?? "";
    const replacements: Record<string, () => unknown> = {
      workspaceFolder: () => folder,
      workspaceRoot: () => folder,
      workspaceFolderBasename: () => path.basename(folder),
      file: () => file,
      fileBasename: () => path.basename(file),
      fileBasenameNoExtension: () => path.basename(file, path.extname(file)),
      fileExtname: () => path.extname(file),
      fileDirname: () => path.dirname(file),
      fileDirnameBasename: () => path.basename(path.dirname(file)),
      fileWorkspaceFolder: () => folder,
      relativeFile: () => (folder && file ? path.relative(folder, file) : file),
      relativeFileDirname: () => (folder && file ? path.relative(folder, path.dirname(file)) : path.dirname(file)),
      lineNumber: () => String(context.lineNumber ?? ""),
      selectedText: () => context.selectedText ?? "",
      cwd: () => folder || process.cwd(),
      pathSeparator: () => path.sep,
      "/": () => path.sep,
      userHome: () => os.homedir(),
      execPath: () => process.execPath,
    };
    // `${command:x}` may be the whole value and return a non-string (e.g. a process id).
    const whole = /^\$\{command:([^}]+)\}$/.exec(value);
    if (whole) return executeCommand(whole[1]);
    let result = value;
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
      const [token, name] = match;
      let replacement: unknown;
      if (name.startsWith("env:")) replacement = process.env[name.slice(4)] ?? "";
      else if (name.startsWith("config:")) replacement = lookup(name.slice(7)) ?? "";
      else if (name.startsWith("command:")) replacement = await executeCommand(name.slice(8));
      else if (replacements[name]) replacement = replacements[name]();
      else continue;
      result = result.replace(token, String(replacement ?? ""));
    }
    return result;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => substitute(v, context)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await substitute(v, context);
    return out;
  }
  return value;
}

/**
 * Runs providers' `resolveDebugConfiguration*` hooks; undefined/null means "cancelled".
 * Without a launch.json the configuration is empty (`{}`) and `typeHint` says whose
 * providers resolve it, as in VS Code (they then fill in "debug the current file").
 */
async function resolveConfiguration(config: any, context: DebugContext, typeHint?: string): Promise<any> {
  const folder = host.workspaceFolders[0];
  const token = new CancellationTokenSource().token;
  const type = config.type ?? typeHint;
  if (type) await activate(`onDebugResolve:${type}`);
  const providersFor = (t: string | undefined) => configurationProviders.filter((p) => p.type === t || p.type === "*");
  for (const { provider } of providersFor(type)) {
    if (!provider.resolveDebugConfiguration) continue;
    config = await provider.resolveDebugConfiguration(folder, config, token);
    if (!config) return config;
  }
  // A provider may have filled in the type of an empty configuration.
  if (!config.type && type) config.type = type;
  config = await substitute(config, context);
  for (const { provider } of providersFor(config.type)) {
    if (!provider.resolveDebugConfigurationWithSubstitutedVariables) continue;
    config = await provider.resolveDebugConfigurationWithSubstitutedVariables(folder, config, token);
    if (!config) return config;
  }
  return config;
}

/** The adapter an extension declares in `contributes.debuggers` (program, runtime, per-OS variants). */
function declaredExecutable(type: string): DebugAdapterExecutable | undefined {
  for (const ext of host.extensions as ExtensionDescription[]) {
    for (const debuggerInfo of ext.manifest.contributes?.debuggers ?? []) {
      if (debuggerInfo.type !== type) continue;
      const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
      const info = { ...debuggerInfo, ...(debuggerInfo[platform] ?? {}) };
      if (!info.program) continue;
      const program = path.isAbsolute(info.program) ? info.program : path.join(ext.path, info.program);
      if (info.runtime) {
        const runtime = info.runtime === "node" ? process.execPath : info.runtime;
        return new DebugAdapterExecutable(runtime, [...(info.runtimeArgs ?? []), program, ...(info.args ?? [])]);
      }
      return new DebugAdapterExecutable(program, info.args ?? []);
    }
  }
  return undefined;
}

// ---- Starting -----------------------------------------------------------------------------

async function startSession(
  config: any,
  options: { parent?: any; context?: DebugContext; resolved?: boolean; noDebug?: boolean; type?: string } = {},
): Promise<string | undefined> {
  const context = options.context ?? lastContext;
  await activate("onDebug");
  if (options.noDebug) config = { ...config, noDebug: true };
  if (!options.resolved) {
    config = await resolveConfiguration(config, context, options.type);
    if (!config) return undefined;
  }
  if (!config.type) throw new Error("The debug configuration has no type.");
  await activate(`onDebugAdapterProtocolTracker:${config.type}`);

  const id = `debug-${nextSession++}`;
  const folder = host.workspaceFolders[0];
  const api: any = {
    id,
    type: config.type,
    name: config.name ?? config.type,
    workspaceFolder: folder,
    configuration: config,
    parentSession: options.parent,
    customRequest: (command: string, args?: unknown) => {
      const session = sessions.get(id);
      return session ? sendRequest(session, command, args) : Promise.reject(new Error("The debug session has ended."));
    },
    getDebugProtocolBreakpoint: async () => undefined,
  };

  const factory = descriptorFactories.get(config.type);
  const executable = declaredExecutable(config.type);
  const descriptor = (await factory?.createDebugAdapterDescriptor(api, executable)) ?? executable;
  if (!descriptor) throw new Error(`No debug adapter is available for '${config.type}'. Install an extension that provides it.`);

  const trackers = (
    await Promise.all(
      trackerFactories.filter((t) => t.type === config.type || t.type === "*").map(async (t) => t.factory.createDebugAdapterTracker(api)),
    )
  ).filter(Boolean);
  trackers.forEach((t) => t.onWillStartSession?.());

  const { connection, process: adapterProcess } = await connect(descriptor);
  const session: Session = { id, api, connection, process: adapterProcess, seq: 1, pending: new Map(), trackers, ended: false };
  sessions.set(id, session);

  connection.onMessage((message) => {
    trackers.forEach((t) => t.onDidSendMessage?.(message));
    if (message.type === "response") {
      const waiting = session.pending.get(message.request_seq);
      if (!waiting) return;
      session.pending.delete(message.request_seq);
      if (message.success) waiting.resolve(message.body ?? null);
      else waiting.reject(new Error(message.body?.error?.format ?? message.message ?? `${message.command} failed`));
    } else if (message.type === "event") {
      rpc.notify("debug/event", { sessionId: id, event: message.event, body: message.body ?? null });
      if (!STANDARD_EVENTS.has(message.event)) onDidReceiveDebugSessionCustomEvent.fire({ session: api, event: message.event, body: message.body });
    } else if (message.type === "request") {
      void handleReverseRequest(session, message);
    }
  });
  connection.onClose((error) => {
    if (error) trackers.forEach((t) => t.onError?.(new Error(error)));
    endSession(session, true);
  });

  activeSession = api;
  onDidStartDebugSession.fire(api);
  onDidChangeActiveDebugSession.fire(api);
  rpc.notify("debug/sessionStarted", {
    sessionId: id,
    name: api.name,
    type: config.type,
    configuration: config,
    parentId: options.parent?.id,
  });
  return id;
}

// ---- Breakpoints --------------------------------------------------------------------------

interface BreakpointDto {
  id: string;
  enabled: boolean;
  path?: string;
  line?: number;
  functionName?: string;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

let breakpoints: any[] = [];

function toApiBreakpoint(b: BreakpointDto) {
  const bp = b.functionName
    ? new FunctionBreakpoint(b.functionName, b.enabled, b.condition, b.hitCondition, b.logMessage)
    : new SourceBreakpoint(new Location(Uri.file(b.path!), new Position((b.line ?? 1) - 1, 0)), b.enabled, b.condition, b.hitCondition, b.logMessage);
  Object.defineProperty(bp, "id", { value: b.id });
  return bp;
}

function toDto(bp: any): BreakpointDto {
  if (bp instanceof FunctionBreakpoint) return { id: bp.id, enabled: bp.enabled, functionName: bp.functionName, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage };
  return {
    id: bp.id,
    enabled: bp.enabled,
    path: bp.location.uri.fsPath,
    line: bp.location.range.start.line + 1,
    condition: bp.condition,
    hitCondition: bp.hitCondition,
    logMessage: bp.logMessage,
  };
}

// ---- API ------------------------------------------------------------------------------------

export function createDebugApi() {
  return {
    get activeDebugSession() {
      return activeSession;
    },
    get breakpoints() {
      return breakpoints;
    },
    activeStackItem: undefined,
    activeDebugConsole: {
      append: (value: string) => rpc.notify("debug/consoleAppend", { text: value }),
      appendLine: (value: string) => rpc.notify("debug/consoleAppend", { text: `${value}\n` }),
    },
    onDidStartDebugSession: onDidStartDebugSession.event,
    onDidTerminateDebugSession: onDidTerminateDebugSession.event,
    onDidChangeActiveDebugSession: onDidChangeActiveDebugSession.event,
    onDidReceiveDebugSessionCustomEvent: onDidReceiveDebugSessionCustomEvent.event,
    onDidChangeBreakpoints: onDidChangeBreakpoints.event,
    onDidChangeActiveStackItem: onDidChangeActiveStackItem.event,
    registerDebugConfigurationProvider(type: string, provider: unknown, triggerKind = 1) {
      const entry = { type, provider, triggerKind };
      configurationProviders.push(entry);
      return new Disposable(() => configurationProviders.splice(configurationProviders.indexOf(entry), 1));
    },
    registerDebugAdapterDescriptorFactory(type: string, factory: unknown) {
      descriptorFactories.set(type, factory);
      return new Disposable(() => descriptorFactories.delete(type));
    },
    registerDebugAdapterTrackerFactory(type: string, factory: unknown) {
      const entry = { type, factory };
      trackerFactories.push(entry);
      return new Disposable(() => trackerFactories.splice(trackerFactories.indexOf(entry), 1));
    },
    async startDebugging(_folder: unknown, nameOrConfig: string | any, parentOrOptions?: any) {
      const config = typeof nameOrConfig === "string" ? launchConfigurations().find((c) => c.name === nameOrConfig) : nameOrConfig;
      if (!config) return false;
      const parent = parentOrOptions?.parentSession ?? (parentOrOptions?.id ? parentOrOptions : undefined);
      try {
        const editor = currentEditor();
        const context = editor ? { file: editor.document.uri.fsPath, lineNumber: editor.selection.active.line + 1, selectedText: editor.document.getText(editor.selection) } : lastContext;
        return (await startSession(config, { parent, context, noDebug: parentOrOptions?.noDebug })) !== undefined;
      } catch (e) {
        rpc.notify("debug/startFailed", { message: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    async stopDebugging(session?: any) {
      const targets = session ? [session.id] : [...sessions.keys()];
      for (const id of targets) rpc.notify("debug/stopRequested", { sessionId: id });
    },
    addBreakpoints(added: any[]) {
      rpc.notify("debug/addBreakpoints", { breakpoints: added.map(toDto) });
    },
    removeBreakpoints(removed: any[]) {
      rpc.notify("debug/removeBreakpoints", { ids: removed.map((b) => b.id) });
    },
    asDebugSourceUri(source: { path?: string; sourceReference?: number; name?: string }, session?: any) {
      if (source.path && !source.sourceReference) return Uri.file(source.path);
      return Uri.from({ scheme: "debug", path: source.path ?? source.name ?? "source", query: `session=${session?.id ?? ""}&ref=${source.sourceReference ?? 0}` });
    },
    registerDebugVisualizationProvider: () => new Disposable(() => {}),
    registerDebugVisualizationTreeProvider: () => new Disposable(() => {}),
  };
}

// ---- Messages from the UI ----------------------------------------------------------------------

export function listen() {
  rpc.onRequest("debug/start", async (params: { configuration: any; type?: string; context?: DebugContext; noDebug?: boolean }) => {
    if (params.context) lastContext = params.context;
    return (await startSession(params.configuration, { context: params.context, noDebug: params.noDebug, type: params.type })) ?? null;
  });
  rpc.onRequest("debug/request", (params: { sessionId: string; command: string; arguments?: unknown }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("The debug session has ended.");
    return sendRequest(session, params.command, params.arguments);
  });
  rpc.onNotification("debug/end", (params: { sessionId: string }) => {
    const session = sessions.get(params.sessionId);
    if (session) endSession(session, false);
  });
  rpc.onNotification("debug/focus", (params: { sessionId: string }) => {
    const session = sessions.get(params.sessionId);
    if (session && activeSession !== session.api) {
      activeSession = session.api;
      onDidChangeActiveDebugSession.fire(activeSession);
    }
  });
  rpc.onNotification("debug/breakpoints", (params: { breakpoints: BreakpointDto[] }) => {
    const before = new Map(breakpoints.map((b) => [b.id, b]));
    breakpoints = params.breakpoints.map(toApiBreakpoint);
    const after = new Map(breakpoints.map((b) => [b.id, b]));
    const added = breakpoints.filter((b) => !before.has(b.id));
    const removed = [...before.values()].filter((b) => !after.has(b.id));
    const changed = breakpoints.filter((b) => before.has(b.id) && JSON.stringify(toDto(b)) !== JSON.stringify(toDto(before.get(b.id))));
    if (added.length || removed.length || changed.length) onDidChangeBreakpoints.fire({ added, removed, changed });
  });
  rpc.onRequest("debug/configurations", async () => {
    // Dynamic configurations of the debuggers (e.g. "Run npm script"), for the picker.
    for (const ext of host.extensions as ExtensionDescription[]) {
      for (const d of ext.manifest.contributes?.debuggers ?? []) await activate(`onDebugDynamicConfigurations:${d.type}`);
    }
    await activate("onDebugDynamicConfigurations");
    const folder = host.workspaceFolders[0];
    const token = new CancellationTokenSource().token;
    const result: any[] = [];
    for (const { provider, triggerKind } of configurationProviders) {
      if (triggerKind !== 2 || !provider.provideDebugConfigurations) continue;
      try {
        result.push(...((await provider.provideDebugConfigurations(folder, token)) ?? []));
      } catch {
        // A failing provider just contributes nothing.
      }
    }
    return result;
  });
}
