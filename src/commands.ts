//! Commands for the command palette (type `>` in the title bar search, or Ctrl+Shift+P).

import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeActiveTab, closeFolder, closeRemoteConnection, closeTabs, openFolder, reopenWith, saveActive } from "./actions";
import { focusFindInFiles } from "./components/SearchView";
import { saveModel } from "./editor/models";
import { fetchAll, initRepository, pull, pushBranch } from "./git/actions";
import { useGit } from "./git/store";
import { remoteOf } from "./lib/remote";
import { parseDiffTab, tabFilePath } from "./lib/virtualTabs";
import { customEditorsFor } from "./exthost/customEditors";
import { removeBreakpoints, useBreakpoints } from "./debug/breakpoints";
import { openLaunchJson, startDebugging } from "./debug/launch";
import { debugRestart, debugStop, toggleBreakpointAtCursor, useDebug } from "./debug/model";
import { notify } from "./state/notifications";
import { setAutoSave, setAutoUpdateExtensions, useSettings } from "./state/settings";
import { checkForUpdates, useExtensions } from "./extensions/runtime";
import { openUserSettings, restartExtensionHost, showOutput } from "./exthost/host";
import * as hostRpc from "./exthost/rpc";
import { useExtensionHost } from "./exthost/state";
import { useWorkspace, type ToolId } from "./state/workspace";
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
const isDebugging = () => useDebug.getState().sessions.length > 0;

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

function showTool(tool: ToolId) {
  useWorkspace.getState().showTool(tool);
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
    when: () => hasFolder() && !inRepo(),
    run: initRepository,
  },
  { id: "remote.close", category: "Remote", label: "Close Remote Connection", when: isRemote, run: closeRemoteConnection },
  {
    id: "extensions.checkUpdates",
    category: "Extensions",
    label: "Check for Extension Updates",
    run: async () => {
      const ids = await checkForUpdates(useSettings.getState().autoUpdateExtensions);
      if (ids.length === 0) notify("info", "All extensions are up to date");
    },
  },
  {
    id: "extensions.toggleAutoUpdate",
    category: "Extensions",
    label: "Toggle Auto Update",
    run: () => {
      const on = !useSettings.getState().autoUpdateExtensions;
      setAutoUpdateExtensions(on);
      notify("info", on ? "Extension auto update is on" : "Extension auto update is off");
    },
  },
  {
    id: "extensions.restartHost",
    category: "Developer",
    label: "Restart Extension Host",
    when: () => useExtensionHost.getState().status !== "stopped",
    run: restartExtensionHost,
  },
  { id: "view.output", category: "View", label: "Show Output", run: () => showOutput() },
  { id: "debug.start", category: "Debug", label: "Start Debugging", shortcut: "F5", when: hasFolder, run: () => startDebugging() },
  { id: "debug.run", category: "Debug", label: "Run Without Debugging", shortcut: "Ctrl+F5", when: hasFolder, run: () => startDebugging(true) },
  { id: "debug.stop", category: "Debug", label: "Stop", shortcut: "Shift+F5", when: isDebugging, run: () => void debugStop() },
  { id: "debug.restart", category: "Debug", label: "Restart", shortcut: "Ctrl+Shift+F5", when: isDebugging, run: () => debugRestart() },
  { id: "debug.toggleBreakpoint", category: "Debug", label: "Toggle Breakpoint", shortcut: "F9", when: hasTabs, run: toggleBreakpointAtCursor },
  { id: "debug.removeBreakpoints", category: "Debug", label: "Remove All Breakpoints", run: () => removeBreakpoints(useBreakpoints.getState().list.map((b) => b.id)) },
  { id: "debug.openLaunchJson", category: "Debug", label: "Open launch.json", when: hasFolder, run: openLaunchJson },
  { id: "view.debug", category: "View", label: "Show Run and Debug", shortcut: "Ctrl+Shift+D", run: () => showTool("debug") },
  { id: "view.debugConsole", category: "View", label: "Show Debug Console", shortcut: "Ctrl+Shift+Y", run: () => useWorkspace.getState().toggleBottomTool("debug") },
  {
    id: "view.reopenWith",
    category: "View",
    label: "Reopen Editor With…",
    when: () => {
      const active = useWorkspace.getState().activePath;
      const file = active ? tabFilePath(active) : null;
      return file !== null && customEditorsFor(file).length > 0;
    },
    run: () => {
      const active = useWorkspace.getState().activePath;
      if (active) return reopenWith(active);
    },
  },
  { id: "preferences.theme", category: "Preferences", label: "Color Theme / File Icon Theme", run: () => showTool("extensions") },
  { id: "preferences.settingsJson", category: "Preferences", label: "Open User Settings (JSON)", run: openUserSettings },
  { id: "window.maximize", category: "Window", label: "Toggle Maximize", run: () => getCurrentWindow().toggleMaximize() },
  { id: "window.minimize", category: "Window", label: "Minimize", run: () => getCurrentWindow().minimize() },
];

/** Commands contributed by running extensions, executed in the extension host. */
function contributedCommands(): Command[] {
  const installed = useExtensions.getState().installed;
  return useExtensionHost.getState().commands.map((c) => {
    const manifest = installed.find((e) => e.id === c.extension)?.manifest;
    return {
      id: `ext:${c.command}`,
      category: c.category ?? manifest?.displayName ?? manifest?.name ?? c.extension,
      label: c.title,
      run: async () => {
        await hostRpc.request("commands/execute", { command: c.command, args: [] });
      },
    };
  });
}

/** Every command for the palette: PowerCode's own and those of extensions. */
export function allCommands(): Command[] {
  return [...COMMANDS, ...contributedCommands()];
}

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
