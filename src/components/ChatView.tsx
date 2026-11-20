//! The Chat tool window: talk to the chat participants extensions offer (`@name`,
//! `/command`), answered with the language model picked at the top.

import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { FileText, Loader2, MessageSquarePlus, Minus, SendHorizontal, Square } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  cancelChat,
  clearChat,
  parsePrompt,
  runChatButton,
  sendChat,
  setChatModel,
  useChat,
  type ChatParticipantInfo,
  type ChatPart,
  type ChatTurn,
} from "../exthost/chat";
import { pathFromUri } from "../exthost/languages";
import { basename } from "../lib/paths";
import { useWorkspace } from "../state/workspace";
import { ExtIcon } from "./ExtIcon";
import { Select } from "./Select";
import { IconButton, ToolWindowHeader } from "./ui";

/** Links in answers: web pages open in the browser, nothing navigates the app. */
function onAnswerClick(e: MouseEvent) {
  const link = (e.target as Element).closest("a");
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) void openUrl(href);
}

export function Markdown({ text }: { text: string }) {
  // From an extension (often a model's output): sanitized before rendering.
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text]);
  return <div onClick={onAnswerClick} className="markdown-body min-w-0 text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />;
}

function openPart(uri?: string, line?: number) {
  if (!uri) return;
  if (!/^(file|ssh):/.test(uri)) {
    if (/^https?:/.test(uri)) void openUrl(uri);
    return;
  }
  const path = pathFromUri(uri);
  const { openFile, openFileAt } = useWorkspace.getState();
  if (line !== undefined) openFileAt(path, line + 1, 1, 1);
  else openFile(path);
}

function FileTree({ tree, depth = 0 }: { tree: { name: string; children?: unknown[] }[]; depth?: number }) {
  return (
    <>
      {tree.map((node, i) => (
        <div key={i}>
          <div style={{ paddingLeft: depth * 12 }} className="text-xs text-fg-muted">
            {node.children ? "▾ " : ""}
            {node.name}
          </div>
          {node.children && <FileTree tree={node.children as { name: string; children?: unknown[] }[]} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function Part({ part, done }: { part: ChatPart; done: boolean }) {
  switch (part.kind) {
    case "markdown":
      return <Markdown text={part.value} />;
    case "progress":
      return (
        <div className="flex items-center gap-1.5 text-xs text-fg-muted">
          {!done && <Loader2 size={12} className="animate-spin" />}
          {part.value}
        </div>
      );
    case "button":
      return (
        <button
          type="button"
          onClick={() => void runChatButton(part.id)}
          className="h-7 w-fit rounded-md bg-accent px-3 text-xs font-medium text-white hover:bg-accent-hover"
        >
          {part.title}
        </button>
      );
    case "anchor":
    case "reference": {
      const name = part.title ?? (part.uri ? basename(part.uri.replace(/[?#].*$/, "")) : "");
      return (
        <button
          type="button"
          onClick={() => openPart(part.uri, part.range?.start.line)}
          className="flex w-fit max-w-full items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-xs text-fg hover:bg-selected"
        >
          <FileText size={12} className="shrink-0 text-fg-muted" />
          <span className="truncate">{decodeURIComponent(name)}</span>
        </button>
      );
    }
    case "filetree":
      return (
        <div className="rounded border border-line-soft p-2">
          <FileTree tree={part.tree} />
        </div>
      );
  }
}

function ParticipantIcon({ participant }: { participant?: ChatParticipantInfo }) {
  const icon = participant?.icon;
  if (icon && "themeIcon" in icon) return <ExtIcon icon={{ codicon: icon.themeIcon, color: icon.color }} size={14} />;
  if (icon) {
    const url = "localPath" in icon ? convertFileSrc(icon.localPath) : icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
    return <img src={url} alt="" className="size-4 rounded" />;
  }
  return <span className="flex size-4 items-center justify-center rounded bg-accent/30 text-[10px] font-semibold text-fg">@</span>;
}

function Turn({ turn, onFollowup }: { turn: ChatTurn; onFollowup: (text: string) => void }) {
  const participant = useChat((s) => s.participants.find((p) => p.id === turn.participant));
  const name = participant?.name ?? turn.participant;
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="ml-6 self-end rounded-lg bg-selected px-2.5 py-1.5 whitespace-pre-wrap">
        <span className="text-accent-hover">@{name}</span>
        {turn.command && <span className="text-accent-hover"> /{turn.command}</span>} {turn.prompt}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
          <ParticipantIcon participant={participant} />
          {participant?.fullName ?? name}
          {!turn.done && <Loader2 size={12} className="animate-spin" />}
        </div>
        {turn.parts.map((part, i) => (
          <Part key={i} part={part} done={turn.done} />
        ))}
        {turn.error && <p className="text-danger">{turn.error}</p>}
        {turn.done &&
          turn.followups?.map((f, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onFollowup(`@${name} ${f.command ? `/${f.command} ` : ""}${f.prompt}`)}
              className="w-fit rounded-md border border-input-border px-2 py-0.5 text-left text-xs hover:bg-hover"
            >
              {f.label ?? f.prompt}
            </button>
          ))}
      </div>
    </div>
  );
}

/** `@` and `/` completions above the input. */
function Suggestions({ text, onPick }: { text: string; onPick: (value: string) => void }) {
  const participants = useChat((s) => s.participants);
  const mention = /^@([\w.-]*)$/.exec(text);
  if (mention) {
    const list = participants.filter((p) => p.name.startsWith(mention[1]));
    if (list.length === 0) return null;
    return (
      <div className="mb-1 rounded-md border border-line-soft bg-panel p-1">
        {list.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(`@${p.name} `)} className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-hover">
            <span className="font-medium">@{p.name}</span>
            <span className="truncate text-xs text-fg-subtle">{p.description}</span>
          </button>
        ))}
      </div>
    );
  }
  const slash = /^(@[\w.-]+\s+)?\/([\w.-]*)$/.exec(text);
  if (slash) {
    const { participant } = parsePrompt(slash[1] ?? "");
    const list = (participant?.commands ?? []).filter((c) => c.name.startsWith(slash[2]));
    if (list.length === 0) return null;
    return (
      <div className="mb-1 rounded-md border border-line-soft bg-panel p-1">
        {list.map((c) => (
          <button key={c.name} type="button" onClick={() => onPick(`${slash[1] ?? ""}/${c.name} `)} className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-hover">
            <span className="font-medium">/{c.name}</span>
            <span className="truncate text-xs text-fg-subtle">{c.description}</span>
          </button>
        ))}
      </div>
    );
  }
  return null;
}

export function ChatView() {
  const participants = useChat((s) => s.participants);
  const models = useChat((s) => s.models);
  const model = useChat((s) => s.model);
  const turns = useChat((s) => s.turns);
  const busy = turns.some((t) => !t.done);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fallback = participants.find((p) => p.isDefault) ?? (participants.length === 1 ? participants[0] : undefined);

  // Follows the answer as it streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  const send = async (value = text) => {
    if (!value.trim() || busy) return;
    setNotice(null);
    if (await sendChat(value)) setText("");
    else setNotice("Mention a participant with @, e.g. " + participants.map((p) => `@${p.name}`).join(", "));
  };

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Chat">
        <IconButton icon={MessageSquarePlus} title="New Chat" onClick={clearChat} className="size-7" size={14} />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("chat")} className="size-7" />
      </ToolWindowHeader>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto select-text">
        {turns.length === 0 && (
          <div className="flex flex-col gap-2 px-3 py-2 text-fg-muted">
            {participants.length === 0 ? (
              <p>No extension offers chat yet. Chat extensions add participants here, answered by the language models extensions provide.</p>
            ) : (
              <>
                <p>Ask {fallback ? `@${fallback.name}` : "a participant"} something. Type @ to pick a participant, / for its commands.</p>
                {participants.map((p) => (
                  <button key={p.id} type="button" onClick={() => setText(`@${p.name} `)} className="flex items-baseline gap-2 text-left hover:text-fg">
                    <span className="font-medium text-fg">@{p.name}</span>
                    <span className="truncate text-xs">{p.description}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {turns.map((turn) => (
          <Turn key={turn.requestId} turn={turn} onFollowup={(value) => void send(value)} />
        ))}
      </div>
      <div className="shrink-0 border-t border-line-soft px-3 pt-2 pb-2">
        <Suggestions
          text={text}
          onPick={(value) => {
            setText(value);
            inputRef.current?.focus();
          }}
        />
        {notice && <p className="mb-1 text-xs text-danger">{notice}</p>}
        <div className="flex flex-col gap-1.5 rounded-md border border-input-border bg-input px-2 py-1.5 focus-within:border-accent">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={fallback ? `Ask @${fallback.name} (Enter to send, Shift+Enter for a new line)` : "@participant your question"}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            className="w-full resize-none bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
          <div className="flex items-center gap-2">
            {models.length > 0 ? (
              <div className="w-44">
                <Select
                  ariaLabel="Language model"
                  options={models.map((m) => ({ id: `${m.vendor}/${m.id}`, label: m.name }))}
                  value={model ?? `${models[0].vendor}/${models[0].id}`}
                  onChange={setChatModel}
                />
              </div>
            ) : (
              <span className="text-xs text-fg-subtle">No language model</span>
            )}
            <span className="flex-1" />
            {busy ? (
              <IconButton icon={Square} title="Stop" onClick={cancelChat} className="size-7" size={13} />
            ) : (
              <IconButton icon={SendHorizontal} title="Send (Enter)" onClick={() => void send()} className="size-7" size={15} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
