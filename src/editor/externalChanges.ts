//! Changes made outside the editor (AI agents, other editors, `git`) show up on
//! their own, with auto save on or off: every `files.autoSaveDelay` (and when the
//! window gets focus) the open files and the Project view's expanded folders are
//! checked (one batched `stat`, remote paths in one command per host). A changed
//! file without unsaved edits is reloaded; one with unsaved edits asks what to do
//! (see saveConflicts.ts); a changed folder is listed again.

import { refreshGit } from "../git/store";
import { fsApi } from "../lib/ipc";
import { setting } from "../settings/store";
import { useWorkspace } from "../state/workspace";
import { diskSignature, isModelDirty, openModelPaths, reloadModelIfClean } from "./models";
import { resolveSaveConflict, shouldAsk } from "./saveConflicts";

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

/** Last signature (modification time and size) of each checked folder. */
let known = new Map<string, string | null>();
let busy = false;

async function check() {
  if (busy || !useWorkspace.getState().root) return;
  const files = openModelPaths();
  const folders = watchedFolders?.folders() ?? [];
  const paths = [...new Set([...files, ...folders])];
  if (paths.length === 0) return;
  busy = true;
  try {
    // Open files compare with the signature they were read or saved with. Taken
    // before asking: a save or reload meanwhile changes it, and is not a change.
    const before = new Map(files.map((path) => [path, diskSignature(path)]));
    const signatures = await fsApi.signatures(paths);
    const current = new Map(paths.map((path, i) => [path, signatures[i]]));
    let changes = 0;
    for (const path of files) {
      const was = before.get(path);
      const now = current.get(path);
      // Unknown, deleted, or saved/reloaded meanwhile: nothing to do.
      if (was == null || now == null || now === was || diskSignature(path) !== was) continue;
      changes++;
      if (!isModelDirty(path)) void reloadModelIfClean(path);
      else if (await shouldAsk(path)) void resolveSaveConflict(path, "watcher");
    }
    const next = new Map<string, string | null>();
    const changedFolders: string[] = [];
    for (const folder of folders) {
      next.set(folder, current.get(folder) ?? null);
      // A folder seen for the first time only records where it stands.
      if (known.has(folder) && known.get(folder) !== current.get(folder)) changedFolders.push(folder);
    }
    known = next;
    if (changedFolders.length > 0) watchedFolders?.changed(changedFolders);
    // Their Git status (colours in the tree and tabs) changed too.
    if (changes + changedFolders.length > 0) void refreshGit();
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
  // Back from another app (where an agent or editor may have changed files): check now.
  window.addEventListener("focus", () => void check());
  // A new folder starts from scratch.
  useWorkspace.subscribe((s, previous) => {
    if (s.root !== previous.root) known = new Map();
  });
  return () => window.clearTimeout(timer);
}
