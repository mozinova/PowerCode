import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { disposeAllModels, disposeModel, moveModel, saveModel } from "./editor/models";
import { errorMessage, fsApi, remoteApi } from "./lib/ipc";
import { basename, isWithin, movedPath } from "./lib/paths";
import { remoteLabel, remoteOf } from "./lib/remote";
import { extensionTabPath, parseDiffTab } from "./lib/virtualTabs";
import { refreshGit } from "./git/store";
import { pickRemoteFolder } from "./state/folderPicker";
import { notify } from "./state/notifications";
import { useWorkspace } from "./state/workspace";
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
  try {
    await saveModel(path);
    void refreshGit();
  } catch (e) {
    await message(`Could not save the file:\n${errorMessage(e)}`, {
      title: "PowerCode",
      kind: "error",
    });
  }
}

export function closeTab(path: string) {
  return closeTabs([path]);
}

/** Closes several tabs, asking once about all of their unsaved changes. */
export async function closeTabs(paths: string[]) {
  const tabs = useWorkspace.getState().tabs.filter((t) => paths.includes(t.path));
  if (!(await confirmDiscard(tabs.filter((t) => t.dirty).map((t) => t.name)))) return;
  for (const tab of tabs) {
    useWorkspace.getState().closeTab(tab.path);
    disposeModel(tab.path);
  }
}

export function closeActiveTab() {
  const path = useWorkspace.getState().activePath;
  if (path) void closeTab(path);
}

export async function createEntry(path: string, kind: "file" | "folder") {
  if (kind === "file") {
    await fsApi.createFile(path);
    useWorkspace.getState().openFile(path);
  } else {
    await fsApi.createDir(path);
  }
  void refreshGit();
}

/** Renames a file or folder, keeping its open tabs (and their unsaved edits). */
export async function renameEntry(from: string, to: string) {
  await fsApi.renamePath(from, to);
  for (const tab of useWorkspace.getState().tabs) {
    if (isWithin(tab.path, from)) moveModel(tab.path, movedPath(tab.path, from, to));
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
    await fsApi.deletePath(path);
  } catch (e) {
    await message(`Could not delete "${basename(path)}":\n${errorMessage(e)}`, {
      title: "PowerCode",
      kind: "error",
    });
    return false;
  }
  for (const tab of useWorkspace.getState().tabs) {
    if (isWithin(tab.path, path)) {
      useWorkspace.getState().closeTab(tab.path);
      disposeModel(tab.path);
    }
  }
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
