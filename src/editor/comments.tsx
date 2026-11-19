//! Extensions' comment threads in the editor: each thread is a view zone under
//! its last line, with the comments, the extension's actions and a reply box.
//! Lines an extension allows commenting on get a "+" in the gutter.

import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActionButton, execute, menuEntries, MoreActions, useWhenContext } from "../components/ExtensionViews";
import { ExtIcon } from "../components/ExtIcon";
import { menuItems } from "../exthost/contributions";
import {
  commentArg,
  commentingRanges,
  discardThread,
  setThreadCollapsed,
  startThread,
  useComments,
  type CommentInfo,
  type CommentThreadInfo,
} from "../exthost/comments";
import { pathFromUri } from "../exthost/languages";
import { isTrue, useContributions } from "../exthost/views";
import { monaco } from "./monaco";

function Avatar({ icon }: { icon: CommentInfo["authorIcon"] }) {
  if (!icon) return <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[10px] text-fg-muted">?</span>;
  if ("themeIcon" in icon) return <ExtIcon icon={{ codicon: icon.themeIcon, color: icon.color }} size={16} />;
  const url = "localPath" in icon ? convertFileSrc(icon.localPath) : icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
  return <img src={url} alt="" className="size-5 shrink-0 rounded-full" />;
}

function Body({ comment }: { comment: CommentInfo }) {
  if (!comment.markdown) return <p className="whitespace-pre-wrap">{comment.body}</p>;
  // From the extension (often from a server): sanitized before rendering.
  const html = DOMPurify.sanitize(marked.parse(comment.body, { async: false }));
  return <div className="markdown-body text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Comment({ thread, comment, controllerId }: { thread: CommentThreadInfo; comment: CommentInfo; controllerId: string }) {
  const contributions = useContributions();
  const context = { commentController: controllerId, commentThread: thread.contextValue ?? "", comment: comment.contextValue ?? "" };
  const title = menuItems(contributions, "comments/comment/title", (when) => isTrue(when, context));
  const args = [commentArg(thread.handle, { comment: comment.index })];
  return (
    <div className="flex gap-2 py-1.5">
      <Avatar icon={comment.authorIcon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-fg">{comment.author}</span>
          {comment.label && <span className="text-fg-subtle">{comment.label}</span>}
          {comment.timestamp && <span className="text-fg-subtle">{new Date(comment.timestamp).toLocaleString()}</span>}
          <span className="flex-1" />
          {[...title.inline, ...title.other.flat()].map((item) => (
            <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
          ))}
        </div>
        <Body comment={comment} />
      </div>
    </div>
  );
}

function ThreadWidget({ handle }: { handle: number }) {
  useWhenContext();
  const thread = useComments((s) => s.threads[handle]);
  const controller = useComments((s) => (thread ? s.controllers[thread.controller] : undefined));
  const fresh = useComments((s) => s.fresh === handle);
  const contributions = useContributions();
  const [reply, setReply] = useState("");
  const replyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (fresh) {
      replyRef.current?.focus();
      useComments.setState({ fresh: null });
    }
  }, [fresh]);
  if (!thread || !controller) return null;

  const empty = thread.comments.length === 0;
  const context = { commentController: controller.id, commentThread: thread.contextValue ?? "", commentThreadIsEmpty: empty };
  const title = menuItems(contributions, "comments/commentThread/title", (when) => isTrue(when, context));
  // The reply box's buttons ("Reply", "Start Review", ...) are the extension's commands.
  const submit = menuItems(contributions, "comments/commentThread/context", (when) => isTrue(when, context));
  const buttons = [...submit.inline, ...submit.other.flat()];
  const threadArgs = [commentArg(handle)];
  const send = (command: string) => {
    execute(command, [commentArg(handle, { reply })]);
    setReply("");
  };
  const heading = thread.label ?? (empty ? "New comment" : `${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`);

  return (
    <div className="my-1 mr-4 rounded-md border border-line-soft bg-panel text-fg shadow-sm">
      <div className="flex h-7 items-center gap-1.5 border-b border-line-soft px-2 text-xs">
        <button
          type="button"
          onClick={() => setThreadCollapsed(handle, !thread.collapsed)}
          className="flex min-w-0 items-center gap-1.5 text-fg-muted hover:text-fg"
        >
          {thread.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <MessageSquare size={13} />
          <span className="truncate font-medium text-fg">{heading}</span>
        </button>
        {thread.resolved !== undefined && (
          <span className={`rounded px-1.5 ${thread.resolved ? "bg-[#5fb865]/20 text-[#5fb865]" : "bg-hover text-fg-muted"}`}>
            {thread.resolved ? "Resolved" : "Unresolved"}
          </span>
        )}
        <span className="flex-1" />
        {title.inline.map((item) => (
          <ActionButton key={item.command} contributions={contributions} item={item} args={threadArgs} />
        ))}
        <MoreActions entries={menuEntries(contributions, title.other, threadArgs)} />
      </div>
      {!thread.collapsed && (
        <div className="px-3 py-1">
          {thread.comments.map((comment) => (
            <Comment key={comment.index} thread={thread} comment={comment} controllerId={controller.id} />
          ))}
          {thread.canReply && (
            <div className="flex flex-col gap-1.5 py-1.5">
              <textarea
                ref={replyRef}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && reply.trim() && buttons[0]) {
                    e.preventDefault();
                    send(buttons[0].command);
                  }
                  if (e.key === "Escape" && empty) discardThread(handle);
                }}
                placeholder={controller.placeholder ?? (empty ? "Add a comment (Ctrl+Enter)" : "Reply (Ctrl+Enter)")}
                rows={reply.includes("\n") ? 4 : 2}
                className="w-full resize-y rounded-md border border-input-border bg-input px-2 py-1 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
              />
              <div className="flex justify-end gap-1.5">
                {empty && (
                  <button type="button" onClick={() => discardThread(handle)} className="h-7 rounded-md px-3 text-fg-muted hover:bg-hover">
                    Cancel
                  </button>
                )}
                {buttons.map((item, i) => (
                  <button
                    key={item.command}
                    type="button"
                    disabled={!reply.trim()}
                    onClick={() => send(item.command)}
                    className={`h-7 rounded-md px-3 font-medium disabled:opacity-50 ${i === 0 ? "bg-accent text-white hover:bg-accent-hover" : "border border-input-border hover:bg-hover"}`}
                  >
                    {contributions.commands.get(item.command)?.title ?? item.command}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface Zone {
  id: string;
  zone: monaco.editor.IViewZone;
  node: HTMLDivElement;
  root: Root;
  afterLine: number;
  observers: { disconnect(): void }[];
}

const RANGES_DELAY_MS = 600;

/** Shows the comment threads of the editor's file, and the gutter "+" where comments can start. */
export function attachComments(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const zones = new Map<number, Zone>();
  const rangeDecorations = editor.createDecorationsCollection();
  /** Lines (1-based) where a thread can start, with the controller that allows it. */
  let commentable = new Map<number, number>();

  const width = () => {
    const layout = editor.getLayoutInfo();
    return `${Math.max(240, layout.contentWidth - layout.verticalScrollbarWidth - 8)}px`;
  };

  const removeZone = (handle: number) => {
    const z = zones.get(handle);
    if (!z) return;
    zones.delete(handle);
    z.observers.forEach((o) => o.disconnect());
    editor.changeViewZones((a) => a.removeZone(z.id));
    // Not during React's render of another root.
    queueMicrotask(() => z.root.unmount());
  };

  const sync = () => {
    const model = editor.getModel();
    const uri = model?.uri.toString();
    const threads = Object.values(useComments.getState().threads).filter((t) => t.uri === uri);
    const wanted = new Map(threads.map((t) => [t.handle, t.range ? t.range.end.line + 1 : 0]));
    for (const handle of [...zones.keys()]) if (wanted.get(handle) !== zones.get(handle)!.afterLine) removeZone(handle);
    for (const [handle, afterLine] of wanted) {
      if (zones.has(handle)) continue;
      const node = document.createElement("div");
      node.style.width = width();
      // The widget handles its own clicks and keys (the reply box), not the editor.
      for (const type of ["mousedown", "keydown", "keypress", "wheel"] as const) {
        node.addEventListener(type, (e) => e.stopPropagation());
      }
      const zone: monaco.editor.IViewZone = { afterLineNumber: afterLine, heightInPx: 36, domNode: node, suppressMouseDown: true };
      let id = "";
      editor.changeViewZones((a) => {
        id = a.addZone(zone);
      });
      const root = createRoot(node);
      root.render(<ThreadWidget handle={handle} />);
      // The zone takes the widget's height, which changes with its content. Monaco fixes the
      // zone node's height, so the widget inside it is measured (whichever element React put there).
      const resize = new ResizeObserver(() => {
        const height = (node.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
        if (height > 0 && Math.abs(height + 8 - (zone.heightInPx ?? 0)) > 1) {
          zone.heightInPx = height + 8;
          editor.changeViewZones((a) => a.layoutZone(id));
        }
      });
      const children = new MutationObserver(() => {
        resize.disconnect();
        if (node.firstElementChild) resize.observe(node.firstElementChild);
      });
      children.observe(node, { childList: true });
      zones.set(handle, { id, zone, node, root, afterLine, observers: [resize, children] });
    }
  };

  let rangesTimer: number | undefined;
  const refreshRanges = () => {
    window.clearTimeout(rangesTimer);
    rangesTimer = window.setTimeout(async () => {
      const model = editor.getModel();
      if (!model || !/^(file|ssh):/.test(model.uri.scheme)) {
        commentable = new Map();
        rangeDecorations.clear();
        return;
      }
      const uri = model.uri.toString();
      const results = await commentingRanges(uri);
      if (editor.getModel()?.uri.toString() !== uri) return;
      commentable = new Map();
      for (const { controller, ranges } of results) {
        for (const r of ranges) for (let line = r.start.line + 1; line <= r.end.line + 1; line++) if (!commentable.has(line)) commentable.set(line, controller);
      }
      rangeDecorations.set(
        [...commentable.keys()].map((line) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: { linesDecorationsClassName: "pc-comment-range" },
        })),
      );
    }, RANGES_DELAY_MS);
  };

  const listeners = [
    editor.onDidChangeModel(() => {
      for (const handle of [...zones.keys()]) removeZone(handle);
      sync();
      refreshRanges();
    }),
    editor.onDidChangeModelContent(refreshRanges),
    editor.onDidLayoutChange(() => {
      for (const z of zones.values()) z.node.style.width = width();
    }),
    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber;
      const controller = line === undefined ? undefined : commentable.get(line);
      const model = editor.getModel();
      if (line === undefined || controller === undefined || !model) return;
      void startThread(controller, model.uri.toString(), line - 1);
    }),
  ];
  const unsubscribe = useComments.subscribe((s, previous) => {
    if (s.threads !== previous.threads) sync();
    if (s.controllers !== previous.controllers) refreshRanges();
  });
  sync();
  refreshRanges();

  return {
    dispose() {
      window.clearTimeout(rangesTimer);
      unsubscribe();
      listeners.forEach((l) => l.dispose());
      for (const handle of [...zones.keys()]) removeZone(handle);
      rangeDecorations.clear();
    },
  };
}
