import { create } from "zustand";
import { basename, movedPath } from "../lib/paths";

export type LeftTool = "project" | "commit" | "search" | "remote" | "extensions";
export type BottomTool = "terminal";

export interface EditorTab {
  path: string;
  name: string;
  dirty: boolean;
  /** Image URL shown instead of a file icon, e.g. an extension's icon on its page tab. */
  icon?: string;
}

/** A location to select once a file is shown, e.g. a search match. */
export interface RevealRequest {
  path: string;
  line: number;
  column: number;
  endColumn: number;
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
  tabs: EditorTab[];
  activePath: string | null;
  leftTool: LeftTool | null;
  bottomTool: BottomTool | null;
  cursor: CursorInfo | null;
  status: EditorStatus | null;
  /** Bumped when files may have changed on disk behind the tree's back (checkout, pull, ...). */
  fsVersion: number;
  reveal: RevealRequest | null;

  openFolder: (root: string) => void;
  closeFolder: () => void;
  /** Opens (or focuses) a tab; `name` defaults to the file name, for page tabs it is their title. */
  openFile: (path: string, name?: string, icon?: string) => void;
  setTabIcon: (path: string, icon: string) => void;
  /** Opens a file and selects `line`, from `column` to `endColumn` (1-based, UTF-16). */
  openFileAt: (path: string, line: number, column: number, endColumn: number) => void;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  setDirty: (path: string, dirty: boolean) => void;
  /** Re-points tabs at `from`, or inside it, after it was renamed to `to`. */
  renamePaths: (from: string, to: string) => void;
  toggleLeftTool: (tool: LeftTool) => void;
  /** Shows a tool window (without toggling it off when already shown). */
  setLeftTool: (tool: LeftTool) => void;
  toggleBottomTool: (tool: BottomTool) => void;
  setCursor: (cursor: CursorInfo | null) => void;
  setStatus: (status: EditorStatus | null) => void;
  filesChanged: () => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  tabs: [],
  activePath: null,
  leftTool: "project",
  bottomTool: null,
  cursor: null,
  status: null,
  fsVersion: 0,
  reveal: null,

  openFolder: (root) => set({ root, tabs: [], activePath: null, leftTool: "project" }),
  closeFolder: () => set({ root: null, tabs: [], activePath: null, cursor: null, status: null }),

  openFile: (path, name, icon) =>
    set((s) => ({
      tabs: s.tabs.some((t) => t.path === path)
        ? s.tabs
        : [...s.tabs, { path, name: name ?? basename(path), dirty: false, icon }],
      activePath: path,
    })),

  openFileAt: (path, line, column, endColumn) => {
    get().openFile(path);
    set((s) => ({ reveal: { path, line, column, endColumn, nonce: (s.reveal?.nonce ?? 0) + 1 } }));
  },

  setTabIcon: (path, icon) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path && t.icon !== icon ? { ...t, icon } : t)),
    })),

  closeTab: (path) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.path === path);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.path !== path);
      // Like IntelliJ, activate the tab to the left of the closed one.
      const activePath =
        s.activePath === path ? (tabs[Math.max(0, index - 1)]?.path ?? null) : s.activePath;
      return { tabs, activePath };
    }),

  setActive: (path) => set({ activePath: path }),

  setDirty: (path, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path && t.dirty !== dirty ? { ...t, dirty } : t)),
    })),

  renamePaths: (from, to) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        const path = movedPath(t.path, from, to);
        return path === t.path ? t : { ...t, path, name: basename(path) };
      }),
      activePath: s.activePath && movedPath(s.activePath, from, to),
    })),

  toggleLeftTool: (tool) => set((s) => ({ leftTool: s.leftTool === tool ? null : tool })),
  setLeftTool: (tool) => set({ leftTool: tool }),
  toggleBottomTool: (tool) => set((s) => ({ bottomTool: s.bottomTool === tool ? null : tool })),
  setCursor: (cursor) => set({ cursor }),
  setStatus: (status) => set({ status }),
  filesChanged: () => set((s) => ({ fsVersion: s.fsVersion + 1 })),
}));
