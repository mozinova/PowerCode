import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { disposeAllModels, disposeModel, moveModel, saveModel } from "./editor/models";
import { errorMessage, fsApi, remoteApi } from "./lib/ipc";
import { basename, isWithin, movedPath } from "./lib/paths";
import { remoteLabel, remoteOf } from "./lib/remote";
import {
  SETTINGS_TAB,
  customEditorTabPath,
  extensionTabPath,
  parseCompareTab,
  parseCustomEditorTab,
  parseDiffTab,
  parseDocumentTab,
  tabFilePath,
} from "./lib/virtualTabs";
import { releaseDocumentModels, saveDocument } from "./exthost/virtualDocuments";
import { runFileOperation } from "./lib/fileOperations";
import { useSettingsPage } from "./settings/page";
import { installVsixFiles } from "./extensions/runtime";
import { customEditorsFor, defaultTabFor, saveCustomEditorTab } from "./exthost/customEditors";
import { showQuickPick } from "./exthost/dialogs";
import { refreshGit } from "./git/store";
import { saveIfDirty } from "./editor/autosave";
import { pickRemoteFolder } from "./state/folderPicker";
import { enterFolder } from "./state/trust";
import { useSettings } from "./state/settings";
import { notify } from "./state/notifications";
import { openPaths, useWorkspace } from "./state/workspace";
import { closeAllTerminals, newTerminal } from "./terminal/sessions";

const LAST_ROOT_KEY = "powercode.lastRoot";

export function lastRoot(): string | null {
  try {
    return localStorage.getItem(LAST_ROOT_KEY);
  } catch {
    return null;
  }
}

async function confirmDiscard(names: string[]): Promise<boolean> {
  if (names.length === 0) return true;
  const list = names.map((n) => `• ${n}`).join("\n");
  return ask(`There are unsaved changes in:\n${list}\n\nDiscard the changes?`, {
    title: "PowerCode",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}

/**
 * Opens `path`, or asks for a folder: on the remote host or distribution when
 * the current folder is remote (as VS Code does), otherwise with the native dialog.
 */
export async function openFolder(path?: string) {
  if (!path) {
    const current = useWorkspace.getState().root;
    const remote = remoteOf(current);
    if (remote && current) return pickRemoteFolder(remote, current);
    return openLocalFolder();
  }
  const root = path;

  const dirty = useWorkspace.getState().tabs.filter((t) => t.dirty);
  if (!(await confirmDiscard(dirty.map((t) => t.name)))) return;

  const previous = useWorkspace.getState().root;
  disposeAllModels();
  closeAllTerminals();
  // Trust first: nothing may run in the folder before the user decides (see state/trust.ts).
  enterFolder(root);
  useWorkspace.getState().openFolder(root);
  endSshSession(previous, root);
  try {
    localStorage.setItem(LAST_ROOT_KEY, root);
  } catch {
    // Not remembering the folder is harmless.
  }
}

/** Asks for a folder on this machine with the native dialog and opens it. */
export async function openLocalFolder() {
  const chosen = await open({ directory: true, multiple: false, title: "Open Folder" });
  if (chosen) await openFolder(chosen);
}

/** Ends the SSH session of `previous` unless `next` is on the same host. */
function endSshSession(previous: string | null, next: string | null) {
  const before = remoteOf(previous);
  const after = remoteOf(next);
  if (before?.kind === "ssh" && !(after?.kind === "ssh" && after.host === before.host)) {
    void remoteApi.disconnect(before.host);
  }
}

/** Closes the open folder, its tabs and terminals; returns false if the user kept unsaved changes. */
export async function closeFolder(): Promise<boolean> {
  const { root, tabs } = useWorkspace.getState();
  if (!root) return true;
  if (!(await confirmDiscard(tabs.filter((t) => t.dirty).map((t) => t.name)))) return false;
  disposeAllModels();
  closeAllTerminals();
  enterFolder(null);
  useWorkspace.getState().closeFolder();
  endSshSession(root, null);
  try {
    localStorage.removeItem(LAST_ROOT_KEY);
  } catch {
    // Reopening it next time is harmless.
  }
  return true;
}

/** VS Code's "Close Remote Connection": leaves the remote folder and ends its session. */
export async function closeRemoteConnection() {
  const remote = remoteOf(useWorkspace.getState().root);
  if (remote && (await closeFolder())) notify("info", `Disconnected from ${remoteLabel(remote)}`);
}

export async function saveActive() {
  const active = useWorkspace.getState().activePath;
  if (!active) return;
  // A diff tab saves the file it compares (when it is open with edits).
  const path = parseDiffTab(active) ?? active;
  // Extension documents and `vscode.diff` tabs (their modified side) save by URI.
  const document = parseDocumentTab(active) ?? parseCompareTab(active)?.modified;
  try {
    if (parseCustomEditorTab(active)) await saveCustomEditorTab(active);
    else if (document) await saveDocument(document);
    else await saveModel(path);
    void refreshGit();
  } catch (e) {
    await message(`Could not save the file:\n${errorMessage(e)}`, {
      title: "PowerCode",
      kind: "error",
    });
  }
}

export function closeTab(path: string, group?: number) {
  return closeTabs([path], group);
}

/** Disposes the models of `paths` that no editor group shows any more. */
function releaseModels(paths: string[]) {
  const stillOpen = openPaths(useWorkspace.getState());
  for (const path of paths) if (!stillOpen.has(path)) disposeModel(path);
  releaseDocumentModels();
}

/**
 * Closes several tabs of `group` (the active group by default). With auto save
 * on, unsaved files are saved first; otherwise (or if saving fails) the user is
 * asked once about them. A file still open in another group keeps its edits,
 * so it is not saved or asked about.
 */
export async function closeTabs(paths: string[], group?: number) {
  const state = useWorkspace.getState();
  const groupId = group ?? state.activeGroup;
  const tabs = state.groups.find((g) => g.id === groupId)?.tabs.filter((t) => paths.includes(t.path)) ?? [];
  const elsewhere = new Set(
    state.groups.filter((g) => g.id !== groupId).flatMap((g) => g.tabs.map((t) => t.path)),
  );
  let losing = tabs.filter((t) => t.dirty && !elsewhere.has(t.path));
  if (useSettings.getState().autoSave && losing.length > 0) {
    const saved = await Promise.all(losing.map((t) => saveIfDirty(t.path)));
    losing = losing.filter((_, i) => !saved[i]);
  }
  if (!(await confirmDiscard(losing.map((t) => t.name)))) return;
  for (const tab of tabs) useWorkspace.getState().closeTab(tab.path, groupId);
  releaseModels(tabs.map((t) => t.path));
}

/** Closes every tab, in every group, showing `path` or a file inside it, and drops their models. */
function closeEverywhere(path: string) {
  const closing = [...openPaths(useWorkspace.getState())].filter((p) => isWithin(p, path));
  for (const group of useWorkspace.getState().groups) {
    for (const tab of group.tabs) {
      if (isWithin(tab.path, path)) useWorkspace.getState().closeTab(tab.path, group.id);
    }
  }
  for (const p of closing) disposeModel(p);
}

export function closeActiveTab() {
  const path = useWorkspace.getState().activePath;
  if (path) void closeTab(path);
}

export async function createEntry(path: string, kind: "file" | "folder") {
  await runFileOperation({ kind: "create", paths: [path] }, () => (kind === "file" ? fsApi.createFile(path) : fsApi.createDir(path)));
  if (kind === "file") useWorkspace.getState().openFile(path);
  void refreshGit();
}

/** Renames a file or folder, keeping its open tabs (and their unsaved edits). */
export async function renameEntry(from: string, to: string) {
  // Extensions may update references first (e.g. imports of a moved module).
  await runFileOperation({ kind: "rename", pairs: [{ from, to }] }, () => fsApi.renamePath(from, to));
  for (const path of openPaths(useWorkspace.getState())) {
    if (isWithin(path, from)) moveModel(path, movedPath(path, from, to));
  }
  useWorkspace.getState().renamePaths(from, to);
  void refreshGit();
}

/**
 * Deletes a file or folder after confirmation: to the trash locally, for good
 * on remote hosts (which have no trash). Returns whether it was deleted.
 */
export async function deleteEntry(path: string, isDir: boolean): Promise<boolean> {
  const what = isDir ? `folder "${basename(path)}" and all its contents` : `file "${basename(path)}"`;
  const fate = remoteOf(path) ? "It will be deleted permanently." : "It will be moved to the trash.";
  const confirmed = await ask(`Delete ${what}?\n${fate}`, {
    title: "Delete",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return false;
  try {
    await runFileOperation({ kind: "delete", paths: [path] }, () => fsApi.deletePath(path));
  } catch (e) {
    await message(`Could not delete "${basename(path)}":\n${errorMessage(e)}`, {
      title: "PowerCode",
      kind: "error",
    });
    return false;
  }
  closeEverywhere(path);
  void refreshGit();
  return true;
}

export function openTerminalAt(dir: string) {
  newTerminal(dir);
  const { bottomTool, toggleBottomTool } = useWorkspace.getState();
  if (bottomTool !== "terminal") toggleBottomTool("terminal");
}

export function openExtensionPage(namespace: string, name: string, title: string, icon?: string) {
  useWorkspace.getState().openFile(extensionTabPath(namespace, name), title, icon);
}

/** Opens a file in its default editor: an extension's custom editor if one claims it, else the text editor. */
export function openEditor(path: string) {
  useWorkspace.getState().openFile(defaultTabFor(path), basename(path));
}

/** Asks which editor to show a tab's file in (text or a custom editor) and swaps the tab for it. */
export async function reopenWith(tabPath: string, group?: number) {
  const file = tabFilePath(tabPath);
  if (!file) return;
  const current = parseCustomEditorTab(tabPath)?.viewType;
  const choices = [
    { label: "Text Editor", description: current ? undefined : "Active", tab: file },
    ...customEditorsFor(file).map((e) => ({
      label: e.displayName,
      description: e.viewType === current ? "Active" : e.priority === "default" ? "Default" : undefined,
      tab: customEditorTabPath(e.viewType, file),
    })),
  ];
  const picked = await showQuickPick({
    title: `Reopen "${basename(file)}" With`,
    placeHolder: "Select an editor",
    items: choices.map(({ label, description }) => ({ label, description })),
    canPickMany: false,
  });
  const target = picked?.[0] !== undefined ? choices[picked[0]].tab : null;
  if (!target || target === tabPath) return;
  const workspace = useWorkspace.getState();
  if (group !== undefined) workspace.focusGroup(group);
  workspace.openFile(target, basename(file));
  workspace.closeTab(tabPath, group);
}

/** Opens the Settings page, optionally searching for `query` (e.g. an extension's setting id). */
export function openSettings(query?: string) {
  useSettingsPage.setState(({ nonce }) => ({ query: query ?? "", nonce: nonce + 1 }));
  useWorkspace.getState().openFile(SETTINGS_TAB, "Settings");
}

/** Asks for .vsix files on this computer and installs them. */
export async function pickAndInstallVsix() {
  const picked = await open({
    title: "Install from VSIX",
    multiple: true,
    filters: [{ name: "VS Code Extension", extensions: ["vsix"] }],
  });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  if (paths.length > 0) await installVsixFiles(paths);
}
