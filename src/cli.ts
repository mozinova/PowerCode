//! Paths from the command line (`powercode <path>`) and the OS ("Open with"):
//! the ones the app started with, and those later launches hand to this window.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openEditor, openFolder } from "./actions";
import { isWithin } from "./lib/paths";
import { pathKey } from "./lib/platform";
import { notify } from "./state/notifications";
import { useWorkspace } from "./state/workspace";

export interface OpenRequest {
  path: string;
  line: number | null;
  column: number | null;
  isDir: boolean;
  exists: boolean;
}

/** Whether this window was started as an additional one (New Window, `powercode -n`). */
export function isNewWindow(): Promise<boolean> {
  return invoke<{ newWindow: boolean }>("cli_launch_info").then((info) => info.newWindow, () => false);
}

/** Opens another PowerCode window (its own process), empty or with `path` (a folder) open. */
export async function openNewWindow(path?: string) {
  try {
    await invoke("cli_new_window", { path: path ?? null });
  } catch (e) {
    notify("error", "Could not open a new window", String(e));
  }
}

/** The paths the app was started with (the backend queues them until asked). */
export function takeStartupRequests(): Promise<OpenRequest[]> {
  return invoke<OpenRequest[]>("cli_take_pending").catch(() => []);
}

/** Opens files in tabs (at their line with `-g`); missing files are reported. */
export function openFiles(requests: OpenRequest[]) {
  const missing = requests.filter((r) => !r.isDir && !r.exists);
  if (missing.length > 0) notify("error", missing.length === 1 ? "File not found" : "Files not found", missing.map((r) => r.path).join("\n"));
  for (const request of requests) {
    if (request.isDir || !request.exists) continue;
    if (request.line) {
      const column = request.column ?? 1;
      useWorkspace.getState().openFileAt(request.path, request.line, column, column);
    } else {
      openEditor(request.path);
    }
  }
}

/**
 * A later `powercode <path>`, handed to this (the first) window. A folder opens here
 * when no folder is open, in a new window when another one is (as `code <folder>`
 * does); the open folder or one inside it stays here. Files open in tabs here.
 */
async function handle(requests: OpenRequest[]) {
  const folder = requests.find((r) => r.isDir);
  const root = useWorkspace.getState().root;
  if (folder && !(root && isWithin(pathKey(folder.path), pathKey(root)))) {
    if (root) await openNewWindow(folder.path);
    else await openFolder(folder.path);
  }
  openFiles(requests);
}

let listening = false;

export function listenForOpenRequests() {
  if (listening) return;
  listening = true;
  void listen<OpenRequest[]>("cli-open", (event) => void handle(event.payload));
}

// ---- Installing the integration -------------------------------------------------------

export interface IntegrationStatus {
  commandPath: string;
  commandInstalled: boolean;
  commandOnPath: boolean;
  openWithRegistered: boolean;
  openWithSupported: boolean;
}

export const systemApi = {
  status: () => invoke<IntegrationStatus>("system_integration_status"),
  installCommand: () => invoke<void>("system_install_command"),
  uninstallCommand: () => invoke<void>("system_uninstall_command"),
  registerOpenWith: () => invoke<void>("system_register_open_with"),
  unregisterOpenWith: () => invoke<void>("system_unregister_open_with"),
};

export async function installShellCommand() {
  try {
    await systemApi.installCommand();
    const status = await systemApi.status();
    notify(
      "success",
      "Shell command 'powercode' installed",
      status.commandOnPath
        ? "Open a new terminal and run: powercode <folder or file>"
        : `Installed at ${status.commandPath}, but that folder is not on your PATH yet.`,
    );
  } catch (e) {
    notify("error", "Could not install the shell command", e instanceof Error ? e.message : String(e));
  }
}

export async function uninstallShellCommand() {
  try {
    await systemApi.uninstallCommand();
    notify("success", "Shell command 'powercode' removed");
  } catch (e) {
    notify("error", "Could not remove the shell command", e instanceof Error ? e.message : String(e));
  }
}

export async function registerOpenWith() {
  try {
    await systemApi.registerOpenWith();
    notify("success", "PowerCode added to \"Open with\"", "Code files and folders now offer PowerCode in their context menu.");
  } catch (e) {
    notify("error", "Could not add PowerCode to \"Open with\"", e instanceof Error ? e.message : String(e));
  }
}

export async function unregisterOpenWith() {
  try {
    await systemApi.unregisterOpenWith();
    notify("success", "PowerCode removed from \"Open with\"");
  } catch (e) {
    notify("error", "Could not remove PowerCode from \"Open with\"", e instanceof Error ? e.message : String(e));
  }
}
