//! Commands for the command palette (type `>` in the title bar search, or Ctrl+Shift+P).

import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeActiveTab, closeFolder, closeRemoteConnection, closeTabs, openFolder, saveActive } from "./actions";
import { focusFindInFiles } from "./components/SearchView";
import { saveModel } from "./editor/models";
import { fetchAll, initRepository, pull, pushBranch } from "./git/actions";
import { useGit } from "./git/store";
import { remoteOf } from "./lib/remote";
import { parseDiffTab } from "./lib/virtualTabs";
import { notify } from "./state/notifications";
import { setAutoSave, useSettings } from "./state/settings";
import { useWorkspace, type LeftTool } from "./state/workspace";
import { newTerminal } from "./terminal/sessions";

export interface Command {
  id: string;
  category: string;
  label: string;
  shortcut?: string;
  /** Hides the command when it does not apply, e.g. Git commands outside a repository. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const hasFolder = () => useWorkspace.getState().root !== null;
const hasTabs = () => useWorkspace.getState().tabs.length > 0;
const inRepo = () => useGit.getState().status?.isRepo === true;
const isRemote = () => remoteOf(useWorkspace.getState().root) !== null;

/** Reloads the whole UI, after confirming if that would lose unsaved changes. */
async function reloadWindow() {
  const dirty = useWorkspace.getState().tabs.filter((t) => t.dirty);
  if (dirty.length > 0) {
    const ok = await ask(`Reloading discards unsaved changes in ${dirty.map((t) => t.name).join(", ")}.`, {
      title: "Reload Window",
      kind: "warning",
      okLabel: "Reload",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
  }
  window.location.reload();
}

async function saveAll() {
  const dirty = useWorkspace.getState().tabs.filter((t) => t.dirty);
  await Promise.all(dirty.map((t) => saveModel(parseDiffTab(t.path) ?? t.path)));
  if (dirty.length > 0) notify("success", `Saved ${dirty.length} ${dirty.length === 1 ? "file" : "files"}`);
}

function showTool(tool: LeftTool) {
  useWorkspace.getState().setLeftTool(tool);
}

function newTerminalHere() {
  const { root, bottomTool, toggleBottomTool } = useWorkspace.getState();
  newTerminal(root);
  if (bottomTool !== "terminal") toggleBottomTool("terminal");
}

const closePaths = (filter: (t: { dirty: boolean }) => boolean) =>
  closeTabs(useWorkspace.getState().tabs.filter(filter).map((t) => t.path));

export const COMMANDS: Command[] = [
  { id: "window.reload", category: "Developer", label: "Reload Window", run: reloadWindow },
  { id: "file.openFolder", category: "File", label: "Open Folder…", shortcut: "Ctrl+O", run: () => openFolder() },
  { id: "file.closeFolder", category: "File", label: "Close Folder", when: hasFolder, run: () => void closeFolder() },
  { id: "file.save", category: "File", label: "Save", shortcut: "Ctrl+S", when: hasTabs, run: saveActive },
  { id: "file.saveAll", category: "File", label: "Save All", when: hasTabs, run: saveAll },
  {
    id: "file.toggleAutoSave",
    category: "File",
    label: "Toggle Auto Save",
    run: () => {
      const on = !useSettings.getState().autoSave;
      setAutoSave(on);
      notify("info", on ? "Auto save is on" : "Auto save is off", on ? "Files are saved 1 second after each edit." : undefined);
    },
  },
  { id: "editor.close", category: "View", label: "Close Editor", shortcut: "Ctrl+F4", when: hasTabs, run: closeActiveTab },
  { id: "editor.closeAll", category: "View", label: "Close All Editors", when: hasTabs, run: () => closePaths(() => true) },
  { id: "editor.closeSaved", category: "View", label: "Close Saved Editors", when: hasTabs, run: () => closePaths((t) => !t.dirty) },
  {
    id: "editor.splitRight",
    category: "View",
    label: "Split Editor Right",
    shortcut: "Ctrl+\\",
    when: () => useWorkspace.getState().activePath !== null,
    run: () => useWorkspace.getState().splitRight(),
  },
  { id: "view.project", category: "View", label: "Show Project", shortcut: "Alt+1", run: () => showTool("project") },
  { id: "view.commit", category: "View", label: "Show Commit", shortcut: "Alt+0", run: () => showTool("commit") },
  { id: "view.search", category: "View", label: "Find in Files", shortcut: "Ctrl+Shift+F", run: focusFindInFiles },
  { id: "view.remote", category: "View", label: "Show Remote Hosts", run: () => showTool("remote") },
  { id: "view.extensions", category: "View", label: "Show Extensions", shortcut: "Alt+2", run: () => showTool("extensions") },
  {
    id: "view.terminal",
    category: "View",
    label: "Toggle Terminal",
    shortcut: "Alt+F12",
    run: () => useWorkspace.getState().toggleBottomTool("terminal"),
  },
  { id: "terminal.new", category: "Terminal", label: "New Terminal", run: newTerminalHere },
  { id: "git.pull", category: "Git", label: "Pull (Update Project)", when: inRepo, run: pull },
  { id: "git.push", category: "Git", label: "Push", when: inRepo, run: pushBranch },
  { id: "git.fetch", category: "Git", label: "Fetch", when: inRepo, run: fetchAll },
  { id: "git.commit", category: "Git", label: "Commit…", shortcut: "Alt+0", when: inRepo, run: () => showTool("commit") },
  {
    id: "git.init",
    category: "Git",
    label: "Initialize Repository",
    when: () => hasFolder() && !inRepo() && !isRemote(),
    run: initRepository,
  },
  { id: "remote.close", category: "Remote", label: "Close Remote Connection", when: isRemote, run: closeRemoteConnection },
  { id: "preferences.theme", category: "Preferences", label: "Color Theme / File Icon Theme", run: () => showTool("extensions") },
  { id: "window.maximize", category: "Window", label: "Toggle Maximize", run: () => getCurrentWindow().toggleMaximize() },
  { id: "window.minimize", category: "Window", label: "Minimize", run: () => getCurrentWindow().minimize() },
];

const RECENT_KEY = "powercode.recentCommands";
const MAX_RECENT = 8;

/** Ids of recently run commands, most recent first. */
export function recentCommands(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export async function runCommand(command: Command) {
  try {
    const recent = [command.id, ...recentCommands().filter((id) => id !== command.id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Not remembering it is harmless.
  }
  try {
    await command.run();
  } catch (e) {
    notify("error", `${command.label} failed`, e instanceof Error ? e.message : String(e));
  }
}
