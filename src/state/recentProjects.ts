//! The last folders opened (local, WSL and SSH), most recent first, for the
//! project selector in the main toolbar.

import { create } from "zustand";
import { pathKey } from "../lib/platform";

const STORAGE_KEY = "powercode.recentProjects";
const MAX_RECENT = 5;

function load(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function store(list: string[]) {
  useRecentProjects.setState({ projects: list });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Not remembering them is harmless.
  }
}

export const useRecentProjects = create<{ projects: string[] }>(() => ({ projects: load() }));

/** Puts `root` first (once: the same folder spelled differently counts as one). */
export function addRecentProject(root: string) {
  const others = useRecentProjects.getState().projects.filter((p) => pathKey(p) !== pathKey(root));
  store([root, ...others].slice(0, MAX_RECENT));
}

export function removeRecentProject(root: string) {
  store(useRecentProjects.getState().projects.filter((p) => pathKey(p) !== pathKey(root)));
}
