//! File system watching for `workspace.createFileSystemWatcher`.
//!
//! On Windows and macOS, Node's recursive `fs.watch` is the OS's own (one handle
//! per tree). On Linux it is not: Node walks the tree and adds an inotify watch per
//! directory. The TypeScript server alone asks for hundreds of watchers, many on
//! `node_modules`, so each one walked those trees again: the host's event loop
//! stalled (no completions, no hovers) and the system's inotify limit ran out
//! ("ENOSPC: System limit for number of file watchers reached"), breaking every
//! other watcher too. So on Linux the trees are walked here, once: one
//! non-recursive watch per directory, shared by all watchers, never inside a
//! package of `node_modules` nor `.git` (VS Code's `files.watcherExclude` defaults).

import * as fs from "node:fs";
import * as path from "node:path";

export type WatchEvent = "change" | "rename";
type Listener = (event: WatchEvent, file: string) => void;

const NATIVE_RECURSIVE = process.platform === "win32" || process.platform === "darwin";

/** At most this many directories watched in all (well under the usual inotify limit of 8192+). */
const MAX_DIRECTORIES = 4000;

let warned = false;
function warnOnce(error: unknown) {
  if (warned) return;
  warned = true;
  console.warn(`File watching is limited: ${error instanceof Error ? error.message : String(error)}`);
}

// ---- Linux: one shared watch per directory ------------------------------------------

interface DirectoryWatch {
  watcher: fs.FSWatcher;
  listeners: Set<Listener>;
}

const directories = new Map<string, DirectoryWatch>();

/** Watches the entries of `dir` (not deeper) for `listener`; returns how to stop. */
function watchDirectory(dir: string, listener: Listener): (() => void) | null {
  let entry = directories.get(dir);
  if (!entry) {
    if (directories.size >= MAX_DIRECTORIES) {
      warnOnce(new Error(`more than ${MAX_DIRECTORIES} folders`));
      return null;
    }
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false });
    } catch (e) {
      warnOnce(e);
      return null;
    }
    const created: DirectoryWatch = { watcher, listeners: new Set() };
    watcher.on("change", (event, name) => {
      if (!name) return;
      const file = path.join(dir, name.toString());
      for (const l of created.listeners) l(event as WatchEvent, file);
    });
    // Without a handler, a failing watch (ENOSPC, the folder deleted) is an uncaught error.
    watcher.on("error", (e) => {
      warnOnce(e);
      watcher.close();
      directories.delete(dir);
    });
    directories.set(dir, created);
    entry = created;
  }
  entry.listeners.add(listener);
  const watched = entry;
  return () => {
    watched.listeners.delete(listener);
    if (watched.listeners.size === 0) {
      watched.watcher.close();
      if (directories.get(dir) === watched) directories.delete(dir);
    }
  };
}

/** Whether a walk goes into `dir`: not `.git`, nor a package inside `node_modules`. */
function descends(dir: string): boolean {
  const name = path.basename(dir);
  if (name === ".git") return false;
  return path.basename(path.dirname(dir)) !== "node_modules" && !(path.basename(path.dirname(dir)).startsWith("@") && path.basename(path.dirname(path.dirname(dir))) === "node_modules");
}

/** Watches the tree under `base` (shared per directory); new folders join as they appear. */
function watchTreeLinux(base: string, recursive: boolean, listener: Listener): () => void {
  const stops = new Map<string, () => void>();
  const add = (dir: string, depth: number) => {
    if (stops.has(dir)) return;
    const stop = watchDirectory(dir, onEvent);
    if (!stop) return;
    stops.set(dir, stop);
    if (!recursive || !descends(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && depth < 40) add(path.join(dir, e.name), depth + 1);
  };
  const onEvent = (event: WatchEvent, file: string) => {
    // A folder created inside the tree is watched too.
    if (recursive && event === "rename" && !stops.has(file)) {
      fs.stat(file, (error, stat) => {
        if (!error && stat.isDirectory() && descends(path.dirname(file))) add(file, 0);
      });
    }
    listener(event, file);
  };
  add(base, 0);
  return () => {
    for (const stop of stops.values()) stop();
    stops.clear();
  };
}

// ---- Windows and macOS: the OS's recursive watch, shared per base ---------------------

const trees = new Map<string, { watcher: fs.FSWatcher; listeners: Set<Listener> }>();

function watchTreeNative(base: string, recursive: boolean, listener: Listener): () => void {
  const key = `${recursive ? "r" : "n"}:${base}`;
  let entry = trees.get(key);
  if (!entry) {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(base, { recursive, persistent: false });
    } catch (e) {
      warnOnce(e);
      return () => {};
    }
    const created = { watcher, listeners: new Set<Listener>() };
    watcher.on("change", (event, name) => {
      if (!name) return;
      const file = path.join(base, name.toString());
      for (const l of created.listeners) l(event as WatchEvent, file);
    });
    watcher.on("error", (e) => {
      warnOnce(e);
      watcher.close();
      trees.delete(key);
    });
    trees.set(key, created);
    entry = created;
  }
  entry.listeners.add(listener);
  const watched = entry;
  return () => {
    watched.listeners.delete(listener);
    if (watched.listeners.size === 0) {
      watched.watcher.close();
      if (trees.get(key) === watched) trees.delete(key);
    }
  };
}

/**
 * Calls `listener` with the absolute path of entries that change under `base`:
 * only its own entries unless `recursive`. Best effort: a folder that cannot be
 * watched is skipped. Returns how to stop.
 */
export function watchTree(base: string, recursive: boolean, listener: Listener): () => void {
  // A file: its folder, filtered to it.
  let dir = base;
  try {
    if (!fs.statSync(base).isDirectory()) {
      dir = path.dirname(base);
      const only = path.resolve(base);
      const stop = (NATIVE_RECURSIVE ? watchTreeNative : watchTreeLinux)(dir, false, (event, file) => {
        if (path.resolve(file) === only) listener(event, file);
      });
      return stop;
    }
  } catch {
    // Not there: nothing to watch (as with Node's fs.watch, which throws).
    return () => {};
  }
  return (NATIVE_RECURSIVE ? watchTreeNative : watchTreeLinux)(dir, recursive, listener);
}

/** Directories watched (Linux), for tests. */
export const watchedDirectoryCount = () => directories.size;
