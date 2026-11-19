//! Changes made outside the editor (AI agents, other editors, `git`) show up on
//! their own: with auto save on, every `files.autoSaveDelay` the open files and
//! the Project view's expanded folders are checked (one batched `stat`, remote
//! paths in one command per host). A changed file without unsaved edits is
//! reloaded; a changed folder is listed again.

import { invoke } from "@tauri-apps/api/core";
import { refreshGit } from "../git/store";
import { setting } from "../settings/store";
import { useSettings } from "../state/settings";
import { useWorkspace } from "../state/workspace";
import { openModelPaths, reloadModelIfClean } from "./models";

/** At most this often, however short the auto save delay. */
const MIN_INTERVAL_MS = 1000;

/** Folders the Project view shows expanded, and what to do when some change. */
let watchedFolders: { folders: () => string[]; changed: (folders: string[]) => void } | null = null;

export function watchFolders(folders: () => string[], changed: (folders: string[]) => void) {
  watchedFolders = { folders, changed };
  return () => {
    if (watchedFolders?.folders === folders) watchedFolders = null;
  };
}

/** Last signature (modification time and size) of each checked path. */
let known = new Map<string, string | null>();
let busy = false;

async function check() {
  if (busy || !useSettings.getState().autoSave || !useWorkspace.getState().root) return;
  const files = openModelPaths();
  const folders = watchedFolders?.folders() ?? [];
  const paths = [...new Set([...files, ...folders])];
  if (paths.length === 0) return;
  busy = true;
  try {
    const signatures = await invoke<(string | null)[]>("fs_signatures", { paths });
    const next = new Map<string, string | null>();
    const changed = new Set<string>();
    paths.forEach((path, i) => {
      next.set(path, signatures[i]);
      // A path seen for the first time only records where it stands.
      if (known.has(path) && known.get(path) !== signatures[i]) changed.add(path);
    });
    known = next;
    for (const path of files) if (changed.has(path) && signatures[paths.indexOf(path)] !== null) void reloadModelIfClean(path);
    const changedFolders = folders.filter((f) => changed.has(f));
    if (changedFolders.length > 0) watchedFolders?.changed(changedFolders);
    // Their Git status (colours in the tree and tabs) changed too.
    if (changed.size > 0) void refreshGit();
  } catch {
    // A remote that does not answer: the next tick tries again.
  } finally {
    busy = false;
  }
}

/** Starts checking for outside changes; call once. */
export function startExternalChangeWatcher() {
  let timer: number | undefined;
  const loop = () => {
    const delay = Math.max(MIN_INTERVAL_MS, setting("files.autoSaveDelay", 1000));
    timer = window.setTimeout(() => void check().finally(loop), delay);
  };
  loop();
  // A new folder starts from scratch.
  useWorkspace.subscribe((s, previous) => {
    if (s.root !== previous.root) known = new Map();
  });
  return () => window.clearTimeout(timer);
}
