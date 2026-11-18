//! Background work shown in the status bar (loading extensions, reading the
//! Git repository, indexing files, ...).

import { create } from "zustand";

export interface Activity {
  id: number;
  label: string;
}

/** Quick tasks finish before this and never show, so routine polling does not flicker. */
const SHOW_AFTER_MS = 300;

let nextId = 1;

export const useActivity = create<{ tasks: Activity[] }>(() => ({ tasks: [] }));

/** Runs `task`, listing it as `label` in the status bar while it takes a noticeable time. */
export async function track<T>(label: string, task: () => Promise<T>): Promise<T> {
  const id = nextId++;
  const timer = window.setTimeout(() => {
    useActivity.setState(({ tasks }) => ({ tasks: [...tasks, { id, label }] }));
  }, SHOW_AFTER_MS);
  try {
    return await task();
  } finally {
    window.clearTimeout(timer);
    useActivity.setState(({ tasks }) => ({ tasks: tasks.filter((t) => t.id !== id) }));
  }
}
