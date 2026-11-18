//! Runs the extension host for the open workspace: starts it with the
//! installed extensions that have code, keeps its documents in sync with the
//! editor, and answers what it asks of the UI (see ext-host/src/api.ts).

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { activeEditor } from "../components/EditorArea";
import { monaco } from "../editor/monaco";
import { fileUri } from "../editor/uris";
import { isModelDirty, loadModel, modelPath, onDidSaveModel, saveModel } from "../editor/models";
import { useExtensions } from "../extensions/runtime";
import { activeThemeKind } from "../editor/themes";
import { errorMessage, fsApi, type InstalledExtension } from "../lib/ipc";
import { basename } from "../lib/paths";
import { remoteLabel, remoteOf } from "../lib/remote";
import { createTranslator, type RemoteMapping } from "./remoteUris";
import {
  compareTabPath,
  documentTabPath,
  parseCommitDiffTab,
  parseCompareTab,
  parseCustomEditorTab,
  parseDiffTab,
  parseDocumentTab,
  parseWebviewTab,
  isVirtualTab,
  webviewTabPath,
} from "../lib/virtualTabs";
import {
  isVirtualModel,
  isVirtualScheme,
  onDidSaveVirtual,
  registerVirtualDocumentHandlers,
  resetVirtualDocuments,
} from "./virtualDocuments";
import { track } from "../state/activity";
import { ask, notify } from "../state/notifications";
import { useTrust } from "../state/trust";
import { openPaths, useWorkspace } from "../state/workspace";
import { closeTerminal, newTerminal, setActiveTerminal, type TerminalSession } from "../terminal/sessions";
import { cancelAllDialogs, showInputBox, showQuickPick } from "./dialogs";
import { pathFromUri, registerProvider, resetLanguageFeatures, setDiagnostics, setDocumentFlusher, unregisterProvider } from "./languages";
import * as rpc from "./rpc";
import { openUserSettings, userSettingsPath } from "./settings";
import { loadUserSettings, setUserSetting, useUserSettings } from "../settings/store";
import { closeTabs, openSettings } from "../actions";
import { appendOutput, log, useExtensionHost, type ContributedCommand, type StatusItem } from "./state";
import { contributions, registerViewHandlers, resetViews, setConfigurationContext } from "./views";
import { registerCustomEditorHandlers, resetCustomEditors } from "./customEditors";
import { registerDecorationHandlers, resetDecorations } from "./decorations";
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

/** Extensions that declare they work in Restricted Mode (`capabilities.untrustedWorkspaces`). */
const supportsRestrictedMode = (ext: InstalledExtension) => {
  const supported = (ext.manifest as { capabilities?: { untrustedWorkspaces?: { supported?: unknown } } }).capabilities?.untrustedWorkspaces?.supported;
  return supported === true || supported === "limited";
};

function wantedFor(): { key: string | null; extensions: InstalledExtension[]; root: string | null; trusted: boolean } {
  const root = useWorkspace.getState().root;
  const trust = useTrust.getState().state;
  // While the trust question is open nothing starts; in Restricted Mode only the
  // extensions that support it run, as in VS Code.
  const trusted = trust === "trusted";
  const extensions = useExtensions.getState().installed.filter((e) => hasCode(e) && (trusted || supportsRestrictedMode(e)));
  // In SSH and WSL workspaces the host runs on the remote (see `start`).
  if (extensions.length === 0 || trust === "pending") return { key: null, extensions, root, trusted };
  const key = JSON.stringify([root, trusted, extensions.map((e) => `${e.id}@${e.manifest.version}`)]);
  return { key, extensions, root, trusted };
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
    return wanted.key === null ? stop() : start(wanted.key, wanted.extensions, wanted.root, wanted.trusted);
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
  lastTabs = "";
  progressEnds.forEach((end) => end());
  progressEnds.clear();
  terminals.clear();
  useExtensionHost.setState({ statusItems: [], statusMessage: "", commands: [] });
  resetViews();
  resetDecorations();
  resetVirtualDocuments();
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

async function start(key: string, extensions: InstalledExtension[], root: string | null, trusted: boolean) {
  await shutdownGracefully();
  forgetHostState();
  runningFor = key;
  useExtensionHost.setState({ status: "starting" });
  const remote = remoteOf(root);
  const where = remote ? ` on ${remoteLabel(remote)}` : "";
  log("info", `Starting the extension host${where} with ${extensions.map((e) => e.id).join(", ")}`);
  try {
    await track(`Starting extensions${where}…`, async () => {
      const storageKey = root ? hashKey(root) : "empty";
      // Where the host runs decides the paths it gets: local folders, or the remote's.
      let location: { extensionPath: (e: InstalledExtension) => string; globalStorage: string; storage: string; logs: string };
      let launch: rpc.RemoteLaunch | undefined;
      let mapping: RemoteMapping | undefined;
      if (remote) {
        mapping = remote.kind === "ssh" ? { kind: "ssh", host: remote.host } : { kind: "wsl", distro: remote.distro };
        const prepared = await prepareRemote(mapping, extensions);
        launch = { target: mapping, node: prepared.node, script: prepared.script };
        const skipped = new Set(prepared.skipped.map((s) => s.split(/[: ]/)[0]));
        extensions = extensions.filter((e) => !skipped.has(e.id));
        location = {
          extensionPath: (e) => `${prepared.extensionsDir}/${e.id}`,
          globalStorage: `${prepared.dataDir}/global`,
          storage: `${prepared.dataDir}/workspaces/${storageKey}`,
          logs: `${prepared.dataDir}/logs`,
        };
      } else {
        const data = await appDataDir();
        location = {
          extensionPath: (e) => e.path,
          globalStorage: await join(data, "exthost", "global"),
          storage: await join(data, "exthost", "workspaces", storageKey),
          logs: await join(data, "exthost", "logs"),
        };
      }
      await rpc.startProcess(onUnexpectedExit, launch, mapping && createTranslator(mapping));
      await loadUserSettings();
      const settings = useUserSettings.getState().values;
      lastSettings = JSON.stringify(settings);
      const result = await rpc.request<{ commands: ContributedCommand[]; defaults: Record<string, unknown> }>("initialize", {
        workspaceFolders: root ? [{ uri: fileUri(root).toString(), name: basename(root) }] : [],
        extensions: extensions.map((e) => ({ id: e.id, path: location.extensionPath(e), manifest: e.manifest })),
        settings,
        languages: monaco.languages.getLanguages().map((l) => l.id),
        globalStoragePath: location.globalStorage,
        storagePath: location.storage,
        logPath: location.logs,
        webviewOrigin: WEBVIEW_ORIGIN,
        colorThemeKind: activeThemeKind(),
        remote: mapping ?? null,
        // `workspace.isTrusted`.
        trusted,
        // A remote host maps its extensions' media (webviews, icons) to these local copies.
        localExtensionPaths: Object.fromEntries(extensions.map((e) => [e.id, e.path])),
      });
      setConfigurationContext(settings, result.defaults);
      useExtensionHost.setState({ commands: result.commands, status: "running" });
      for (const model of monaco.editor.getModels()) openDocument(model);
      sendTabs();
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

interface PreparedRemote {
  node: string;
  script: string;
  home: string;
  extensionsDir: string;
  dataDir: string;
  skipped: string[];
}

/** Installs Node.js, the host and the extensions on the remote as needed; shows each step. */
async function prepareRemote(target: RemoteMapping, extensions: InstalledExtension[]): Promise<PreparedRemote> {
  const steps = new Channel<string>();
  // Each step shows in the status bar until the next one starts.
  const step: { finish?: () => void } = {};
  steps.onmessage = (text) => {
    step.finish?.();
    log("info", text);
    void track(text, () => new Promise<void>((resolve) => (step.finish = resolve)));
  };
  try {
    const prepared = await invoke<PreparedRemote>("remote_exthost_prepare", {
      target,
      extensions: extensions.map((e) => ({ id: e.id, path: e.path, publisher: e.manifest.publisher, name: e.manifest.name, version: e.manifest.version })),
      onProgress: steps,
    });
    for (const reason of prepared.skipped) log("warning", `Not available on the remote: ${reason}`);
    if (prepared.skipped.length > 0) {
      notify("info", "Some extensions do not run on this remote", prepared.skipped.join("\n"));
    }
    return prepared;
  } finally {
    step.finish?.();
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
  // Files and extensions' documents: diff originals and other internal models stay out.
  if (!rpc.isRunning() || syncedDocuments.has(uri) || (modelPath(model) === undefined && !isVirtualModel(model))) return;
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
    uri: model && (modelPath(model) !== undefined || isVirtualModel(model)) ? model.uri.toString() : null,
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
      const uri = typeof args[0]?.$uri === "string" ? (args[0].$uri as string) : undefined;
      if (uri && isVirtualScheme(monaco.Uri.parse(uri).scheme)) revealUri(uri);
      else if (uri && /^(file|ssh):/.test(uri)) useWorkspace.getState().openFile(uriArg(args[0])!);
      else if (uri) await openUrl(uri);
      return null;
    }
    case "vscode.diff": {
      // (left, right, title?, options?): files or extension documents, side by side.
      const [left, right, title] = args;
      if (typeof left?.$uri !== "string" || typeof right?.$uri !== "string") throw new Error("vscode.diff needs two URIs");
      const name = typeof title === "string" && title ? title : `${uriFileName(left.$uri)} ↔ ${uriFileName(right.$uri)}`;
      useWorkspace.getState().openFile(compareTabPath(left.$uri, right.$uri), name);
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
const panels = new Map<string, { title: string; icon?: string; viewType?: string }>();

function revealPanel(id: string) {
  const panel = panels.get(id);
  if (panel) useWorkspace.getState().openFile(webviewTabPath(id), panel.title, panel.icon);
}

function forgetPanel(id: string) {
  panels.delete(id);
  disposeWebview(id);
}

function iconUrl(icon: { uri: string } | { localPath: string } | { themeIcon: string } | undefined): string | undefined {
  if (icon && "localPath" in icon) return convertFileSrc(icon.localPath);
  if (!icon || !("uri" in icon)) return undefined;
  return icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
}

function registerWebviewHandlers() {
  rpc.onNotification("webview/html", ({ id, html, extension }) => setWebviewHtml(id, html, extension));
  rpc.onNotification("webview/options", ({ id, options }) => setWebviewOptions(id, options));
  rpc.onNotification("webview/postMessage", ({ id, message }) => postToWebview(id, message));
  rpc.onNotification("webview/createPanel", ({ id, title, viewType }) => {
    panels.set(id, { title, viewType });
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

// ---- Tabs (`window.tabGroups`) -----------------------------------------------------

/** What a tab shows, as `TabInputText`, `TabInputTextDiff`, ... */
function tabInput(path: string) {
  const webview = parseWebviewTab(path);
  if (webview) return { kind: "webview", viewType: panels.get(webview)?.viewType ?? webview };
  const custom = parseCustomEditorTab(path);
  if (custom) return { kind: "custom", uri: fileUri(custom.path).toString(), viewType: custom.viewType };
  const compare = parseCompareTab(path);
  if (compare) return { kind: "diff", original: compare.original, modified: compare.modified };
  const diff = parseDiffTab(path) ?? parseCommitDiffTab(path)?.file;
  if (diff) {
    const file = fileUri(diff);
    // The committed side as VS Code's git extension names it.
    const original = file.with({ scheme: "git", query: JSON.stringify({ path: file.fsPath, ref: parseCommitDiffTab(path)?.hash ?? "HEAD" }) });
    return { kind: "diff", original: original.toString(), modified: file.toString() };
  }
  const document = parseDocumentTab(path);
  if (document) return { kind: "text", uri: document };
  if (isVirtualTab(path)) return { kind: "other" };
  return { kind: "text", uri: fileUri(path).toString() };
}

let lastTabs = "";

/** Tells the host about the editor groups and their tabs, if they changed. */
function sendTabs(state = useWorkspace.getState()) {
  if (!rpc.isRunning()) return;
  const groups = state.groups.map((g) => ({
    id: g.id,
    isActive: g.id === state.activeGroup,
    tabs: g.tabs.map((t) => ({ id: t.path, label: t.name, isActive: t.path === g.activePath, isDirty: t.dirty, input: tabInput(t.path) })),
  }));
  const json = JSON.stringify(groups);
  if (json === lastTabs) return;
  lastTabs = json;
  rpc.notify("tabs/changed", { groups });
}

/** `TabGroups.close`: tabs by group, asking about unsaved edits as the user closing them would. */
async function closeHostTabs({ tabs }: { tabs: { group: number; id: string }[] }) {
  const byGroup = new Map<number, string[]>();
  for (const tab of tabs ?? []) byGroup.set(tab.group, [...(byGroup.get(tab.group) ?? []), tab.id]);
  for (const [group, paths] of byGroup) await closeTabs(paths, group);
  return true;
}

function registerHandlers() {
  registerWebviewHandlers();
  registerDecorationHandlers(rpc.onNotification);
  registerVirtualDocumentHandlers(rpc.onNotification);
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
    if (isVirtualScheme(monaco.Uri.parse(uri).scheme)) {
      revealUri(uri, selection);
      return null;
    }
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
    if (isVirtualScheme(monaco.Uri.parse(uri).scheme)) revealUri(uri, range);
    else reveal(pathFromUri(uri), range);
    return null;
  });
  rpc.onRequest("editor/insertSnippet", ({ uri, range, snippet }) => {
    const editor = activeEditor();
    if (!editor || editor.getModel()?.uri.toString() !== uri) return false;
    editor.setSelection(toMonacoRange(range));
    (editor.getContribution("snippetController2") as any)?.insert(snippet);
    return true;
  });

  rpc.onRequest("tabs/close", closeHostTabs);
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

/** The file name in a URI's path, for tab titles. */
function uriFileName(uri: string) {
  const parsed = monaco.Uri.parse(uri);
  return parsed.path.split("/").pop() || uri;
}

/** Shows a document an extension provides in its own tab (named after the URI's file name). */
function revealUri(uri: string, range?: RangeDto) {
  // The model's spelling of the URI, so the tab and the model agree (see virtualDocuments.ts).
  const path = documentTabPath(monaco.Uri.parse(uri).toString());
  useWorkspace.getState().openFile(path, uriFileName(uri));
  if (range) reveal(path, range);
}

function detectLanguage(path: string): string {
  const model = monaco.editor.getModel(fileUri(path));
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
  onDidSaveVirtual((uri) => {
    syncedDocuments.get(uri)?.flush();
    if (rpc.isRunning() && syncedDocuments.has(uri)) rpc.notify("documents/save", { uri });
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
    // Right away: extensions wait for the tab a command just opened (e.g. Claude Code's diffs).
    if (s.groups !== previous.groups || s.activeGroup !== previous.activeGroup) sendTabs(s);
    if (s.root !== previous.root) scheduleSync();
  });
  // Installing, updating or uninstalling an extension with code restarts the host.
  // Trusting the folder (or not) changes which extensions run.
  useTrust.subscribe((s, previous) => {
    if (s.state !== previous.state) scheduleSync(0);
  });
  useExtensions.subscribe((s, previous) => {
    if (s.installed !== previous.installed) scheduleSync();
    // `window.activeColorTheme` follows the editor theme.
    if (s.activeThemeId !== previous.activeThemeId && rpc.isRunning()) rpc.notify("theme/changed", { kind: activeThemeKind() });
  });
  scheduleSync(0);
}
