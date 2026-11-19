//! What each folder looked like when it was last open: its editor tabs (per
//! group) and the Project view (expanded folders, scroll position). Saved as it
//! changes and restored when the folder opens again, also after a restart.

import { isVirtualTab, parseCompareTab, parseDocumentTab, parseWebviewTab } from "../lib/virtualTabs";
import { useWorkspace, type EditorGroup } from "./workspace";

const KEY_PREFIX = "powercode.session:";
const SAVE_DELAY_MS = 300;

export interface SavedTab {
  path: string;
  name: string;
  icon?: string;
}

interface Session {
  groups: { tabs: SavedTab[]; activePath: string | null }[];
  activeGroup: number;
  explorer: { expanded: string[]; scrollTop: number };
}

function read(root: string): Session | null {
  try {
    const text = localStorage.getItem(KEY_PREFIX + root);
    return text ? (JSON.parse(text) as Session) : null;
  } catch {
    return null;
  }
}

function write(root: string, update: (session: Session) => void) {
  const session = read(root) ?? { groups: [], activeGroup: 0, explorer: { expanded: [], scrollTop: 0 } };
  update(session);
  try {
    localStorage.setItem(KEY_PREFIX + root, JSON.stringify(session));
  } catch {
    // Storage full or unavailable: the folder just opens as new next time.
  }
}

/**
 * Tabs that can come back after a restart: files and pages. Webview panels and
 * extensions' documents belong to the extension host that made them.
 */
const restorable = (path: string) =>
  !parseWebviewTab(path) && !parseDocumentTab(path) && !parseCompareTab(path);

/** Files reopened from the session, for opening them quietly if they are gone. */
const restored = new Set<string>();

/** True the first time a restored tab is shown; later failures report as usual. */
export function wasRestored(path: string) {
  return restored.delete(path);
}

// ---- Tabs -------------------------------------------------------------------------

/** Reopens `root`'s tabs as they were (call right after the folder opened). */
export function restoreTabs(root: string) {
  const saved = read(root);
  restored.clear();
  const groups = (saved?.groups ?? [])
    .map((g) => ({ tabs: g.tabs.filter((t) => restorable(t.path)), activePath: g.activePath }))
    .filter((g) => g.tabs.length > 0);
  if (groups.length === 0) return;
  for (const group of groups) for (const tab of group.tabs) if (!isVirtualTab(tab.path)) restored.add(tab.path);
  useWorkspace.getState().restoreGroups(groups, Math.min(saved?.activeGroup ?? 0, groups.length - 1));
}

let saveTimer: number | undefined;

function saveTabs(root: string, groups: EditorGroup[], activeGroup: number) {
  write(root, (session) => {
    session.groups = groups.map((g) => {
      const tabs = g.tabs.filter((t) => restorable(t.path)).map(({ path, name, icon }) => ({ path, name, icon }));
      return { tabs, activePath: tabs.some((t) => t.path === g.activePath) ? g.activePath : (tabs[0]?.path ?? null) };
    });
    session.activeGroup = Math.max(0, groups.findIndex((g) => g.id === activeGroup));
  });
}

/** Saves the tabs of the open folder whenever they change; call once. */
export function startSessionSaving() {
  useWorkspace.subscribe((s, previous) => {
    if (!s.root || s.root !== previous.root) return;
    if (s.groups === previous.groups && s.activeGroup === previous.activeGroup) return;
    window.clearTimeout(saveTimer);
    const { root, groups, activeGroup } = s;
    saveTimer = window.setTimeout(() => saveTabs(root, groups, activeGroup), SAVE_DELAY_MS);
  });
}

// ---- Project view -----------------------------------------------------------------

export function savedExplorer(root: string): { expanded: string[]; scrollTop: number } {
  return read(root)?.explorer ?? { expanded: [], scrollTop: 0 };
}

/** Changes not written yet, and their timer, by folder. */
const pendingExplorer = new Map<string, { changes: { expanded?: string[]; scrollTop?: number }; timer: number }>();

/** Remembers the Project view's expanded folders and scroll position (debounced). */
export function saveExplorer(root: string, changes: { expanded?: string[]; scrollTop?: number }) {
  const pending = pendingExplorer.get(root);
  if (pending) window.clearTimeout(pending.timer);
  const merged = { ...pending?.changes, ...changes };
  const timer = window.setTimeout(() => {
    pendingExplorer.delete(root);
    write(root, (session) => {
      session.explorer = { ...session.explorer, ...merged };
    });
  }, SAVE_DELAY_MS);
  pendingExplorer.set(root, { changes: merged, timer });
}
