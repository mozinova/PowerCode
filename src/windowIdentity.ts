//! What the OS shows for this window: its title ("<project> - PowerCode", on the
//! taskbar and in Alt+Tab) and, on Windows, the jump list ("New Window" and the
//! recent projects when right-clicking the taskbar or Start menu icon).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basename } from "./lib/paths";
import { IS_WINDOWS } from "./lib/platform";
import { remoteLabel, remoteOf } from "./lib/remote";
import { useRecentProjects } from "./state/recentProjects";
import { useWorkspace } from "./state/workspace";

/** "api [WSL: Ubuntu] - PowerCode", or just "PowerCode" with no folder open. */
export function windowTitle(root: string | null): string {
  if (!root) return "PowerCode";
  const remote = remoteOf(root);
  return `${basename(root)}${remote ? ` [${remoteLabel(remote)}]` : ""} - PowerCode`;
}

let started = false;

export function startWindowIdentity() {
  if (started) return;
  started = true;

  let title = "";
  const showTitle = (root: string | null) => {
    const next = windowTitle(root);
    if (next === title) return;
    title = next;
    document.title = next;
    void getCurrentWindow().setTitle(next).catch(() => {});
  };
  showTitle(useWorkspace.getState().root);
  useWorkspace.subscribe((s) => showTitle(s.root));

  if (!IS_WINDOWS) return;
  let listed = "";
  const updateJumpList = (recent: string[]) => {
    const key = JSON.stringify(recent);
    if (key === listed) return;
    listed = key;
    // Best effort: a missing jump list must never get in the way.
    void invoke("system_update_jump_list", { recent }).catch((e) => console.warn("Jump list:", e));
  };
  updateJumpList(useRecentProjects.getState().projects);
  useRecentProjects.subscribe((s) => updateJumpList(s.projects));
}
