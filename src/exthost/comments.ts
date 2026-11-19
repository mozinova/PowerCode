//! Extensions' comment threads as the UI knows them (sent by the host whenever a
//! thread changes, see ext-host/src/comments.ts), and the requests the editor
//! makes: commenting ranges, starting a thread, collapsing, discarding.

import { create } from "zustand";
import * as rpc from "./rpc";

export interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface CommentInfo {
  index: number;
  body: string;
  markdown: boolean;
  author: string;
  authorIcon?: { themeIcon: string; color?: string } | { uri: string } | { localPath: string };
  label?: string;
  contextValue?: string;
  timestamp?: string;
}

export interface CommentThreadInfo {
  handle: number;
  controller: number;
  uri: string;
  range?: RangeDto;
  label?: string;
  contextValue?: string;
  collapsed: boolean;
  canReply: boolean;
  /** undefined: the extension does not track resolution. */
  resolved?: boolean;
  comments: CommentInfo[];
}

export interface CommentControllerInfo {
  handle: number;
  id: string;
  label: string;
  hasCommentingRanges: boolean;
  placeholder?: string;
  prompt?: string;
}

interface CommentsState {
  controllers: Record<number, CommentControllerInfo>;
  threads: Record<number, CommentThreadInfo>;
  /** Threads the user just started from the gutter: their reply box gets focus. */
  fresh: number | null;
}

export const useComments = create<CommentsState>(() => ({ controllers: {}, threads: {}, fresh: null }));

/** The argument menu commands get: the thread, one of its comments, or a reply (`CommentReply`). */
export const commentArg = (thread: number, extra: { comment?: number; reply?: string } = {}) => ({ $comment: { thread, ...extra } });

/** Lines (0-based ranges) of `uri` where each controller allows new comments. */
export async function commentingRanges(uri: string): Promise<{ controller: number; ranges: RangeDto[] }[]> {
  const controllers = Object.values(useComments.getState().controllers).filter((c) => c.hasCommentingRanges);
  return Promise.all(
    controllers.map(async (c) => ({
      controller: c.handle,
      ranges: await rpc.request<RangeDto[]>("comments/ranges", { controller: c.handle, uri }).catch(() => []),
    })),
  );
}

/** Starts an empty thread at `line` (0-based); it shows with its reply box open. */
export async function startThread(controller: number, uri: string, line: number) {
  const handle = await rpc.request<number | null>("comments/newThread", { controller, uri, line });
  if (handle !== null) useComments.setState({ fresh: handle });
}

export function setThreadCollapsed(thread: number, collapsed: boolean) {
  useComments.setState(({ threads }) => (threads[thread] ? { threads: { ...threads, [thread]: { ...threads[thread], collapsed } } } : {}));
  rpc.notify("comments/collapse", { thread, collapsed });
}

/** Cancels a thread the user started but did not post to. */
export function discardThread(thread: number) {
  rpc.notify("comments/discard", { thread });
}

export function registerCommentHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("comments/controller", (controller: CommentControllerInfo) =>
    useComments.setState(({ controllers }) => ({ controllers: { ...controllers, [controller.handle]: controller } })),
  );
  onNotification("comments/controllerDisposed", ({ handle }) =>
    useComments.setState(({ controllers, threads }) => {
      const { [handle]: _gone, ...rest } = controllers;
      return { controllers: rest, threads: Object.fromEntries(Object.entries(threads).filter(([, t]) => t.controller !== handle)) };
    }),
  );
  onNotification("comments/thread", (thread: CommentThreadInfo) =>
    useComments.setState(({ threads }) => ({ threads: { ...threads, [thread.handle]: thread } })),
  );
  onNotification("comments/threadDisposed", ({ handle }) =>
    useComments.setState(({ threads }) => {
      const { [handle]: _gone, ...rest } = threads;
      return { threads: rest };
    }),
  );
}

export function resetComments() {
  useComments.setState({ controllers: {}, threads: {}, fresh: null });
}
