//! Debug sessions on the UI side. The extension host owns each adapter; this
//! module drives the protocol (initialize, launch/attach, breakpoints,
//! configurationDone, stepping) and keeps what the views show: threads,
//! stack frames, the focused frame and the debug console.

import { create } from "zustand";
import * as rpc from "../exthost/rpc";
import { notify } from "../state/notifications";
import { isVirtualTab } from "../lib/virtualTabs";
import { useWorkspace } from "../state/workspace";
import { newProgramTerminal } from "../terminal/sessions";
import { remoteOf } from "../lib/remote";
import {
  addBreakpoints,
  breakpointsIn,
  toggleBreakpoint,
  clearBreakpointStatus,
  onBreakpointsChange,
  removeBreakpoints,
  setBreakpointStatus,
  useBreakpoints,
} from "./breakpoints";

export interface StackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { name?: string; path?: string; sourceReference?: number };
  presentationHint?: string;
}

export interface ThreadState {
  id: number;
  name: string;
  stopped: boolean;
  reason?: string;
  frames: StackFrame[] | null;
}

export type SessionStatus = "initializing" | "running" | "stopped" | "terminated";

export interface SessionState {
  id: string;
  name: string;
  type: string;
  parentId?: string;
  configuration: any;
  capabilities: any;
  status: SessionStatus;
  threads: ThreadState[];
}

export interface ConsoleEntry {
  id: number;
  kind: "output" | "input" | "result" | "error" | "info";
  category?: string;
  text: string;
  /** Expandable value (e.g. an object logged or evaluated). */
  variablesReference?: number;
  sessionId?: string;
}

export interface Focus {
  sessionId: string;
  threadId: number;
  frameId: number | null;
}

interface DebugState {
  sessions: SessionState[];
  focus: Focus | null;
  console: ConsoleEntry[];
  /** Bumped on every stop: variable references from before are stale. */
  generation: number;
}

export const useDebug = create<DebugState>(() => ({ sessions: [], focus: null, console: [], generation: 0 }));

const MAX_CONSOLE_ENTRIES = 5000;
let nextEntry = 1;

export function appendConsole(entry: Omit<ConsoleEntry, "id">) {
  useDebug.setState(({ console }) => {
    const last = console[console.length - 1];
    // Output arrives in pieces; pieces of one line join the previous entry.
    if (entry.kind === "output" && last?.kind === "output" && last.category === entry.category && !last.text.endsWith("\n") && !entry.variablesReference && !last.variablesReference) {
      return { console: [...console.slice(0, -1), { ...last, text: last.text + entry.text }] };
    }
    const next = [...console, { ...entry, id: nextEntry++ }];
    return { console: next.length > MAX_CONSOLE_ENTRIES ? next.slice(-MAX_CONSOLE_ENTRIES) : next };
  });
}

export function clearConsole() {
  useDebug.setState({ console: [] });
}

function updateSession(id: string, change: (s: SessionState) => Partial<SessionState>) {
  useDebug.setState(({ sessions }) => ({ sessions: sessions.map((s) => (s.id === id ? { ...s, ...change(s) } : s)) }));
}

export const sessionById = (id: string) => useDebug.getState().sessions.find((s) => s.id === id);

/** Sends a DAP request to a session's adapter. */
export function dap<T = any>(sessionId: string, command: string, args?: unknown): Promise<T> {
  return rpc.request<T>("debug/request", { sessionId, command, arguments: args });
}

// ---- Lifecycle ------------------------------------------------------------------------

/** Resolvers of each session's `initialized` event. */
const initialized = new Map<string, () => void>();
/** Breakpoint ids the adapter gave our breakpoints, per session, for `breakpoint` events. */
const adapterBreakpointIds = new Map<string, Map<number, string>>();
/** Configurations as first requested, for restarting. */
const launchRequests = new Map<string, { configuration: any; type?: string; noDebug?: boolean }>();

export function rememberLaunch(sessionId: string, request: { configuration: any; type?: string; noDebug?: boolean }) {
  launchRequests.set(sessionId, request);
}

async function sendBreakpoints(sessionId: string, path: string) {
  const entries = breakpointsIn(path).filter((b) => b.enabled);
  try {
    const result = await dap<{ breakpoints: { id?: number; verified: boolean; line?: number; message?: string }[] }>(sessionId, "setBreakpoints", {
      source: { path, name: path.split(/[\\/]/).pop() },
      breakpoints: entries.map((b) => ({ line: b.line, condition: b.condition || undefined, hitCondition: b.hitCondition || undefined, logMessage: b.logMessage || undefined })),
      lines: entries.map((b) => b.line),
      sourceModified: false,
    });
    const ids = adapterBreakpointIds.get(sessionId) ?? new Map();
    adapterBreakpointIds.set(sessionId, ids);
    result?.breakpoints?.forEach((bp, i) => {
      const entry = entries[i];
      if (!entry) return;
      if (bp.id !== undefined) ids.set(bp.id, entry.id);
      setBreakpointStatus(entry.id, { verified: bp.verified, line: bp.line, message: bp.message });
    });
  } catch (e) {
    entries.forEach((b) => setBreakpointStatus(b.id, { verified: false, message: e instanceof Error ? e.message : String(e) }));
  }
}

async function sendAllBreakpoints(sessionId: string) {
  const paths = new Set(useBreakpoints.getState().list.map((b) => b.path));
  await Promise.all([...paths].map((path) => sendBreakpoints(sessionId, path)));
}

/** Runs the start sequence of a session the host just created. */
async function runSession(session: SessionState) {
  const { id, configuration } = session;
  const initializedEvent = new Promise<void>((resolve) => initialized.set(id, resolve));
  try {
    const capabilities = await dap(id, "initialize", {
      clientID: "powercode",
      clientName: "PowerCode",
      adapterID: session.type,
      locale: "en",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: true,
      supportsStartDebuggingRequest: true,
      supportsProgressReporting: false,
      supportsInvalidatedEvent: true,
      supportsMemoryReferences: false,
      supportsArgsCanBeInterpretedByShell: false,
    });
    updateSession(id, () => ({ capabilities: capabilities ?? {} }));
    // Some adapters answer `launch` only after `configurationDone`, so it is not awaited yet.
    const launched = dap(id, configuration.request === "attach" ? "attach" : "launch", configuration);
    await Promise.race([initializedEvent, launched.then(() => initializedEvent)]);
    await sendAllBreakpoints(id);
    const filters = (capabilities?.exceptionBreakpointFilters ?? []).filter((f: any) => f.default).map((f: any) => f.filter);
    if (capabilities?.exceptionBreakpointFilters) await dap(id, "setExceptionBreakpoints", { filters }).catch(() => {});
    if (capabilities?.supportsConfigurationDoneRequest) await dap(id, "configurationDone");
    await launched;
    updateSession(id, (s) => (s.status === "initializing" ? { status: "running" } : {}));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    appendConsole({ kind: "error", text: `${session.name}: ${message}\n`, sessionId: id });
    notify("error", `Could not start "${session.name}"`, message);
    void stopSession(id);
  }
}

/** Ends a session: terminates the debuggee when possible, then disconnects. */
export async function stopSession(id: string) {
  const session = sessionById(id);
  if (!session) return;
  // Children go first (e.g. the processes a js-debug session attached to).
  for (const child of useDebug.getState().sessions.filter((s) => s.parentId === id)) await stopSession(child.id);
  if (session.status !== "terminated") {
    updateSession(id, () => ({ status: "terminated" }));
    const launch = session.configuration.request !== "attach";
    try {
      if (launch && session.capabilities?.supportsTerminateRequest) {
        await withTimeout(dap(id, "terminate", {}), 2000);
      }
      await withTimeout(dap(id, "disconnect", { restart: false, terminateDebuggee: launch }), 2000);
    } catch {
      // The adapter is gone or unresponsive: the host closes it anyway.
    }
  }
  rpc.notify("debug/end", { sessionId: id });
  removeSession(id);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function removeSession(id: string) {
  initialized.delete(id);
  adapterBreakpointIds.delete(id);
  launchRequests.delete(id);
  useDebug.setState(({ sessions, focus }) => {
    const remaining = sessions.filter((s) => s.id !== id);
    return { sessions: remaining, focus: focus?.sessionId === id ? null : focus };
  });
  if (useDebug.getState().sessions.length === 0) clearBreakpointStatus();
}

/** Stops every session and starts the root session again (or uses the adapter's `restart`). */
export async function restartSession(id: string) {
  const root = rootOf(id);
  if (!root) return;
  if (root.capabilities?.supportsRestartRequest) {
    try {
      await dap(root.id, "restart", { arguments: root.configuration });
      return;
    } catch {
      // Fall back to stopping and starting.
    }
  }
  const request = launchRequests.get(root.id) ?? { configuration: root.configuration };
  await stopSession(root.id);
  await startConfiguration(request.configuration, { type: request.type, noDebug: request.noDebug });
}

function rootOf(id: string): SessionState | undefined {
  let session = sessionById(id);
  while (session?.parentId) session = sessionById(session.parentId) ?? session;
  return session;
}

/** Context for `${file}` and friends: the focused editor. */
function editorContext() {
  const { activePath, cursor } = useWorkspace.getState();
  return { file: activePath ?? undefined, lineNumber: cursor?.line };
}

/** Starts a debug session for a configuration (empty with `type` when there is no launch.json). */
export async function startConfiguration(configuration: any, options: { type?: string; noDebug?: boolean } = {}) {
  try {
    const sessionId = await rpc.request<string | null>("debug/start", {
      configuration,
      type: options.type,
      noDebug: options.noDebug,
      context: editorContext(),
    });
    if (sessionId) rememberLaunch(sessionId, { configuration, type: options.type, noDebug: options.noDebug });
    return sessionId;
  } catch (e) {
    notify("error", "Could not start debugging", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ---- Stopping and stepping --------------------------------------------------------------

async function loadThreads(sessionId: string) {
  try {
    const result = await dap<{ threads: { id: number; name: string }[] }>(sessionId, "threads");
    updateSession(sessionId, (s) => ({
      threads: (result?.threads ?? []).map((t) => s.threads.find((old) => old.id === t.id) ?? { id: t.id, name: t.name, stopped: false, frames: null }).map((t, i) => ({ ...t, name: result.threads[i].name })),
    }));
  } catch {
    // Threads come with the next stop.
  }
}

async function loadFrames(sessionId: string, threadId: number): Promise<StackFrame[]> {
  try {
    const result = await dap<{ stackFrames: StackFrame[] }>(sessionId, "stackTrace", { threadId, startFrame: 0, levels: 200 });
    const frames = result?.stackFrames ?? [];
    updateSession(sessionId, (s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, frames } : t)) }));
    return frames;
  } catch {
    return [];
  }
}

/** Shows a frame: focuses it and opens its source at the line. */
export function focusFrame(sessionId: string, threadId: number, frame: StackFrame | null) {
  useDebug.setState({ focus: { sessionId, threadId, frameId: frame?.id ?? null } });
  rpc.notify("debug/focus", { sessionId });
  const path = frame?.source?.path;
  if (frame && path && !frame.source?.sourceReference) {
    useWorkspace.getState().openFileAt(path, frame.line, Math.max(1, frame.column), Math.max(1, frame.column));
  }
}

async function onStopped(sessionId: string, body: any) {
  const threadId: number | undefined = body.threadId;
  updateSession(sessionId, (s) => ({
    status: "stopped",
    threads: s.threads.map((t) => (body.allThreadsStopped || t.id === threadId ? { ...t, stopped: true, reason: body.reason, frames: null } : t)),
  }));
  useDebug.setState(({ generation }) => ({ generation: generation + 1 }));
  await loadThreads(sessionId);
  updateSession(sessionId, (s) => ({
    threads: s.threads.map((t) => (body.allThreadsStopped || t.id === threadId ? { ...t, stopped: true, reason: body.reason } : t)),
  }));
  const target = threadId ?? sessionById(sessionId)?.threads[0]?.id;
  if (target === undefined) return;
  const frames = await loadFrames(sessionId, target);
  if (body.preserveFocusHint && useDebug.getState().focus) return;
  // The first frame with a source the user can open (skipping internals without a path).
  const frame = frames.find((f) => f.source?.path && f.presentationHint !== "subtle") ?? frames[0] ?? null;
  focusFrame(sessionId, target, frame);
  // The Run and Debug tool window shows where it stopped.
  useWorkspace.getState().showTool("debug");
  if (body.reason === "exception" && (body.description || body.text)) {
    appendConsole({ kind: "error", text: `${body.description ?? "Exception"}${body.text ? `: ${body.text}` : ""}\n`, sessionId });
  }
}

function onContinued(sessionId: string, threadId: number | undefined, all: boolean) {
  updateSession(sessionId, (s) => {
    const threads = s.threads.map((t) => (all || t.id === threadId ? { ...t, stopped: false, reason: undefined, frames: null } : t));
    return { threads, status: threads.some((t) => t.stopped) ? "stopped" : "running" };
  });
  const focus = useDebug.getState().focus;
  if (focus?.sessionId === sessionId && (all || focus.threadId === threadId)) useDebug.setState({ focus: { ...focus, frameId: null } });
}

/** The session and thread commands apply to: the focused one, else the first stopped one. */
function target(): { sessionId: string; threadId: number } | null {
  const { focus, sessions } = useDebug.getState();
  if (focus) return { sessionId: focus.sessionId, threadId: focus.threadId };
  for (const s of sessions) {
    const thread = s.threads.find((t) => t.stopped) ?? s.threads[0];
    if (thread) return { sessionId: s.id, threadId: thread.id };
  }
  return null;
}

async function step(command: "continue" | "next" | "stepIn" | "stepOut" | "pause") {
  const t = target();
  if (!t) return;
  try {
    await dap(t.sessionId, command, { threadId: t.threadId });
    // Some adapters send no `continued` event for the thread they were asked to run.
    if (command !== "pause") onContinued(t.sessionId, t.threadId, command === "continue" && !sessionById(t.sessionId)?.capabilities?.supportsSingleThreadExecutionRequests);
  } catch (e) {
    notify("error", `${command} failed`, e instanceof Error ? e.message : String(e));
  }
}

export const debugContinue = () => step("continue");
export const debugPause = () => step("pause");
export const debugStepOver = () => step("next");
export const debugStepInto = () => step("stepIn");
export const debugStepOut = () => step("stepOut");

export function debugStop() {
  const { sessions } = useDebug.getState();
  // Stopping the root sessions also stops their children.
  return Promise.all(sessions.filter((s) => !s.parentId).map((s) => stopSession(s.id)));
}

export function debugRestart() {
  const t = target() ?? (useDebug.getState().sessions[0] ? { sessionId: useDebug.getState().sessions[0].id } : null);
  return t ? restartSession(t.sessionId) : Promise.resolve();
}

/** F9: toggles a breakpoint on the cursor's line of the focused file. */
export function toggleBreakpointAtCursor() {
  const { activePath, cursor } = useWorkspace.getState();
  if (activePath && cursor && !isVirtualTab(activePath)) toggleBreakpoint(activePath, cursor.line);
}

/** Evaluates an expression in the focused frame (console, watch, hover). */
export async function evaluate(expression: string, context: "repl" | "watch" | "hover") {
  const focus = useDebug.getState().focus;
  const sessionId = focus?.sessionId ?? useDebug.getState().sessions[0]?.id;
  if (!sessionId) throw new Error("No debug session is running.");
  return dap<{ result: string; type?: string; variablesReference: number }>(sessionId, "evaluate", {
    expression,
    frameId: focus?.frameId ?? undefined,
    context,
  }).then((r) => ({ ...r, sessionId }));
}

// ---- Messages from the host ----------------------------------------------------------------

export function registerDebugHandlers() {
  rpc.onNotification("debug/sessionStarted", ({ sessionId, name, type, configuration, parentId }) => {
    const session: SessionState = { id: sessionId, name, type, parentId, configuration, capabilities: {}, status: "initializing", threads: [] };
    useDebug.setState(({ sessions }) => ({ sessions: [...sessions, session] }));
    appendConsole({ kind: "info", text: `Started ${name}\n`, sessionId });
    if (!parentId && useWorkspace.getState().bottomTool !== "debug") useWorkspace.getState().toggleBottomTool("debug");
    void runSession(session);
  });
  rpc.onNotification("debug/sessionEnded", ({ sessionId }) => {
    if (!sessionById(sessionId)) return;
    appendConsole({ kind: "info", text: `${sessionById(sessionId)!.name} ended\n`, sessionId });
    for (const child of useDebug.getState().sessions.filter((s) => s.parentId === sessionId)) void stopSession(child.id);
    removeSession(sessionId);
  });
  rpc.onNotification("debug/stopRequested", ({ sessionId }) => void stopSession(sessionId));
  rpc.onNotification("debug/startFailed", ({ message }) => notify("error", "Could not start debugging", message));
  rpc.onNotification("debug/consoleAppend", ({ text }) => appendConsole({ kind: "output", category: "console", text }));
  rpc.onNotification("debug/event", ({ sessionId, event, body }) => {
    const b = body ?? {};
    switch (event) {
      case "initialized":
        initialized.get(sessionId)?.();
        break;
      case "stopped":
        void onStopped(sessionId, b);
        break;
      case "continued":
        onContinued(sessionId, b.threadId, b.allThreadsContinued !== false);
        break;
      case "thread":
        void loadThreads(sessionId);
        break;
      case "output":
        if (b.category === "telemetry") break;
        appendConsole({
          kind: b.category === "stderr" ? "error" : "output",
          category: b.category ?? "console",
          text: b.output ?? "",
          variablesReference: b.variablesReference || undefined,
          sessionId,
        });
        break;
      case "breakpoint": {
        const ours = b.breakpoint?.id !== undefined ? adapterBreakpointIds.get(sessionId)?.get(b.breakpoint.id) : undefined;
        if (ours) setBreakpointStatus(ours, { verified: b.breakpoint.verified, line: b.breakpoint.line, message: b.breakpoint.message });
        break;
      }
      case "capabilities":
        updateSession(sessionId, (s) => ({ capabilities: { ...s.capabilities, ...(b.capabilities ?? {}) } }));
        break;
      case "invalidated":
        useDebug.setState(({ generation }) => ({ generation: generation + 1 }));
        break;
      case "exited":
        appendConsole({ kind: "info", text: `Process exited with code ${b.exitCode}\n`, sessionId });
        break;
      case "terminated":
        void stopSession(sessionId).then(() => {
          if (b.restart !== undefined && b.restart !== false) {
            const request = launchRequests.get(sessionId);
            if (request) void startConfiguration(request.configuration, request);
          }
        });
        break;
    }
  });
  rpc.onNotification("debug/addBreakpoints", ({ breakpoints }) =>
    addBreakpoints(breakpoints.filter((b: any) => b.path).map((b: any) => ({ ...b, enabled: b.enabled !== false }))),
  );
  rpc.onNotification("debug/removeBreakpoints", ({ ids }) => removeBreakpoints(ids));
  rpc.onRequest("debug/runInTerminal", async (args: { cwd?: string; args: string[]; env?: Record<string, string | null>; title?: string }) => {
    const [command, ...rest] = args.args;
    const cwd = args.cwd || useWorkspace.getState().root;
    const session = newProgramTerminal(cwd, args.title ?? "Debug", { command, args: rest, env: args.env ?? {} });
    const { bottomTool, toggleBottomTool } = useWorkspace.getState();
    if (bottomTool !== "terminal") toggleBottomTool("terminal");
    // The program's process id, for adapters that attach to it; on a remote it is ssh's or wsl's, so none.
    const pid = await new Promise<number | null>((resolve) => {
      session.onStart(resolve);
      setTimeout(() => resolve(null), 5000);
    });
    return pid !== null && !remoteOf(cwd) ? { processId: pid } : {};
  });

  // Breakpoint edits reach every session as they happen.
  onBreakpointsChange((paths) => {
    for (const session of useDebug.getState().sessions) {
      if (session.status === "terminated" || session.status === "initializing") continue;
      for (const path of paths) void sendBreakpoints(session.id, path);
    }
  });
}

/** Forgets every session (the extension host restarted). */
export function resetDebug() {
  initialized.clear();
  adapterBreakpointIds.clear();
  launchRequests.clear();
  useDebug.setState({ sessions: [], focus: null });
  clearBreakpointStatus();
}

