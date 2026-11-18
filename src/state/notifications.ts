import { create } from "zustand";
import { track } from "./activity";

export type NotificationKind = "info" | "success" | "error" | "progress";

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  message?: string;
  /** Buttons; clicking one calls `onAction` with its index and dismisses the balloon. */
  actions?: string[];
  onAction?: (index: number) => void;
  /** Called when the balloon is closed without an action. */
  onDismiss?: () => void;
}

/** Errors stay until dismissed; progress stays until replaced. */
const AUTO_DISMISS_MS: Partial<Record<NotificationKind, number>> = { info: 5000, success: 4000 };

let nextId = 1;

export const useNotifications = create<{ items: Notification[] }>(() => ({ items: [] }));

export function dismiss(id: number) {
  const item = useNotifications.getState().items.find((n) => n.id === id);
  useNotifications.setState(({ items }) => ({ items: items.filter((n) => n.id !== id) }));
  item?.onDismiss?.();
}

/** Runs action `index` of a balloon and closes it. */
export function runAction(id: number, index: number) {
  const item = useNotifications.getState().items.find((n) => n.id === id);
  useNotifications.setState(({ items }) => ({ items: items.filter((n) => n.id !== id) }));
  item?.onAction?.(index);
}

/**
 * Shows a balloon with buttons and resolves with the index of the one clicked,
 * or null when it is dismissed. It stays until one of those happens.
 */
export function ask(kind: NotificationKind, title: string, message: string | undefined, actions: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    const item: Notification = { id, kind, title, message, actions, onAction: resolve, onDismiss: () => resolve(null) };
    useNotifications.setState(({ items }) => ({ items: [...items, item] }));
  });
}

export function notify(kind: NotificationKind, title: string, message?: string): number {
  const id = nextId++;
  useNotifications.setState(({ items }) => ({ items: [...items, { id, kind, title, message }] }));
  const timeout = AUTO_DISMISS_MS[kind];
  if (timeout) window.setTimeout(() => dismiss(id), timeout);
  return id;
}

/**
 * Shows `title…` while `task` runs, then its success or error. `onError` may
 * report an error itself (e.g. with a fix to offer); it returns whether it did.
 */
export async function withProgress<T>(
  title: string,
  task: () => Promise<T>,
  done?: (result: T) => { title: string; message?: string } | null,
  onError?: (title: string, message: string) => boolean,
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
    const message = e instanceof Error ? e.message : String(e);
    if (!onError?.(`${title} failed`, message)) notify("error", `${title} failed`, message);
    return undefined;
  }
}
