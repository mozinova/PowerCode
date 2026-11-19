//! `vscode.comments`: review comments of extensions (pull requests, code review
//! tools). The UI shows each thread under its lines in the editor, with a reply
//! box whose buttons are the extension's `comments/commentThread/context` menu,
//! and a "+" in the gutter on the lines the extension allows commenting on.

import { documentFor } from "./documents";
import * as dto from "./dto";
import * as rpc from "./rpc";
import { CancellationTokenSource, CommentThreadCollapsibleState, MarkdownString, Range, Uri } from "./types";
import { iconDto } from "./views";

interface Controller {
  handle: number;
  api: any;
}

interface Thread {
  handle: number;
  controller: Controller;
  api: any;
  state: Record<string, any>;
}

const controllers = new Map<number, Controller>();
const threads = new Map<number, Thread>();
let nextHandle = 1;

const text = (value: unknown) => (value instanceof MarkdownString ? value.value : typeof value === "string" ? value : String((value as { value?: unknown })?.value ?? ""));

function commentDto(comment: any, index: number) {
  return {
    index,
    body: text(comment.body),
    // Plain strings are shown as text, MarkdownStrings rendered.
    markdown: comment.body instanceof MarkdownString || typeof comment.body?.value === "string",
    author: comment.author?.name ?? "",
    authorIcon: comment.author?.iconPath ? iconDto(comment.author.iconPath) : undefined,
    label: comment.label,
    contextValue: comment.contextValue,
    timestamp: comment.timestamp instanceof Date ? comment.timestamp.toISOString() : undefined,
  };
}

const pending = new Set<number>();

function schedule(thread: Thread) {
  if (pending.has(thread.handle)) return;
  pending.add(thread.handle);
  queueMicrotask(() => {
    pending.delete(thread.handle);
    if (threads.has(thread.handle)) send(thread);
  });
}

function send(thread: Thread) {
  const s = thread.state;
  rpc.notify("comments/thread", {
    handle: thread.handle,
    controller: thread.controller.handle,
    uri: s.uri.toString(),
    range: s.range ? dto.range(s.range) : undefined,
    label: s.label,
    contextValue: s.contextValue,
    collapsed: s.collapsibleState !== CommentThreadCollapsibleState.Expanded,
    canReply: s.canReply !== false,
    resolved: s.state === undefined ? undefined : s.state === 1,
    comments: (s.comments ?? []).map(commentDto),
  });
}

function createThread(controller: Controller, uri: Uri, range: Range | undefined, comments: readonly unknown[]) {
  const handle = nextHandle++;
  const state: Record<string, any> = {
    uri,
    range,
    comments: [...comments],
    collapsibleState: CommentThreadCollapsibleState.Collapsed,
    canReply: true,
    contextValue: undefined,
    label: undefined,
    state: undefined,
  };
  const thread: Thread = { handle, controller, api: undefined, state };
  thread.api = new Proxy(state, {
    get(target, key) {
      if (key === "dispose") {
        return () => {
          threads.delete(handle);
          rpc.notify("comments/threadDisposed", { handle });
        };
      }
      return target[key as string];
    },
    set(target, key, value) {
      target[key as string] = key === "comments" ? [...(value ?? [])] : value;
      schedule(thread);
      return true;
    },
  });
  threads.set(handle, thread);
  schedule(thread);
  return thread;
}

export function createCommentController(id: string, label: string) {
  const handle = nextHandle++;
  const controller: Controller = { handle, api: undefined };
  const announce = () =>
    rpc.notify("comments/controller", {
      handle,
      id,
      label,
      hasCommentingRanges: typeof controller.api.commentingRangeProvider?.provideCommentingRanges === "function",
      placeholder: controller.api.options?.placeHolder,
      prompt: controller.api.options?.prompt,
    });
  const api: any = new Proxy(
    {
      id,
      label,
      options: undefined,
      commentingRangeProvider: undefined,
      reactionHandler: undefined,
      createCommentThread: (uri: Uri, range: Range, comments: readonly unknown[]) => createThread(controller, uri, range, comments).api,
      dispose() {
        controllers.delete(handle);
        for (const [threadHandle, thread] of threads) if (thread.controller === controller) threads.delete(threadHandle);
        rpc.notify("comments/controllerDisposed", { handle });
      },
    } as Record<string, any>,
    {
      set(target, key, value) {
        target[key as string] = value;
        if (key === "commentingRangeProvider" || key === "options") announce();
        return true;
      },
    },
  );
  controller.api = api;
  controllers.set(handle, controller);
  announce();
  return api;
}

/** What a comments argument from the UI stands for (menu commands get these). */
export function commentElement(ref: { thread: number; comment?: number; reply?: string }): unknown {
  const thread = threads.get(ref.thread);
  if (!thread) return undefined;
  if (ref.reply !== undefined) return { thread: thread.api, text: ref.reply };
  if (ref.comment !== undefined) return thread.state.comments[ref.comment];
  return thread.api;
}

export function listen() {
  rpc.onRequest("comments/ranges", async (params: { controller: number; uri: string }) => {
    const provider = controllers.get(params.controller)?.api.commentingRangeProvider;
    const document = documentFor(params.uri);
    if (!provider || !document) return [];
    const result = await provider.provideCommentingRanges(document, new CancellationTokenSource().token);
    // Either ranges, or `{ ranges, enableFileComments }`.
    const ranges: Range[] = Array.isArray(result) ? result : (result?.ranges ?? []);
    return ranges.map(dto.range);
  });
  // A thread the user starts from the gutter: empty until they submit their comment.
  rpc.onRequest("comments/newThread", async (params: { controller: number; uri: string; line: number }) => {
    const controller = controllers.get(params.controller);
    if (!controller) return null;
    const thread = createThread(controller, Uri.parse(params.uri), new Range(params.line, 0, params.line, 0), []);
    thread.state.collapsibleState = CommentThreadCollapsibleState.Expanded;
    send(thread);
    return thread.handle;
  });
  rpc.onNotification("comments/collapse", (params: { thread: number; collapsed: boolean }) => {
    const thread = threads.get(params.thread);
    // The user's choice; not sent back.
    if (thread) thread.state.collapsibleState = params.collapsed ? CommentThreadCollapsibleState.Collapsed : CommentThreadCollapsibleState.Expanded;
  });
  rpc.onNotification("comments/discard", (params: { thread: number }) => {
    const thread = threads.get(params.thread);
    if (thread && (thread.state.comments ?? []).length === 0) thread.api.dispose();
  });
}
