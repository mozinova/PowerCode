//! Git status of the open project, refreshed on focus, on an interval, and
//! after anything that can change it (saves, file operations, git commands).

import { create } from "zustand";
import { gitApi, type GitFile, type GitStatus } from "../lib/ipc";
import { isWithin, parentDir } from "../lib/paths";
import { pathKey } from "../lib/platform";
import { track } from "../state/activity";
import { isTrusted, useTrust } from "../state/trust";
import { useWorkspace } from "../state/workspace";

export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored" | "conflicted";

/** IntelliJ New UI (dark) file status colours. */
export const GIT_COLORS: Record<GitFileState, string> = {
  modified: "#70aeff",
  renamed: "#70aeff",
  added: "#73bd79",
  deleted: "#6f737a",
  untracked: "#d1675a",
  ignored: "#8f8f52",
  conflicted: "#db5c5c",
};

export const GIT_LETTERS: Record<GitFileState, string> = {
  modified: "M",
  renamed: "R",
  added: "A",
  deleted: "D",
  untracked: "U",
  ignored: "I",
  conflicted: "C",
};

export function fileState(file: GitFile): GitFileState {
  if (file.conflicted) return "conflicted";
  if (file.untracked) return "untracked";
  if (file.ignored) return "ignored";
  if (file.index === "D" || file.worktree === "D") return "deleted";
  if (file.index === "A") return "added";
  if (file.index === "R") return "renamed";
  return "modified";
}

interface GitStore {
  status: GitStatus | null;
  /** By `pathKey`. */
  files: Map<string, GitFile>;
  /** Folders containing changes, by `pathKey`. */
  folders: Map<string, GitFileState>;
  ignored: string[];
}

export const useGit = create<GitStore>(() => ({
  status: null,
  files: new Map(),
  folders: new Map(),
  ignored: [],
}));

/** Folders take the most important state among the changes inside them. */
const FOLDER_PRIORITY: GitFileState[] = ["conflicted", "modified", "untracked"];

function index(status: GitStatus): Omit<GitStore, "status"> {
  const files = new Map<string, GitFile>();
  const folders = new Map<string, GitFileState>();
  const ignored: string[] = [];
  const top = status.top ? pathKey(status.top) : null;

  for (const file of status.files) {
    files.set(pathKey(file.path), file);
    if (file.ignored) {
      ignored.push(file.path);
      continue;
    }
    const state = fileState(file);
    const folderState: GitFileState =
      state === "conflicted" ? "conflicted" : state === "untracked" ? "untracked" : "modified";
    for (let dir = parentDir(file.path); ; dir = parentDir(dir)) {
      const key = pathKey(dir);
      const current = folders.get(key);
      if (!current || FOLDER_PRIORITY.indexOf(folderState) < FOLDER_PRIORITY.indexOf(current)) {
        folders.set(key, folderState);
      }
      if (key === top || parentDir(dir) === dir) break;
    }
  }
  return { files, folders, ignored };
}

/** The git state shown for a file or folder in the tree and tabs. */
export function gitStateOf(store: GitStore, path: string, isDir = false): GitFileState | null {
  const key = pathKey(path);
  const file = store.files.get(key);
  if (file) return fileState(file);
  if (isDir) {
    const folder = store.folders.get(key);
    if (folder) return folder;
  }
  return store.ignored.some((dir) => isWithin(key, pathKey(dir))) ? "ignored" : null;
}

export function useGitState(path: string, isDir = false): GitFileState | null {
  return useGit((s) => gitStateOf(s, path, isDir));
}

let inFlight = false;
let queued = false;

export async function refreshGit() {
  if (inFlight) {
    queued = true;
    return;
  }
  const root = useWorkspace.getState().root;
  // In Restricted Mode git does not run: a repository's config can run commands (e.g. `core.fsmonitor`).
  if (!root || !isTrusted()) {
    useGit.setState({ status: null, files: new Map(), folders: new Map(), ignored: [] });
    return;
  }
  inFlight = true;
  try {
    const status = await track("Reading Git repository…", () => gitApi.status(root));
    // Ignore a result for a project that was closed meanwhile.
    // Polling returns equal statuses most of the time; keep the old object so nothing re-renders.
    const unchanged = JSON.stringify(status) === JSON.stringify(useGit.getState().status);
    if (useWorkspace.getState().root === root && !unchanged) useGit.setState({ status, ...index(status) });
  } catch {
    if (useWorkspace.getState().root === root) {
      useGit.setState({ status: null, files: new Map(), folders: new Map(), ignored: [] });
    }
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      void refreshGit();
    }
  }
}

const POLL_INTERVAL_MS = 5000;

/** Starts automatic refreshes; call once. */
export function startGitWatcher() {
  useWorkspace.subscribe((state, previous) => {
    if (state.root !== previous.root) void refreshGit();
  });
  useTrust.subscribe((state, previous) => {
    if (state.state !== previous.state) void refreshGit();
  });
  window.addEventListener("focus", () => void refreshGit());
  // Picks up changes made outside the app, e.g. from the terminal.
  window.setInterval(() => {
    if (document.hasFocus()) void refreshGit();
  }, POLL_INTERVAL_MS);
  void refreshGit();
}
