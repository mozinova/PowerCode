//! Runs the extension host for the open workspace: starts it with the
//! installed extensions that have code, keeps its documents in sync with the
//! editor, and answers what it asks of the UI (see ext-host/src/api.ts).

import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { activeEditor } from "../components/EditorArea";
import { monaco } from "../editor/monaco";
import { isModelDirty, loadModel, modelPath, onDidSaveModel, saveModel } from "../editor/models";
import { useExtensions } from "../extensions/runtime";
import { errorMessage, fsApi, type InstalledExtension } from "../lib/ipc";
import { basename } from "../lib/paths";
import { remoteOf } from "../lib/remote";
import { parseDiffTab, parseWebviewTab, webviewTabPath } from "../lib/virtualTabs";
import { track } from "../state/activity";
import { ask, notify } from "../state/notifications";
import { openPaths, useWorkspace } from "../state/workspace";
import { closeTerminal, newTerminal, setActiveTerminal, type TerminalSession } from "../terminal/sessions";
import { cancelAllDialogs, showInputBox, showQuickPick } from "./dialogs";
import { pathFromUri, registerProvider, resetLanguageFeatures, setDiagnostics, setDocumentFlusher, unregisterProvider } from "./languages";
import * as rpc from "./rpc";
import { openUserSettings, userSettingsPath } from "./settings";
import { loadUserSettings, setUserSetting, useUserSettings } from "../settings/store";
import { openSettings } from "../actions";
import { appendOutput, log, useExtensionHost, type ContributedCommand, type StatusItem } from "./state";
import { contributions, registerViewHandlers, resetViews, setConfigurationContext } from "./views";
import { registerCustomEditorHandlers, resetCustomEditors } from "./customEditors";
import { syncToHost as syncBreakpointsToHost } from "../debug/breakpoints";
import { registerDebugHover } from "../debug/editor";
import { registerDebugHandlers, resetDebug } from "../debug/model";
import {
  disposeAllWebviews,
  disposeWebview,
  listenToWebviews,
  postToWebview,
  setWebviewHtml,
  setWebviewOptions,
  WEBVIEW_ORIGIN,
} from "./webviews";
import { resetContextKeys, setContextKey } from "./when";

const hasCode = (ext: InstalledExtension) => typeof ext.manifest.main === "string";

/** What the running host was started for; a change means a restart. */
let runningFor: string | null = null;

function wantedFor(): { key: string | null; extensions: InstalledExtension[]; root: string | null } {
  const root = useWorkspace.getState().root;
  const extensions = useExtensions.getState().installed.filter(hasCode);
  // Extensions run locally; an SSH workspace has no local files for them to read.
  if (extensions.length === 0 || remoteOf(root)?.kind === "ssh") return { key: null, extensions, root };
  const key = JSON.stringify([root, extensions.map((e) => `${e.id}@${e.manifest.version}`)]);
  return { key, extensions, root };
}

// ---- Lifecycle ------------------------------------------------------------------

/** Syncs run one after another, so a burst of changes never starts two hosts. */
let queue: Promise<void> = Promise.resolve();
let restartTimer: number | undefined;

/** Starts, restarts or stops the host so it matches the workspace and the installed extensions. */
function scheduleSync(delay = 400) {
  window.clearTimeout(restartTimer);
  restartTimer = window.setTimeout(() => void sync(false), delay);
}

function sync(force: boolean): Promise<void> {
  queue = queue.then(() => {
    const wanted = wantedFor();
    if (!force && wanted.key === runningFor && (wanted.key === null || rpc.isRunning())) return;
    return wanted.key === null ? stop() : start(wanted.key, wanted.extensions, wanted.root);
  }).catch((e) => log("error", `Extension host: ${errorMessage(e)}`));
  return queue;
}

export function restartExtensionHost() {
  return sync(true);
}

async function shutdownGracefully() {
  if (!rpc.isRunning()) return;
  // Extensions get a moment to run `deactivate`.
  await Promise.race([rpc.request("shutdown").catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
}

function forgetHostState() {
  resetLanguageFeatures();
  cancelAllDialogs();
  syncedDocuments.forEach((d) => d.dispose());
  syncedDocuments.clear();
  progressEnds.forEach((end) => end());
  progressEnds.clear();
  terminals.clear();
  useExtensionHost.setState({ statusItems: [], statusMessage: "", commands: [] });
  resetViews();
  resetCustomEditors();
  resetDebug();
  resetContextKeys();
  // Webview panels belong to the host that created them.
  panels.clear();
  closeWebviewTabs();
  disposeAllWebviews();
}

function closeWebviewTabs() {
  const { groups, closeTab } = useWorkspace.getState();
  for (const group of groups) {
    for (const tab of group.tabs) if (parseWebviewTab(tab.path)) closeTab(tab.path, group.id);
  }
}

async function stop() {
  await shutdownGracefully();
  await rpc.stopProcess();
  forgetHostState();
  runningFor = null;
  useExtensionHost.setState({ status: "stopped" });
}

async function start(key: string, extensions: InstalledExtension[], root: string | null) {
  await shutdownGracefully();
  forgetHostState();
  runningFor = key;
  useExtensionHost.setState({ status: "starting" });
  log("info", `Starting the extension host with ${extensions.map((e) => e.id).join(", ")}`);
  try {
    await track("Starting extensions…", async () => {
      await rpc.startProcess(onUnexpectedExit);
      const data = await appDataDir();
      const storageKey = root ? hashKey(root) : "empty";
      await loadUserSettings();
      const settings = useUserSettings.getState().values;
      lastSettings = JSON.stringify(settings);
      const result = await rpc.request<{ commands: ContributedCommand[]; defaults: Record<string, unknown> }>("initialize", {
        workspaceFolders: root ? [{ uri: monaco.Uri.file(root).toString(), name: basename(root) }] : [],
        extensions: extensions.map((e) => ({ id: e.id, path: e.path, manifest: e.manifest })),
        settings,
        languages: monaco.languages.getLanguages().map((l) => l.id),
        globalStoragePath: await join(data, "exthost", "global"),
        storagePath: await join(data, "exthost", "workspaces", storageKey),
        logPath: await join(data, "exthost", "logs"),
        webviewOrigin: WEBVIEW_ORIGIN,
      });
      setConfigurationContext(settings, result.defaults);
      useExtensionHost.setState({ commands: result.commands, status: "running" });
      for (const model of monaco.editor.getModels()) openDocument(model);
      sendActiveEditor();
      syncBreakpointsToHost();
      rpc.notify("start");
    });
  } catch (e) {
    runningFor = null;
    useExtensionHost.setState({ status: "crashed" });
    log("error", `Could not start the extension host: ${errorMessage(e)}`);
    notify("error", "Extensions could not start", errorMessage(e));
  }
}

/** A short stable name for a workspace's storage folder. */
function hashKey(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${basename(text).replace(/[^\w.-]/g, "_")}-${hash.toString(16)}`;
}

function onUnexpectedExit() {
  forgetHostState();
  runningFor = null;
  useExtensionHost.setState({ status: "crashed" });
  log("error", "The extension host terminated unexpectedly.");
  void ask("error", "The extension host terminated unexpectedly", "Extensions are not running.", ["Restart", "Show Output"]).then(
    (choice) => {
      if (choice === 0) void restartExtensionHost();
      if (choice === 1) showOutput("host");
    },
  );
}

// ---- Documents ----------------------------------------------------------------

/** Listeners and pending change of each document the host knows. */
const syncedDocuments = new Map<string, { dispose(): void; flush(): void }>();
const CHANGE_DELAY_MS = 120;

function openDocument(model: monaco.editor.ITextModel) {
  const uri = model.uri.toString();
  // Only files: diff originals and other virtual models stay out.
  if (!rpc.isRunning() || syncedDocuments.has(uri) || modelPath(model) === undefined) return;
  rpc.notify("documents/open", { uri, languageId: model.getLanguageId(), version: model.getVersionId(), text: model.getValue() });

  let timer: number | undefined;
  const flush = () => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
    rpc.notify("documents/change", { uri, version: model.getVersionId(), text: model.getValue() });
  };
  const listeners = [
    model.onDidChangeContent(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, CHANGE_DELAY_MS);
    }),
    model.onDidChangeLanguage(() => {
      // The host learns about a new language by reopening the document.
      closeDocument(uri);
      openDocument(model);
    }),
    model.onWillDispose(() => closeDocument(uri)),
  ];
  syncedDocuments.set(uri, {
    flush,
    dispose: () => {
      window.clearTimeout(timer);
      listeners.forEach((l) => l.dispose());
    },
  });
}

function closeDocument(uri: string) {
  const synced = syncedDocuments.get(uri);
  if (!synced) return;
  synced.flush();
  synced.dispose();
  syncedDocuments.delete(uri);
  rpc.notify("documents/close", { uri });
}

function sendActiveEditor() {
  const editor = activeEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  rpc.notify("editor/active", {
    uri: model && modelPath(model) !== undefined ? model.uri.toString() : null,
    selection: selection
      ? {
          start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
          end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
        }
      : undefined,
  });
}

// ---- Settings ---------------------------------------------------------------------

let lastSettings = "";

/** Tells extensions about the settings in the store, if they changed. */
function sendSettings(settings: Record<string, unknown> = useUserSettings.getState().values) {
  const json = JSON.stringify(settings);
  if (json === lastSettings) return;
  lastSettings = json;
  setConfigurationContext(settings);
  rpc.notify("configuration/changed", { settings });
}


// ---- Output, progress, terminals -------------------------------------------------------

export function showOutput(id?: string) {
  if (id) useExtensionHost.setState({ activeOutput: id });
  const { bottomTool, toggleBottomTool } = useWorkspace.getState();
  if (bottomTool !== "output") toggleBottomTool("output");
}

const progressEnds = new Map<number, () => void>();
const terminals = new Map<number, TerminalSession>();

function showTerminalPanel(session: TerminalSession) {
  setActiveTerminal(session);
  const { bottomTool, toggleBottomTool } = useWorkspace.getState();
  if (bottomTool !== "terminal") toggleBottomTool("terminal");
}

// ---- Edits ----------------------------------------------------------------------

interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const toMonacoRange = (r: RangeDto) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

async function applyWorkspaceEdit(params: {
  edits: { uri: string; edits: { range: RangeDto; newText: string }[] }[];
  operations: { kind: "create" | "delete" | "rename"; uri?: string; from?: string; to?: string }[];
}): Promise<boolean> {
  try {
    for (const op of params.operations ?? []) {
      if (op.kind === "create" && op.uri) await fsApi.createFile(pathFromUri(op.uri)).catch(() => {});
      else if (op.kind === "delete" && op.uri) await fsApi.deletePath(pathFromUri(op.uri));
      else if (op.kind === "rename" && op.from && op.to) {
        const from = pathFromUri(op.from);
        const to = pathFromUri(op.to);
        await fsApi.renamePath(from, to);
        useWorkspace.getState().renamePaths(from, to);
      }
    }
    const open = openPaths(useWorkspace.getState());
    for (const file of params.edits) {
      const path = pathFromUri(file.uri);
      const model = await loadModel(path);
      model.pushStackElement();
      model.pushEditOperations(
        [],
        file.edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
        () => null,
      );
      model.pushStackElement();
      // Files not open in a tab would keep their edits invisibly; they are saved right away.
      if (!open.has(path)) await saveModel(path);
    }
    useWorkspace.getState().filesChanged();
    return true;
  } catch (e) {
    log("error", `Applying an edit failed: ${errorMessage(e)}`);
    return false;
  }
}

async function saveAll() {
  const paths = [...openPaths(useWorkspace.getState())].map((p) => parseDiffTab(p) ?? p);
  await Promise.all(paths.filter(isModelDirty).map(saveModel));
  return true;
}

/** Built-in commands extensions commonly run with `commands.executeCommand`. */
async function executeBuiltin(command: string, args: any[]): Promise<unknown> {
  const uriArg = (a: any) => (a && typeof a.$uri === "string" ? pathFromUri(a.$uri) : undefined);
  switch (command) {
    case "setContext":
      if (typeof args[0] === "string") setContextKey(args[0], args[1]);
      return null;
    case "vscode.open":
    case "vscode.openWith": {
      const path = uriArg(args[0]);
      if (path) useWorkspace.getState().openFile(path);
      else if (typeof args[0]?.$uri === "string") await openUrl(args[0].$uri);
      return null;
    }
    case "workbench.action.files.save":
      if (useWorkspace.getState().activePath) await saveModel(useWorkspace.getState().activePath!);
      return null;
    case "workbench.action.files.saveAll":
      return saveAll();
    case "workbench.action.openSettings":
    case "workbench.action.openGlobalSettings":
      // Extensions pass a search, e.g. `@ext:publisher.name` or a setting id.
      openSettings(typeof args[0] === "string" ? args[0].replace(/^@ext:\S+\s*/, "") || args[0] : typeof args[0]?.query === "string" ? args[0].query : undefined);
      return null;
    case "workbench.action.openSettingsJson":
      return openUserSettings();
    case "workbench.action.reloadWindow":
      window.location.reload();
      return null;
    case "workbench.action.output.toggleOutput":
      showOutput();
      return null;
    case "workbench.action.terminal.new":
      showTerminalPanel(newTerminal(useWorkspace.getState().root));
      return null;
    case "workbench.view.extensions":
      useWorkspace.getState().showTool("extensions");
      return null;
    case "workbench.view.explorer":
      useWorkspace.getState().showTool("project");
      return null;
    case "workbench.view.scm":
      useWorkspace.getState().showTool("commit");
      return null;
  }
  // Editor actions (`editor.action.formatDocument`, ...) run on the focused editor.
  const editor = activeEditor();
  const action = editor?.getAction(command);
  if (action) {
    await action.run();
    return null;
  }
  if (editor && command.startsWith("editor.")) {
    editor.trigger("extension", command, args[0]);
    return null;
  }
  throw new Error(`command '${command}' not found`);
}

// ---- Messages from the host ------------------------------------------------------------

const SEVERITY_KINDS = { info: "info", warning: "info", error: "error" } as const;

function revive(r?: { source: string; flags?: string }) {
  if (!r) return undefined;
  try {
    return new RegExp(r.source, r.flags);
  } catch {
    return undefined;
  }
}

/** Shows the tool window of the container holding `viewId`. */
function showView(viewId: string) {
  const container = contributions().containers.find((c) => c.views.some((v) => v.id === viewId));
  if (container) useWorkspace.getState().showTool(container.tool);
}

/** Webview panels the host has open, by id, with their tab title and icon; closing their last tab disposes them. */
const panels = new Map<string, { title: string; icon?: string }>();

function revealPanel(id: string) {
  const panel = panels.get(id);
  if (panel) useWorkspace.getState().openFile(webviewTabPath(id), panel.title, panel.icon);
}

function forgetPanel(id: string) {
  panels.delete(id);
  disposeWebview(id);
}

function iconUrl(icon: { uri: string } | { themeIcon: string } | undefined): string | undefined {
  if (!icon || !("uri" in icon)) return undefined;
  return icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
}

function registerWebviewHandlers() {
  rpc.onNotification("webview/html", ({ id, html, extension }) => setWebviewHtml(id, html, extension));
  rpc.onNotification("webview/options", ({ id, options }) => setWebviewOptions(id, options));
  rpc.onNotification("webview/postMessage", ({ id, message }) => postToWebview(id, message));
  rpc.onNotification("webview/createPanel", ({ id, title }) => {
    panels.set(id, { title });
    revealPanel(id);
  });
  rpc.onNotification("webview/title", ({ id, title }) => {
    const panel = panels.get(id);
    if (panel) panel.title = title;
    useWorkspace.setState((s) => ({
      groups: s.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => (t.path === webviewTabPath(id) ? { ...t, name: title } : t)) })),
      tabs: s.tabs.map((t) => (t.path === webviewTabPath(id) ? { ...t, name: title } : t)),
    }));
  });
  rpc.onNotification("webview/icon", ({ id, icon }) => {
    const url = iconUrl(icon);
    const panel = panels.get(id);
    if (panel) panel.icon = url;
    if (url) useWorkspace.getState().setTabIcon(webviewTabPath(id), url);
  });
  rpc.onNotification("webview/reveal", ({ id }) => revealPanel(id));
  rpc.onNotification("webview/dispose", ({ id }) => {
    // Forgotten first, so closing its tabs does not report it back as disposed by the user.
    forgetPanel(id);
    const { groups, closeTab } = useWorkspace.getState();
    for (const group of groups) if (group.tabs.some((t) => t.path === webviewTabPath(id))) closeTab(webviewTabPath(id), group.id);
  });

  // A panel whose last tab closed is disposed; switching tabs reports its view state.
  useWorkspace.subscribe((s, previous) => {
    if (s.groups === previous.groups && s.activePath === previous.activePath) return;
    const open = openPaths(s);
    for (const id of [...panels.keys()]) {
      if (open.has(webviewTabPath(id))) {
        const active = s.activePath === webviewTabPath(id);
        const visible = s.groups.some((g) => g.activePath === webviewTabPath(id));
        rpc.notify("webview/viewState", { id, active, visible });
        continue;
      }
      forgetPanel(id);
      rpc.notify("webview/disposed", { id });
    }
  });
}

function registerHandlers() {
  registerWebviewHandlers();
  registerDebugHandlers();
  registerCustomEditorHandlers();
  registerViewHandlers(showView, (id) => disposeWebview(id));
  rpc.onNotification("log", ({ level, message }) => log(level, message));
  rpc.onNotification("ready", ({ node }) => log("info", `Extension host ready (Node ${node})`));
  rpc.onNotification("providers/register", registerProvider);
  rpc.onNotification("providers/unregister", ({ handle }) => unregisterProvider(handle));
  rpc.onNotification("diagnostics/set", ({ owner, uri, diagnostics }) => setDiagnostics(owner, uri, diagnostics));

  rpc.onNotification("statusBar/update", (item: StatusItem & { visible: boolean }) =>
    useExtensionHost.setState(({ statusItems }) => {
      const others = statusItems.filter((i) => i.id !== item.id);
      if (!item.visible || !item.text) return { statusItems: others };
      const { visible: _visible, ...rest } = item;
      return { statusItems: [...others, rest] };
    }),
  );
  rpc.onNotification("statusBar/dispose", ({ id }) =>
    useExtensionHost.setState(({ statusItems }) => ({ statusItems: statusItems.filter((i) => i.id !== id) })),
  );
  rpc.onNotification("statusBar/message", ({ text }) => useExtensionHost.setState({ statusMessage: text ?? "" }));

  rpc.onNotification("output/create", ({ id, name }) =>
    useExtensionHost.setState(({ outputs }) =>
      outputs.some((o) => o.id === id) ? {} : { outputs: [...outputs, { id, name, text: "" }] },
    ),
  );
  rpc.onNotification("output/append", ({ id, text }) => appendOutput(id, text));
  rpc.onNotification("output/clear", ({ id }) =>
    useExtensionHost.setState(({ outputs }) => ({ outputs: outputs.map((o) => (o.id === id ? { ...o, text: "" } : o)) })),
  );
  rpc.onNotification("output/show", ({ id }) => showOutput(id));
  rpc.onNotification("output/dispose", ({ id }) =>
    useExtensionHost.setState(({ outputs, activeOutput }) => ({
      outputs: outputs.filter((o) => o.id !== id),
      activeOutput: activeOutput === id ? "host" : activeOutput,
    })),
  );

  rpc.onNotification("progress/start", ({ id, title }) => {
    void track(title || "Working…", () => new Promise<void>((resolve) => progressEnds.set(id, resolve)));
  });
  rpc.onNotification("progress/report", () => {});
  rpc.onNotification("progress/end", ({ id }) => {
    progressEnds.get(id)?.();
    progressEnds.delete(id);
  });

  rpc.onNotification("terminal/create", ({ id, name, cwd }) => {
    terminals.set(id, newTerminal(cwd ? pathFromUri(cwd) : useWorkspace.getState().root, undefined, name));
  });
  rpc.onNotification("terminal/sendText", ({ id, text }) => terminals.get(id)?.sendText(text));
  rpc.onNotification("terminal/show", ({ id }) => {
    const session = terminals.get(id);
    if (session) showTerminalPanel(session);
  });
  rpc.onNotification("terminal/dispose", ({ id }) => {
    const session = terminals.get(id);
    if (session) closeTerminal(session);
    terminals.delete(id);
  });

  rpc.onNotification("languages/configuration", ({ language, configuration }) => {
    monaco.languages.setLanguageConfiguration(language, {
      comments: configuration.comments,
      brackets: configuration.brackets,
      wordPattern: revive(configuration.wordPattern),
      indentationRules: configuration.indentationRules && {
        increaseIndentPattern: revive(configuration.indentationRules.increaseIndentPattern) ?? /^$/,
        decreaseIndentPattern: revive(configuration.indentationRules.decreaseIndentPattern) ?? /^$/,
      },
    });
  });

  rpc.onNotification("extensions/activated", ({ id }) => log("info", `Activated ${id}`));
  rpc.onNotification("extensions/activationFailed", ({ id, name, message }) => {
    log("error", `Activating ${id} failed: ${message}`);
    void ask("error", `${name} failed to activate`, message.split("\n")[0], ["Show Output"]).then((choice) => {
      if (choice === 0) showOutput("host");
    });
  });

  rpc.onRequest("window/showMessage", async ({ severity, message, detail, items }) => {
    const kind = SEVERITY_KINDS[severity as keyof typeof SEVERITY_KINDS] ?? "info";
    if (!items?.length) {
      notify(kind, message, detail);
      return null;
    }
    return ask(kind, message, detail, items);
  });
  rpc.onRequest("window/showQuickPick", (params) => showQuickPick(params));
  rpc.onRequest("window/showInputBox", (params) => showInputBox(params));
  rpc.onRequest("window/showTextDocument", async ({ uri, selection }) => {
    const path = pathFromUri(uri);
    await loadModel(path);
    reveal(path, selection);
    return null;
  });
  rpc.onRequest("window/showOpenDialog", async ({ canSelectFolders, canSelectMany, title }) => {
    const picked = await openDialog({ directory: canSelectFolders, multiple: canSelectMany, title });
    if (picked === null) return null;
    return Array.isArray(picked) ? picked : [picked];
  });
  rpc.onRequest("window/showSaveDialog", ({ title }) => saveDialog({ title }));
  rpc.onRequest("editor/reveal", ({ uri, range }) => {
    reveal(pathFromUri(uri), range);
    return null;
  });
  rpc.onRequest("editor/insertSnippet", ({ uri, range, snippet }) => {
    const editor = activeEditor();
    if (!editor || editor.getModel()?.uri.toString() !== uri) return false;
    editor.setSelection(toMonacoRange(range));
    (editor.getContribution("snippetController2") as any)?.insert(snippet);
    return true;
  });

  rpc.onRequest("workspace/applyEdit", applyWorkspaceEdit);
  rpc.onRequest("workspace/saveAll", saveAll);
  rpc.onRequest("commands/executeBuiltin", ({ command, args }) => executeBuiltin(command, args ?? []));
  rpc.onRequest("configuration/update", async ({ key, value }) => {
    await setUserSetting(key, value);
    return null;
  });
  rpc.onRequest("languages/detect", ({ uri }) => detectLanguage(pathFromUri(uri)));

  rpc.onRequest("env/clipboardRead", () => navigator.clipboard.readText());
  rpc.onRequest("env/clipboardWrite", async ({ text }) => {
    await navigator.clipboard.writeText(text);
    return null;
  });
  rpc.onRequest("env/openExternal", async ({ uri }) => {
    await openUrl(uri);
    return true;
  });
}

function reveal(path: string, range?: RangeDto) {
  const { openFile, openFileAt } = useWorkspace.getState();
  if (!range) return openFile(path);
  openFileAt(path, range.start.line + 1, range.start.character + 1, range.end.character + 1, range.end.line + 1);
}

function detectLanguage(path: string): string {
  const model = monaco.editor.getModel(monaco.Uri.file(path));
  if (model) return model.getLanguageId();
  const name = basename(path).toLowerCase();
  const language = monaco.languages
    .getLanguages()
    .find(
      (l) =>
        l.filenames?.some((f) => f.toLowerCase() === name) ||
        l.extensions?.some((e) => name.endsWith(e.toLowerCase())),
    );
  return language?.id ?? "plaintext";
}

// ---- Startup ---------------------------------------------------------------------

let initialized = false;

/** Keeps the extension host in step with the workspace and the installed extensions. */
export function startExtensionHost() {
  if (initialized) return;
  initialized = true;
  registerHandlers();
  registerDebugHover();
  useUserSettings.subscribe((state, previous) => {
    if (state.values !== previous.values && rpc.isRunning()) sendSettings(state.values);
  });
  listenToWebviews();
  setDocumentFlusher((uri) => syncedDocuments.get(uri)?.flush());

  // New models (opened files) are announced once `models.ts` has recorded their path.
  monaco.editor.onDidCreateModel((model) => queueMicrotask(() => openDocument(model)));
  onDidSaveModel(async (path, model) => {
    const uri = model.uri.toString();
    syncedDocuments.get(uri)?.flush();
    if (rpc.isRunning() && syncedDocuments.has(uri)) rpc.notify("documents/save", { uri });
    // Edits saved in settings.json reach the store (and from it, extensions and the editor).
    if (path === (await userSettingsPath())) void loadUserSettings();
  });

  // The active editor: tab switches, group focus and cursor moves (debounced).
  let activeTimer: number | undefined;
  const activeChanged = () => {
    window.clearTimeout(activeTimer);
    activeTimer = window.setTimeout(() => rpc.isRunning() && sendActiveEditor(), 150);
  };
  useWorkspace.subscribe((s, previous) => {
    if (s.activePath !== previous.activePath || s.activeGroup !== previous.activeGroup || s.cursor !== previous.cursor) {
      activeChanged();
    }
    if (s.root !== previous.root) scheduleSync();
  });
  // Installing, updating or uninstalling an extension with code restarts the host.
  useExtensions.subscribe((s, previous) => {
    if (s.installed !== previous.installed) scheduleSync();
  });
  scheduleSync(0);
}
