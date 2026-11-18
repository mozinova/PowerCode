//! Quick picks and input boxes requested by extensions, shown one at a time.

import { create } from "zustand";

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  /** A group heading (`QuickPickItemKind.Separator`), not selectable. */
  separator?: boolean;
}

export interface QuickPickRequest {
  id: number;
  kind: "quickPick";
  items: QuickPickItem[];
  title?: string;
  placeHolder?: string;
  canPickMany: boolean;
  /** Indexes of the chosen items, or null when cancelled. */
  resolve: (picked: number[] | null) => void;
}

export interface InputBoxRequest {
  id: number;
  kind: "inputBox";
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  password: boolean;
  resolve: (value: string | null) => void;
}

export type DialogRequest = QuickPickRequest | InputBoxRequest;

let nextId = 1;

export const useHostDialogs = create<{ queue: DialogRequest[] }>(() => ({ queue: [] }));

export function showQuickPick(request: Omit<QuickPickRequest, "id" | "kind" | "resolve">): Promise<number[] | null> {
  return new Promise((resolve) => enqueue({ ...request, id: nextId++, kind: "quickPick", resolve }));
}

export function showInputBox(request: Omit<InputBoxRequest, "id" | "kind" | "resolve">): Promise<string | null> {
  return new Promise((resolve) => enqueue({ ...request, id: nextId++, kind: "inputBox", resolve }));
}

function enqueue(request: DialogRequest) {
  useHostDialogs.setState(({ queue }) => ({ queue: [...queue, request] }));
}

/** Closes the current dialog with `result` (null cancels). */
export function closeDialog(result: number[] | string | null) {
  const [current, ...rest] = useHostDialogs.getState().queue;
  if (!current) return;
  useHostDialogs.setState({ queue: rest });
  (current.resolve as (value: unknown) => void)(result);
}

/** Cancels every open dialog, e.g. when the host that asked is gone. */
export function cancelAllDialogs() {
  const queue = useHostDialogs.getState().queue;
  useHostDialogs.setState({ queue: [] });
  queue.forEach((request) => request.resolve(null));
}
