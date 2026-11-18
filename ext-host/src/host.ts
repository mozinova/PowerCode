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
import { collectDefaults, host, onDidChangeConfiguration, type ExtensionDescription } from "./state";
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

function context(extension: ExtensionDescription, subscriptions: { dispose(): unknown }[]) {
  const globalStorage = path.join(host.globalStoragePath, extension.id);
  const workspaceStorage = path.join(host.storagePath, extension.id);
  const secrets = new Map<string, string>();
  const secretChanges = new EventEmitter<{ key: string }>();
  return {
    subscriptions,
    extensionPath: extension.path,
    extensionUri: Uri.file(extension.path),
    extensionMode: ExtensionMode.Production,
    extension: (createApi(extension) as any).extensions.getExtension(extension.id),
    globalState: memento(path.join(globalStorage, "state.json")),
    workspaceState: memento(path.join(workspaceStorage, "state.json")),
    // Kept in memory only for now: secrets are not written to disk unencrypted.
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
        secretChanges.fire({ key });
      },
      delete: async (key: string) => {
        secrets.delete(key);
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
  await Promise.all(
    runnable()
      .filter((e) => activationEvents(e).some((a) => a === event || a === "*"))
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

/** Arguments from the UI: `{ $uri }` objects become Uris again, `{ $treeItem }` the tree element. */
function revive(arg: any): unknown {
  if (arg && typeof arg === "object" && typeof arg.$uri === "string") return Uri.parse(arg.$uri);
  if (arg && typeof arg === "object" && arg.$treeItem) return views.treeElement(arg.$treeItem);
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

rpc.onNotification("editor/active", (params: { uri: string | null; selection?: any }) => hostEvents.setActiveEditor(params));

rpc.onNotification("configuration/changed", (params: { settings: Record<string, unknown> }) => {
  const before = host.settings;
  host.settings = params.settings;
  const changed = new Set([...Object.keys(before), ...Object.keys(params.settings)].filter((k) => before[k] !== params.settings[k]));
  onDidChangeConfiguration.fire({
    affectsConfiguration: (section: string) =>
      [...changed].some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
  });
});

rpc.onRequest("shutdown", async () => {
  await Promise.all(deactivators.map((d) => Promise.resolve(d()).catch(() => {})));
  return true;
});

providers.listen();
views.listen();
rpc.listen();
rpc.notify("ready", { pid: process.pid, node: process.version });

// Keep the process alive and report crashes instead of dying silently.
process.on("uncaughtException", (e) => rpc.notify("log", { level: "error", message: `Uncaught: ${e.stack ?? e.message}` }));
process.on("unhandledRejection", (e: any) => rpc.notify("log", { level: "error", message: `Unhandled rejection: ${e?.stack ?? e}` }));
