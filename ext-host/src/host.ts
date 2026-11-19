//! PowerCode's extension host: a Node process that runs VS Code extensions'
//! JavaScript, giving each one the `vscode` API (see api.ts) and talking to
//! the UI over stdin/stdout (see rpc.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import Module from "node:module";
import { activateForCommand, createApi, executeCommand, extensionStates, hostEvents, setCommandActivator } from "./api";
import { documentFor, documents, onDidChange, onDidClose, onDidOpen, onDidSave, TextDocumentImpl } from "./documents";
import { matchesGlob } from "./glob";
import * as providers from "./providers";
import * as rpc from "./rpc";
import * as views from "./views";
import * as debug from "./debug";
import * as authentication from "./authentication";
import * as chat from "./chat";
import * as comments from "./comments";
import * as lm from "./lm";
import * as scm from "./scm";
import * as testing from "./testing";
import * as files from "./files";
import * as tabs from "./tabs";
import * as tasks from "./tasks";
import * as terminals from "./terminals";
import * as virtual from "./virtual";
import { collectDefaults, host, onDidChangeColorTheme, onDidChangeConfiguration, type ExtensionDescription } from "./state";
import { EventEmitter, ExtensionMode, Range, Uri } from "./types";

// Extensions' console output goes to the "Extension Host" log, never to the protocol stream.
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) =>
    rpc.notify("log", {
      level: level === "warn" ? "warning" : level === "error" ? "error" : "info",
      message: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : safeJson(a))).join(" "),
    });
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---- `require("vscode")` -------------------------------------------------------

const apis = new Map<string, unknown>();

function extensionOf(filename: string | undefined): ExtensionDescription | undefined {
  if (!filename) return undefined;
  const normalized = path.resolve(filename).toLowerCase();
  return host.extensions.find((e) => normalized.startsWith(path.resolve(e.path).toLowerCase() + path.sep));
}

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request !== "vscode") return originalLoad.call(this, request, parent, isMain);
  // Each extension gets its own API object (commands and providers are attributed to it).
  const extension = extensionOf(parent?.filename) ?? host.extensions[0];
  if (!extension) throw new Error("The vscode module is only available to extensions.");
  let api = apis.get(extension.id);
  if (!api) {
    api = createApi(extension);
    apis.set(extension.id, api);
  }
  return api;
};

// ---- Extension context ------------------------------------------------------

/** A Memento persisted as JSON, for `globalState` and `workspaceState`. */
function memento(file: string) {
  let values: Record<string, unknown> = {};
  try {
    values = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // First use.
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(values));
  };
  return {
    get: <T>(key: string, defaultValue?: T) => (key in values ? (values[key] as T) : defaultValue),
    update(key: string, value: unknown) {
      if (value === undefined) delete values[key];
      else values[key] = value;
      save();
      return Promise.resolve();
    },
    keys: () => Object.keys(values),
    setKeysForSync() {},
  };
}

/** Secrets that could not be stored encrypted (no OS credential store): kept for this session only. */
const memorySecrets = new Map<string, string>();
let warnedAboutSecrets = false;

/**
 * An extension's `SecretStorage`: encrypted by the app on the local machine (also
 * for a remote host), under the extension's id. Without an OS credential store,
 * secrets are kept in memory, never written unencrypted.
 */
function secretsFor(extensionId: string) {
  const full = (key: string) => `${extensionId}/${key}`;
  const fallback = (e: unknown) => {
    if (!warnedAboutSecrets) {
      warnedAboutSecrets = true;
      rpc.notify("log", { level: "warning", message: `Secrets are kept in memory only: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  return {
    async get(key: string): Promise<string | undefined> {
      if (memorySecrets.has(full(key))) return memorySecrets.get(full(key));
      try {
        return (await rpc.request<string | null>("secrets/get", { key: full(key) })) ?? undefined;
      } catch (e) {
        fallback(e);
        return undefined;
      }
    },
    async store(key: string, value: string) {
      try {
        await rpc.request("secrets/set", { key: full(key), value });
        memorySecrets.delete(full(key));
      } catch (e) {
        fallback(e);
        memorySecrets.set(full(key), value);
      }
    },
    async delete(key: string) {
      memorySecrets.delete(full(key));
      await rpc.request("secrets/delete", { key: full(key) }).catch(fallback);
    },
  };
}

function context(extension: ExtensionDescription, subscriptions: { dispose(): unknown }[]) {
  const globalStorage = path.join(host.globalStoragePath, extension.id);
  const workspaceStorage = path.join(host.storagePath, extension.id);
  const secretChanges = new EventEmitter<{ key: string }>();
  const secretStorage = secretsFor(extension.id);
  return {
    subscriptions,
    extensionPath: extension.path,
    extensionUri: Uri.file(extension.path),
    extensionMode: ExtensionMode.Production,
    extension: (createApi(extension) as any).extensions.getExtension(extension.id),
    globalState: memento(path.join(globalStorage, "state.json")),
    workspaceState: memento(path.join(workspaceStorage, "state.json")),
    secrets: {
      get: (key: string) => secretStorage.get(key),
      store: async (key: string, value: string) => {
        await secretStorage.store(key, value);
        secretChanges.fire({ key });
      },
      delete: async (key: string) => {
        await secretStorage.delete(key);
        secretChanges.fire({ key });
      },
      onDidChange: secretChanges.event,
    },
    globalStorageUri: Uri.file(globalStorage),
    globalStoragePath: globalStorage,
    storageUri: Uri.file(workspaceStorage),
    storagePath: workspaceStorage,
    logUri: Uri.file(path.join(host.logPath, extension.id)),
    logPath: path.join(host.logPath, extension.id),
    asAbsolutePath: (relative: string) => path.join(extension.path, relative),
    environmentVariableCollection: {
      persistent: false,
      replace() {},
      append() {},
      prepend() {},
      get() {},
      forEach() {},
      delete() {},
      clear() {},
      getScoped() {
        return this;
      },
    },
    languageModelAccessInformation: { onDidChange: new EventEmitter<void>().event, canSendRequest: () => undefined },
  };
}

// ---- Activation -------------------------------------------------------------

const deactivators: (() => unknown)[] = [];

/** The activation events of an extension, including the implicit ones VS Code derives. */
function activationEvents(extension: ExtensionDescription): string[] {
  const events = new Set<string>(extension.manifest.activationEvents ?? []);
  for (const command of extension.manifest.contributes?.commands ?? []) events.add(`onCommand:${command.command}`);
  for (const language of extension.manifest.contributes?.languages ?? []) events.add(`onLanguage:${language.id}`);
  for (const d of extension.manifest.contributes?.debuggers ?? []) {
    if (d?.type) events.add(`onDebugResolve:${d.type}`);
  }
  for (const editor of extension.manifest.contributes?.customEditors ?? []) {
    if (editor?.viewType) events.add(`onCustomEditor:${editor.viewType}`);
  }
  for (const container of Object.values<any[]>(extension.manifest.contributes?.views ?? {})) {
    for (const view of container ?? []) if (view?.id) events.add(`onView:${view.id}`);
  }
  return [...events];
}

const runnable = () => host.extensions.filter((e) => typeof e.manifest.main === "string");

async function activate(extension: ExtensionDescription) {
  let state = extensionStates.get(extension.id);
  if (!state) {
    state = { active: false };
    extensionStates.set(extension.id, state);
  }
  if (state.active || state.activate) return state.activate;
  const run = async () => {
    // Dependencies activate first, as in VS Code.
    for (const dependency of extension.manifest.extensionDependencies ?? []) {
      const required = host.extensions.find((e) => e.id === String(dependency).toLowerCase());
      if (required && typeof required.manifest.main === "string") await activate(required);
    }
    const name = extension.manifest.displayName ?? extension.manifest.name;
    try {
      const main = require(path.resolve(extension.path, extension.manifest.main));
      const subscriptions: { dispose(): unknown }[] = [];
      const exports = await main.activate?.(context(extension, subscriptions));
      state!.exports = exports;
      state!.active = true;
      deactivators.push(async () => {
        await main.deactivate?.();
        subscriptions.forEach((s) => {
          try {
            s.dispose();
          } catch {
            // Keep disposing the rest.
          }
        });
      });
      rpc.notify("extensions/activated", { id: extension.id });
    } catch (e) {
      rpc.notify("extensions/activationFailed", {
        id: extension.id,
        name,
        message: e instanceof Error ? e.stack ?? e.message : String(e),
      });
    }
  };
  state.activate = run();
  return state.activate;
}

const fired = new Set<string>();

/** Activates every extension listening for `event` (once per event). */
async function activateByEvent(event: string) {
  if (fired.has(event)) return;
  fired.add(event);
  // `*` extensions start with the host (the `*` event), not again for each event: an
  // `executeCommand` in their own `activate` would otherwise wait for itself.
  await Promise.all(
    runnable()
      .filter((e) => activationEvents(e).includes(event))
      .map(activate),
  );
}

/** `workspaceContains:<glob>` activates when a matching file exists in the workspace. */
function activateForWorkspaceContents() {
  const root = host.workspaceFolders[0]?.uri.fsPath;
  if (!root) return;
  for (const extension of runnable()) {
    const globs = activationEvents(extension)
      .filter((a) => a.startsWith("workspaceContains:"))
      .map((a) => a.slice("workspaceContains:".length));
    if (globs.length === 0) continue;
    if (containsMatch(root, globs, 0)) void activate(extension);
  }
}

function containsMatch(dir: string, globs: string[], depth: number): boolean {
  if (depth > 6) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const root = host.workspaceFolders[0].uri.fsPath;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).replace(/\\/g, "/");
    if (globs.some((g) => matchesGlob(relative, g))) return true;
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git" && containsMatch(full, globs, depth + 1)) return true;
  }
  return false;
}

setCommandActivator(async (command) => activateByEvent(`onCommand:${command}`));
debug.setDebugActivator(activateByEvent);
tasks.setTaskActivator(activateByEvent);
chat.setChatActivator(activateByEvent);
lm.setLmActivator(activateByEvent);
authentication.setAuthenticationActivator(activateByEvent);

// ---- Messages from the UI ---------------------------------------------------

rpc.onRequest("initialize", async (params: any) => {
  host.appRoot = params.appRoot ?? "";
  host.workspaceFolders = (params.workspaceFolders ?? []).map((f: { uri: string; name: string }, index: number) => ({
    uri: Uri.parse(f.uri),
    name: f.name,
    index,
  }));
  host.extensions = params.extensions;
  host.settings = params.settings ?? {};
  host.defaults = collectDefaults(host.extensions);
  host.languages = params.languages ?? [];
  host.storagePath = params.storagePath;
  host.globalStoragePath = params.globalStoragePath;
  host.logPath = params.logPath;
  host.webviewOrigin = params.webviewOrigin ?? "";
  host.colorThemeKind = params.colorThemeKind ?? 2;
  host.remote = params.remote ?? null;
  host.trusted = params.trusted !== false;
  host.localExtensionPaths = params.localExtensionPaths ?? {};
  return {
    // Commands contributed by extensions with code, for the command palette.
    commands: runnable().flatMap((e) =>
      (e.manifest.contributes?.commands ?? []).map((c: any) => ({
        command: c.command,
        title: typeof c.title === "string" ? c.title : c.title?.value,
        category: typeof c.category === "string" ? c.category : c.category?.value,
        extension: e.id,
      })),
    ),
    defaults: host.defaults,
  };
});

rpc.onNotification("start", async () => {
  // The Chat view lists declared participants before their extensions activate.
  chat.announce();
  await activateByEvent("*");
  activateForWorkspaceContents();
  await activateByEvent("onStartupFinished");
});

rpc.onNotification("activate", (params: { event: string }) => activateByEvent(params.event));

rpc.onRequest("commands/execute", async (params: { command: string; args?: unknown[] }) => {
  await activateForCommand(params.command);
  const result = await executeCommand(params.command, ...(params.args ?? []).map(revive));
  return Uri.isUri(result) ? { $uri: result.toString() } : result ?? null;
});

/**
 * Arguments from the UI: `{ $uri }` objects become Uris again, `{ $treeItem }` the
 * tree element, `{ $scm }` a source control, resource group or resource state.
 */
function revive(arg: any): unknown {
  if (arg && typeof arg === "object" && typeof arg.$uri === "string") return Uri.parse(arg.$uri);
  if (arg && typeof arg === "object" && arg.$treeItem) return views.treeElement(arg.$treeItem);
  if (arg && typeof arg === "object" && arg.$scm) return scm.scmElement(arg.$scm);
  if (arg && typeof arg === "object" && arg.$comment) return comments.commentElement(arg.$comment);
  return arg;
}

rpc.onNotification("documents/open", (params: { uri: string; languageId: string; version: number; text: string }) => {
  const existing = documentFor(params.uri);
  if (existing && !existing.isClosed) return;
  const document = new TextDocumentImpl(Uri.parse(params.uri), params.languageId, params.version, params.text);
  documents.set(params.uri, document);
  void activateByEvent(`onLanguage:${params.languageId}`);
  onDidOpen.fire(document);
});

rpc.onNotification("documents/change", (params: { uri: string; version: number; text: string }) => {
  const document = documentFor(params.uri);
  if (!document) return;
  // A virtual document the host already updated from its provider (see virtual.ts).
  if (params.text === document.getText()) {
    document.version = params.version;
    return;
  }
  const oldRange = new Range(document.positionAt(0), document.positionAt(document.getText().length));
  const oldLength = document.getText().length;
  document.setText(params.text, params.version);
  document.isDirty = true;
  // One whole-document change: simple, and what full-sync language clients expect.
  onDidChange.fire({
    document,
    contentChanges: [{ range: oldRange, rangeOffset: 0, rangeLength: oldLength, text: params.text }],
    reason: undefined,
  });
});

rpc.onNotification("documents/save", (params: { uri: string }) => {
  const document = documentFor(params.uri);
  if (!document) return;
  document.isDirty = false;
  onDidSave.fire(document);
});

rpc.onNotification("documents/close", (params: { uri: string }) => {
  const document = documentFor(params.uri);
  if (!document) return;
  document.isClosed = true;
  documents.delete(params.uri);
  onDidClose.fire(document);
});

rpc.onNotification("editor/active", (params: { uri: string | null; selection?: any; visible?: (string | null)[]; activeIndex?: number }) =>
  hostEvents.setActiveEditor(params),
);

rpc.onNotification("configuration/changed", (params: { settings: Record<string, unknown> }) => {
  const before = host.settings;
  host.settings = params.settings;
  const changed = new Set([...Object.keys(before), ...Object.keys(params.settings)].filter((k) => before[k] !== params.settings[k]));
  onDidChangeConfiguration.fire({
    affectsConfiguration: (section: string) =>
      [...changed].some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
  });
});

rpc.onNotification("theme/changed", (params: { kind: number }) => {
  if (params.kind === host.colorThemeKind) return;
  host.colorThemeKind = params.kind;
  onDidChangeColorTheme.fire({ kind: params.kind });
});

rpc.onRequest("shutdown", async () => {
  await Promise.all(deactivators.map((d) => Promise.resolve(d()).catch(() => {})));
  return true;
});

providers.listen();
views.listen();
debug.listen();
virtual.listen();
tabs.listen();
files.listen();
terminals.listen();
tasks.listen();
authentication.listen();
scm.listen();
testing.listen();
comments.listen();
chat.listen();
lm.listen();
rpc.listen();
rpc.notify("ready", { pid: process.pid, node: process.version });

// Keep the process alive and report crashes instead of dying silently.
process.on("uncaughtException", (e) => rpc.notify("log", { level: "error", message: `Uncaught: ${e.stack ?? e.message}` }));
process.on("unhandledRejection", (e: any) => rpc.notify("log", { level: "error", message: `Unhandled rejection: ${e?.stack ?? e}` }));
