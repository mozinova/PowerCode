//! Which sidebar each tool window's stripe entry is in, and in what order. The
//! user arranges them by dragging; tools never arranged go to their default
//! side (the left, or the right for extensions' `secondarySidebar` containers).

import { create } from "zustand";

export type Side = "left" | "right";

const STORAGE_KEY = "powercode.toolLayout";

interface ToolLayout {
  /** Tools the user placed, in stripe order. */
  left: string[];
  right: string[];
  /** Tools that start in the right sidebar until placed. */
  rightDefaults: string[];
}

function stored(): Pick<ToolLayout, "left" | "right"> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      left: Array.isArray(value.left) ? value.left.filter((id: unknown) => typeof id === "string") : [],
      right: Array.isArray(value.right) ? value.right.filter((id: unknown) => typeof id === "string") : [],
    };
  } catch {
    return { left: [], right: [] };
  }
}

export const useToolLayout = create<ToolLayout>(() => ({ ...stored(), rightDefaults: [] }));

export function sideOf(id: string): Side {
  const { left, right, rightDefaults } = useToolLayout.getState();
  if (left.includes(id)) return "left";
  if (right.includes(id)) return "right";
  return rightDefaults.includes(id) ? "right" : "left";
}

export function setRightDefaults(ids: string[]) {
  const current = useToolLayout.getState().rightDefaults;
  if (ids.length === current.length && ids.every((id, i) => id === current[i])) return;
  useToolLayout.setState({ rightDefaults: ids });
}

/** The tools of `all` (in their natural order) that belong to `side`, in stripe order. */
export function arrange(all: string[], side: Side, layout: ToolLayout = useToolLayout.getState()): string[] {
  const placed = layout[side];
  const mine = all.filter((id) => sideOf(id) === side);
  const rank = (id: string) => (placed.includes(id) ? placed.indexOf(id) : placed.length + mine.indexOf(id));
  return [...mine].sort((a, b) => rank(a) - rank(b));
}

/**
 * Moves `id` to position `index` of `side`. `shown` are both stripes as
 * currently displayed, so the order the user sees becomes the stored one.
 */
export function moveTool(id: string, side: Side, index: number, shown: Record<Side, string[]>) {
  const left = shown.left.filter((t) => t !== id);
  const right = shown.right.filter((t) => t !== id);
  const target = side === "left" ? left : right;
  target.splice(Math.max(0, Math.min(index, target.length)), 0, id);
  // Keep placements of tools not shown now (e.g. an extension that is disabled for a while).
  const { left: oldLeft, right: oldRight } = useToolLayout.getState();
  const keep = (old: string[], next: string[], other: string[]) => [
    ...next,
    ...old.filter((t) => !next.includes(t) && !other.includes(t) && t !== id),
  ];
  const next = { left: keep(oldLeft, left, right), right: keep(oldRight, right, left) };
  useToolLayout.setState(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The arrangement just won't persist.
  }
}
