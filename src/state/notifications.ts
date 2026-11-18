import { create } from "zustand";
import { track } from "./activity";

export type NotificationKind = "info" | "success" | "error" | "progress";

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  message?: string;
}

/** Errors stay until dismissed; progress stays until replaced. */
const AUTO_DISMISS_MS: Partial<Record<NotificationKind, number>> = { info: 5000, success: 4000 };

let nextId = 1;

export const useNotifications = create<{ items: Notification[] }>(() => ({ items: [] }));

export function dismiss(id: number) {
  useNotifications.setState(({ items }) => ({ items: items.filter((n) => n.id !== id) }));
}

export function notify(kind: NotificationKind, title: string, message?: string): number {
  const id = nextId++;
  useNotifications.setState(({ items }) => ({ items: [...items, { id, kind, title, message }] }));
  const timeout = AUTO_DISMISS_MS[kind];
  if (timeout) window.setTimeout(() => dismiss(id), timeout);
  return id;
}

/** Shows `title…` while `task` runs, then its success or error. */
export async function withProgress<T>(
  title: string,
  task: () => Promise<T>,
  done?: (result: T) => { title: string; message?: string } | null,
): Promise<T | undefined> {
  const progress = notify("progress", `${title}…`);
  try {
    const result = await track(`${title}…`, task);
    dismiss(progress);
    const summary = done?.(result);
    if (summary) notify("success", summary.title, summary.message);
    return result;
  } catch (e) {
    dismiss(progress);
    notify("error", `${title} failed`, e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
