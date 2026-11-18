//! Breakpoints: kept per file and line, remembered across sessions, shared with
//! the extension host (`vscode.debug.breakpoints`) and sent to every running
//! debug session when they change.

import { create } from "zustand";
import * as rpc from "../exthost/rpc";

export interface BreakpointEntry {
  id: string;
  path: string;
  /** 1-based. */
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** What the debug adapters said about a breakpoint: verified or not, and where it really is. */
export interface BreakpointStatus {
  verified: boolean;
  line?: number;
  message?: string;
}

interface BreakpointsState {
  list: BreakpointEntry[];
  /** Status from the running sessions, by breakpoint id. */
  status: Record<string, BreakpointStatus>;
}

const STORAGE_KEY = "powercode.breakpoints";

function stored(): BreakpointEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((b) => typeof b?.path === "string" && typeof b?.line === "number") : [];
  } catch {
    return [];
  }
}

export const useBreakpoints = create<BreakpointsState>(() => ({ list: stored(), status: {} }));

let nextId = Date.now();
const changeListeners = new Set<(paths: Set<string>) => void>();

/** Called with the files whose breakpoints changed (to send them to the sessions). */
export function onBreakpointsChange(listener: (paths: Set<string>) => void) {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

function commit(list: BreakpointEntry[], changedPaths: Iterable<string>) {
  useBreakpoints.setState({ list });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Breakpoints just won't persist.
  }
  syncToHost();
  const paths = new Set(changedPaths);
  changeListeners.forEach((listener) => listener(paths));
}

export function syncToHost() {
  rpc.notify("debug/breakpoints", { breakpoints: useBreakpoints.getState().list });
}

export function breakpointsIn(path: string): BreakpointEntry[] {
  return useBreakpoints.getState().list.filter((b) => b.path === path);
}

export function toggleBreakpoint(path: string, line: number) {
  const { list } = useBreakpoints.getState();
  const existing = list.find((b) => b.path === path && b.line === line);
  commit(existing ? list.filter((b) => b !== existing) : [...list, { id: `b${nextId++}`, path, line, enabled: true }], [path]);
}

export function addBreakpoints(entries: (Omit<BreakpointEntry, "id"> & { id?: string })[]) {
  const { list } = useBreakpoints.getState();
  const added = entries
    .filter((e) => !list.some((b) => b.path === e.path && b.line === e.line))
    .map((e): BreakpointEntry => ({ ...e, id: e.id ?? `b${nextId++}` }));
  commit([...list, ...added], added.map((b) => b.path));
}

export function removeBreakpoints(ids: string[]) {
  const { list } = useBreakpoints.getState();
  const removed = list.filter((b) => ids.includes(b.id));
  commit(list.filter((b) => !ids.includes(b.id)), removed.map((b) => b.path));
}

export function updateBreakpoint(id: string, change: Partial<Omit<BreakpointEntry, "id" | "path">>) {
  const { list } = useBreakpoints.getState();
  const target = list.find((b) => b.id === id);
  if (!target) return;
  commit(list.map((b) => (b.id === id ? { ...b, ...change } : b)), [target.path]);
}

export function setAllEnabled(enabled: boolean) {
  const { list } = useBreakpoints.getState();
  commit(list.map((b) => ({ ...b, enabled })), list.map((b) => b.path));
}

/** Lines moved by edits (tracked through editor decorations). */
export function moveBreakpointLines(path: string, lines: Map<string, number>) {
  const { list } = useBreakpoints.getState();
  if (![...lines].some(([id, line]) => list.find((b) => b.id === id)?.line !== line)) return;
  commit(list.map((b) => (lines.has(b.id) ? { ...b, line: lines.get(b.id)! } : b)), [path]);
}

export function setBreakpointStatus(id: string, status: BreakpointStatus | undefined) {
  useBreakpoints.setState(({ status: all }) => {
    const next = { ...all };
    if (status) next[id] = status;
    else delete next[id];
    return { status: next };
  });
}

export function clearBreakpointStatus() {
  useBreakpoints.setState({ status: {} });
}
