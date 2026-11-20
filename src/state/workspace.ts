import { create } from "zustand";
import { basename, movedPath } from "../lib/paths";
import { parseCustomEditorTab } from "../lib/virtualTabs";
import { sideOf } from "./toolLayout";

/** Built-in tool windows, and `view:<container>` for extensions' view containers. */
export type ToolId =
  | "project"
  | "commit"
  | "search"
  | "remote"
  | "extensions"
  | "debug"
  | "testing"
  | "chat"
  | "hierarchy"
  | `view:${string}`;
export type BottomTool = "terminal" | "output" | "debug";

export interface EditorTab {
  path: string;
  name: string;
  dirty: boolean;
  /** Image URL shown instead of a file icon, e.g. an extension's icon on its page tab. */
  icon?: string;
}

/** One editor of a split: its own tabs and active tab. */
export interface EditorGroup {
  id: number;
  tabs: EditorTab[];
  activePath: string | null;
}

/** A location to select once a file is shown, e.g. a search match. */
export interface RevealRequest {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  /** Last line of the selection; `line` when absent. */
  endLine?: number;
  /** Distinguishes repeated requests for the same location. */
  nonce: number;
}

export interface CursorInfo {
  line: number;
  column: number;
  selected: number;
}

export interface EditorStatus {
  language: string;
  eol: "LF" | "CRLF";
  indent: string;
}

interface WorkspaceState {
  root: string | null;
  /** Editor groups, left to right; there is always at least one. */
  groups: EditorGroup[];
  /** Id of the focused group, where files open and tab commands apply. */
  activeGroup: number;
  /** The active group's tabs (kept in sync, for code that only cares about the focused editor). */
  tabs: EditorTab[];
  /** The active group's active tab. */
  activePath: string | null;
  /** The open tool window of each sidebar; tools live on one side (see state/toolLayout.ts). */
  leftTool: ToolId | null;
  rightTool: ToolId | null;
  bottomTool: BottomTool | null;
  cursor: CursorInfo | null;
  status: EditorStatus | null;
  /** Bumped when files may have changed on disk behind the tree's back (checkout, pull, ...). */
  fsVersion: number;
  reveal: RevealRequest | null;

  openFolder: (root: string) => void;
  closeFolder: () => void;
  /** Replaces the editor groups with saved ones (tabs not dirty), focusing the `activeIndex`th. */
  restoreGroups: (
    groups: { tabs: { path: string; name: string; icon?: string }[]; activePath: string | null }[],
    activeIndex: number,
  ) => void;
  /** Opens (or focuses) a tab in the active group; `name` defaults to the file name, for page tabs it is their title. */
  openFile: (path: string, name?: string, icon?: string) => void;
  setTabIcon: (path: string, icon: string) => void;
  /** Opens a file and selects from `line`:`column` to `endLine`:`endColumn` (1-based, UTF-16; `endLine` defaults to `line`). */
  openFileAt: (path: string, line: number, column: number, endColumn: number, endLine?: number) => void;
  /** Closes a tab of `group` (the active group by default); an emptied group goes away unless it is the last. */
  closeTab: (path: string, group?: number) => void;
  /** Activates a tab of `group` (the active group by default) and focuses that group. */
  setActive: (path: string, group?: number) => void;
  focusGroup: (group: number) => void;
  /** Opens the active tab again in a new group to the right of the active one. */
  splitRight: () => void;
  setDirty: (path: string, dirty: boolean) => void;
  /** Re-points tabs at `from`, or inside it, after it was renamed to `to`. */
  renamePaths: (from: string, to: string) => void;
  /** Opens or closes a tool window, in whichever sidebar it is. */
  toggleTool: (tool: ToolId) => void;
  /** Shows a tool window (without toggling it off when already shown). */
  showTool: (tool: ToolId) => void;
  /** Shows a tool window in `side` after it moved there, closing it on the other side. */
  placeTool: (tool: ToolId, side: "left" | "right") => void;
  toggleBottomTool: (tool: BottomTool) => void;
  setCursor: (cursor: CursorInfo | null) => void;
  setStatus: (status: EditorStatus | null) => void;
  filesChanged: () => void;
}

let nextGroupId = 1;

function emptyGroup(): EditorGroup {
  return { id: nextGroupId++, tabs: [], activePath: null };
}

/** The state for `groups` with `activeGroup` focused, including the mirrored active-group fields. */
function withGroups(groups: EditorGroup[], activeGroup: number) {
  const active = groups.find((g) => g.id === activeGroup) ?? groups[0];
  return { groups, activeGroup: active.id, tabs: active.tabs, activePath: active.activePath };
}

const mapTabs = (groups: EditorGroup[], fn: (tab: EditorTab) => EditorTab) =>
  groups.map((g) => {
    const tabs = g.tabs.map(fn);
    return tabs.some((t, i) => t !== g.tabs[i]) ? { ...g, tabs } : g;
  });

/** Paths open in any group. */
export function openPaths(state: Pick<WorkspaceState, "groups">): Set<string> {
  return new Set(state.groups.flatMap((g) => g.tabs.map((t) => t.path)));
}

const initialGroup = emptyGroup();

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  ...withGroups([initialGroup], initialGroup.id),
  leftTool: "project",
  rightTool: null,
  bottomTool: null,
  cursor: null,
  status: null,
  fsVersion: 0,
  reveal: null,

  openFolder: (root) => {
    const group = emptyGroup();
    set({ root, ...withGroups([group], group.id), leftTool: "project" });
  },
  closeFolder: () => {
    const group = emptyGroup();
    set({ root: null, ...withGroups([group], group.id), cursor: null, status: null });
  },
  restoreGroups: (saved, activeIndex) => {
    const groups = saved.map((g) => ({ ...emptyGroup(), tabs: g.tabs.map((t) => ({ ...t, dirty: false })), activePath: g.activePath }));
    if (groups.length > 0) set(withGroups(groups, groups[Math.min(activeIndex, groups.length - 1)].id));
  },

  openFile: (path, name, icon) =>
    set((s) => {
      const groups = s.groups.map((g) =>
        g.id !== s.activeGroup
          ? g
          : {
              ...g,
              tabs: g.tabs.some((t) => t.path === path)
                ? g.tabs
                : [...g.tabs, { path, name: name ?? basename(path), dirty: false, icon }],
              activePath: path,
            },
      );
      return withGroups(groups, s.activeGroup);
    }),

  openFileAt: (path, line, column, endColumn, endLine) => {
    get().openFile(path);
    set((s) => ({ reveal: { path, line, column, endColumn, endLine, nonce: (s.reveal?.nonce ?? 0) + 1 } }));
  },

  setTabIcon: (path, icon) =>
    set((s) =>
      withGroups(
        mapTabs(s.groups, (t) => (t.path === path && t.icon !== icon ? { ...t, icon } : t)),
        s.activeGroup,
      ),
    ),

  closeTab: (path, groupId) =>
    set((s) => {
      const id = groupId ?? s.activeGroup;
      const group = s.groups.find((g) => g.id === id);
      const index = group?.tabs.findIndex((t) => t.path === path) ?? -1;
      if (!group || index < 0) return s;
      const tabs = group.tabs.filter((t) => t.path !== path);
      // Like IntelliJ, activate the tab to the left of the closed one.
      const activePath =
        group.activePath === path ? (tabs[Math.max(0, index - 1)]?.path ?? null) : group.activePath;

      if (tabs.length === 0 && s.groups.length > 1) {
        // An emptied split closes; focus moves to its left neighbour (or right, for the first).
        const position = s.groups.indexOf(group);
        const groups = s.groups.filter((g) => g !== group);
        const nextActive = id === s.activeGroup ? groups[Math.max(0, position - 1)].id : s.activeGroup;
        return withGroups(groups, nextActive);
      }
      return withGroups(
        s.groups.map((g) => (g === group ? { ...g, tabs, activePath } : g)),
        s.activeGroup,
      );
    }),

  setActive: (path, groupId) =>
    set((s) => {
      const id = groupId ?? s.activeGroup;
      return withGroups(
        s.groups.map((g) => (g.id === id ? { ...g, activePath: path } : g)),
        id,
      );
    }),

  focusGroup: (id) => set((s) => (s.activeGroup === id ? s : withGroups(s.groups, id))),

  splitRight: () =>
    set((s) => {
      const position = s.groups.findIndex((g) => g.id === s.activeGroup);
      const source = s.groups[position];
      const active = source.tabs.find((t) => t.path === source.activePath);
      const group: EditorGroup = {
        ...emptyGroup(),
        tabs: active ? [{ ...active }] : [],
        activePath: active?.path ?? null,
      };
      const groups = [...s.groups.slice(0, position + 1), group, ...s.groups.slice(position + 1)];
      return withGroups(groups, group.id);
    }),

  setDirty: (path, dirty) =>
    set((s) =>
      withGroups(
        // A custom editor showing the file (as text) is dirty with it.
        mapTabs(s.groups, (t) =>
          (t.path === path || parseCustomEditorTab(t.path)?.path === path) && t.dirty !== dirty ? { ...t, dirty } : t,
        ),
        s.activeGroup,
      ),
    ),

  renamePaths: (from, to) =>
    set((s) => {
      const groups = mapTabs(s.groups, (t) => {
        const path = movedPath(t.path, from, to);
        return path === t.path ? t : { ...t, path, name: basename(path) };
      }).map((g) => {
        const activePath = g.activePath && movedPath(g.activePath, from, to);
        return activePath === g.activePath ? g : { ...g, activePath };
      });
      return withGroups(groups, s.activeGroup);
    }),

  toggleTool: (tool) =>
    set((s) =>
      sideOf(tool) === "left"
        ? { leftTool: s.leftTool === tool ? null : tool }
        : { rightTool: s.rightTool === tool ? null : tool },
    ),
  showTool: (tool) => set(sideOf(tool) === "left" ? { leftTool: tool } : { rightTool: tool }),
  placeTool: (tool, side) =>
    set((s) => {
      const wasOpen = s.leftTool === tool || s.rightTool === tool;
      const left = s.leftTool === tool ? null : s.leftTool;
      const right = s.rightTool === tool ? null : s.rightTool;
      if (!wasOpen) return { leftTool: left, rightTool: right };
      return side === "left" ? { leftTool: tool, rightTool: right } : { leftTool: left, rightTool: tool };
    }),
  toggleBottomTool: (tool) => set((s) => ({ bottomTool: s.bottomTool === tool ? null : tool })),
  setCursor: (cursor) => set({ cursor }),
  setStatus: (status) => set({ status }),
  filesChanged: () => set((s) => ({ fsVersion: s.fsVersion + 1 })),
}));
