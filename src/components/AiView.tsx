//! The AI tool window: a conversation with the AI assistants installed on the
//! computer (Claude Code, Codex, OpenCode), run through their command-line
//! programs. Ask mode only reads the project; Agent mode may also change files.
//! `@` mentions project files, `/` runs commands (/model, /clear, /ask, /agent).

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowUp, Check, ChevronDown, Copy, CornerDownLeft, FileText, History, MessageSquarePlus, Minus, Paperclip, Pencil, RefreshCw, RotateCcw, Search, Settings, Sparkles, Square, Terminal, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  AI_COMMANDS,
  AI_PROVIDER_NAMES,
  deleteAiConversation,
  detectAiProviders,
  loadAiModels,
  newAiChat,
  openAiConversation,
  projectFiles,
  refreshAiHistory,
  runAiCommand,
  promptHistory,
  removeQueuedPrompt,
  submitAiPrompt,
  setAgentMode,
  setChatChoice,
  setIncludeFile,
  stopAi,
  useAi,
  useChatSelection,
  type AiAttachment,
  type AiCommand,
  type AiPart,
  type AiTurn,
} from "../ai/store";
import { openSettings } from "../actions";
import { openToolDocument } from "../ai/toolDocument";
import { aiApi, type AiModel, type AiProvider } from "../lib/ipc";
import { basename } from "../lib/paths";
import { remoteLabel, remoteOf } from "../lib/remote";
import { searchFiles, type FileMatch } from "../search/fileMatch";
import { notify } from "../state/notifications";
import { showTrustDialog, useTrust } from "../state/trust";
import { useWorkspace } from "../state/workspace";
import { AiIcon, modelIcon, providerIcon } from "./AiIcon";
import { Markdown } from "./ChatView";
import { FileIcon } from "./FileIcon";
import { ContextMenu, type MenuEntry } from "./Menu";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";

/** A 3×3 square of dots filling up one by one, then emptying: the assistant is working. */
export function DotsSpinner({ size = 12 }: { size?: number }) {
  return (
    <span aria-label="Working" role="status" className="pc-dots inline-grid shrink-0 grid-cols-3" style={{ width: size, height: size, gap: size / 8 }}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className="rounded-[1px] bg-current" style={{ animationDelay: `${i * 0.11}s` }} />
      ))}
    </span>
  );
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Run: Terminal,
  Bash: Terminal,
  PowerShell: Terminal,
  bash: Terminal,
  Grep: Search,
  Glob: Search,
  grep: Search,
  glob: Search,
  Read: FileText,
  read: FileText,
  Edit: Pencil,
  Write: Pencil,
  edit: Pencil,
  write: Pencil,
};

type ToolPart = Extract<AiPart, { kind: "tool" }>;

/** How much a tool returned, at a glance. */
function outputSize(output: string): string {
  const lines = output.split("\n").length;
  return lines > 1 ? `${lines} lines` : output.length > 40 ? `${output.length} chars` : output;
}

/**
 * Tool calls, one plain line each across the width: what was used, on what, and what
 * came out. A click opens the whole input and output in an editor tab.
 */
function Tools({ tools, keyPrefix }: { tools: { tool: ToolPart; index: number }[]; keyPrefix: string }) {
  return (
    <div className="flex flex-col">
      {tools.map(({ tool, index }) => {
        const Icon = TOOL_ICONS[tool.title] ?? Wrench;
        const done = tool.output !== undefined && tool.output !== null;
        return (
          <button
            key={index}
            type="button"
            {...tooltipProps(`${tool.detail ? `${tool.title}: ${tool.detail}` : tool.title} (click to see the input and output)`)}
            onClick={() => openToolDocument(tool, `${keyPrefix}-${index}`)}
            className="flex w-full min-w-0 items-center gap-1.5 py-px text-left text-xs text-fg-muted hover:text-fg"
          >
            <Icon size={12} className={`shrink-0 ${tool.error ? "text-danger" : ""}`} />
            <span className="shrink-0">{tool.title}</span>
            {tool.detail && <span className="min-w-0 truncate font-mono text-[11px] text-fg-subtle">{tool.detail}</span>}
            <span className="flex-1" />
            {done && (
              <span className={`max-w-[40%] shrink-0 truncate font-mono text-[10px] ${tool.error ? "text-danger" : "text-fg-subtle"}`}>
                {tool.error ? "failed" : tool.output ? `→ ${outputSize(tool.output)}` : "→ done"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Text, notices, and consecutive tool calls grouped together; `keyPrefix` names the turn. */
function Parts({ parts, keyPrefix }: { parts: AiPart[]; keyPrefix: string }) {
  const blocks: (AiPart | { tool: ToolPart; index: number }[])[] = [];
  parts.forEach((part, index) => {
    const last = blocks[blocks.length - 1];
    if (part.kind === "tool" && Array.isArray(last)) last.push({ tool: part, index });
    else blocks.push(part.kind === "tool" ? [{ tool: part, index }] : part);
  });
  return (
    <>
      {blocks.map((block, i) =>
        Array.isArray(block) ? (
          <Tools key={i} tools={block} keyPrefix={keyPrefix} />
        ) : block.kind === "text" ? (
          <Markdown key={i} text={block.text} />
        ) : block.kind === "notice" ? (
          <div key={i} className="flex items-start gap-1.5 text-xs text-amber-400">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{block.text}</span>
          </div>
        ) : null,
      )}
    </>
  );
}

type MessagePart = "prompt" | "answer";

function Turn({ turn, onMenu }: { turn: AiTurn; onMenu: (e: ReactMouseEvent, turn: AiTurn, part: MessagePart) => void }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div onContextMenu={(e) => onMenu(e, turn, "prompt")} className="flex flex-col gap-1 rounded-md bg-hover/50 px-2.5 py-1.5">
        <div className="whitespace-pre-wrap break-words">{turn.prompt}</div>
        {turn.context && (
          <div className="flex min-w-0 items-center gap-1 text-[11px] text-fg-subtle">
            <FileText size={11} className="shrink-0" />
            <span className="truncate">{turn.context}</span>
          </div>
        )}
      </div>
      <div onContextMenu={(e) => onMenu(e, turn, "answer")} className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
          {turn.providerId ? <AiIcon name={providerIcon(turn.providerId)} size={12} /> : <Sparkles size={12} />}
          {turn.provider}
          {!turn.done && <DotsSpinner size={11} />}
        </div>
        <Parts parts={turn.parts} keyPrefix={String(turn.id)} />
        {turn.error && <div className="whitespace-pre-wrap break-words text-xs text-danger">{turn.error}</div>}
      </div>
    </div>
  );
}

/** Ask (read-only) or Agent (may edit files). */
function ModeSwitch() {
  const agent = useAi((s) => s.agent);
  // Antigravity's CLI has no read-only mode (see ai.rs): Ask plans and refuses commands only.
  const antigravity = useChatSelection().provider?.id === "antigravity";
  const option = (value: boolean, label: string, title: string) => (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-pressed={agent === value}
      onClick={() => setAgentMode(value)}
      className={`h-5 rounded px-1.5 text-[11px] ${agent === value ? "bg-hover font-medium text-fg" : "text-fg-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex shrink-0 rounded-md border border-input-border p-px">
      {option(
        false,
        "Ask",
        antigravity
          ? "Ask: Antigravity plans and cannot run commands, but it has no read-only mode and may still write files (/ask)"
          : "Ask: reads the project and answers, changes nothing (/ask)",
      )}
      {option(true, "Agent", "Agent: may edit files and run commands in the project (/agent)")}
    </div>
  );
}

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** How full the conversation's context is, as a ring; the numbers in its tooltip. */
function ContextRing() {
  const { provider } = useChatSelection();
  const usage = useAi((s) => (provider ? s.usage[provider.id] : undefined));
  if (!usage) return null;
  const share = usage.window ? Math.min(1, usage.used / usage.window) : null;
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const color = share === null ? "text-fg-subtle" : share > 0.9 ? "text-danger" : share > 0.7 ? "text-amber-400" : "text-accent";
  const title =
    share === null
      ? `Context: ${compact(usage.used)} tokens`
      : `Context: ${compact(usage.used)} of ${compact(usage.window!)} tokens (${Math.round(share * 100)}%)`;
  return (
    <span {...tooltipProps(title)} aria-label={title} role="img" className={`flex size-5 shrink-0 items-center justify-center ${color}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" className="-rotate-90">
        <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth="2" />
        {share !== null && (
          <circle cx="7" cy="7" r={radius} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${share * circumference} ${circumference}`} />
        )}
      </svg>
    </span>
  );
}

interface Choice {
  provider: AiProvider;
  model: AiModel;
}

const DEFAULT_MODEL: AiModel = { id: "", name: "Default", description: null, contextWindow: null };

/**
 * One picker for the models of every program found, grouped by program, with a
 * search field. It opens above the input box it sits in, as wide as it.
 */
function ModelPicker() {
  const providers = useAi((s) => s.providers);
  const models = useAi((s) => s.models);
  const open = useAi((s) => s.pickerOpen);
  const setOpen = (pickerOpen: boolean) => useAi.setState({ pickerOpen });
  const { provider, model } = useChatSelection();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    for (const p of providers) void loadAiModels(p.id);
  }, [providers]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = providers
    .map((p) => ({
      provider: p,
      choices: (models[p.id] ?? [DEFAULT_MODEL])
        .filter((m) => words.every((w) => `${p.name} ${m.name} ${m.id} ${m.description ?? ""}`.toLowerCase().includes(w)))
        .map((m): Choice => ({ provider: p, model: m })),
    }))
    .filter((g) => g.choices.length > 0);
  const flat = groups.flatMap((g) => g.choices);

  // Opening (from the button or /model) starts at the current model.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, flat.findIndex((c) => c.provider.id === provider?.id && c.model.id === model)));
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!provider) return null;
  const current = models[provider.id]?.find((m) => m.id === model);
  const label = current?.name ?? (model || "Default");
  const pick = (choice: Choice) => {
    void setChatChoice(choice.provider.id, choice.model.id);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        {...tooltipProps(`${provider.name}: ${label} (/model)`)}
        onClick={() => setOpen(!open)}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
      >
        <AiIcon name={model ? modelIcon(provider.id, model) : providerIcon(provider.id)} size={13} />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div ref={panelRef} role="listbox" aria-label="Models" className={POPUP}>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
            <Search size={13} className="shrink-0 text-fg-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setActive((i) => Math.min(flat.length - 1, i + 1));
                else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
                else if (e.key === "Enter" && flat[active]) pick(flat[active]);
                else if (e.key === "Escape") setOpen(false);
                else return;
                e.preventDefault();
              }}
              placeholder="Search models"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
          <div className="min-h-0 overflow-y-auto py-1">
            {flat.length === 0 && <div className="px-3 py-1.5 text-xs text-fg-subtle">No models match</div>}
            {groups.map((group) => (
              <div key={group.provider.id}>
                <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium text-fg-subtle">
                  <AiIcon name={providerIcon(group.provider.id)} size={12} />
                  {group.provider.name}
                  {!models[group.provider.id] && <DotsSpinner size={9} />}
                </div>
                {group.choices.map((choice) => {
                  const index = flat.indexOf(choice);
                  const selected = choice.provider.id === provider.id && choice.model.id === model;
                  return (
                    <button
                      key={choice.model.id || "default"}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      ref={index === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(choice)}
                      className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left ${index === active ? "bg-selected" : ""}`}
                    >
                      <AiIcon name={choice.model.id ? modelIcon(choice.provider.id, choice.model.id) : providerIcon(choice.provider.id)} size={14} />
                      <span className="shrink-0">{choice.model.name}</span>
                      {choice.model.description && <span className="min-w-0 truncate text-xs text-fg-subtle">{choice.model.description}</span>}
                      <span className="flex-1" />
                      {choice.model.contextWindow && <span className="shrink-0 text-[11px] text-fg-subtle">{compact(choice.model.contextWindow)}</span>}
                      {selected && <Check size={13} className="shrink-0 text-fg-muted" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Popups above the input box, as wide as it. */
const POPUP = "absolute right-0 bottom-full left-0 z-20 mb-1 flex max-h-80 flex-col overflow-hidden rounded-md border border-line-soft bg-panel shadow-lg";

/** What the text before the caret is completing: an `@file` or a `/command`. */
type Completing = { kind: "file"; query: string; start: number } | { kind: "command"; query: string } | null;

function completing(text: string, caret: number): Completing {
  const before = text.slice(0, caret);
  const file = /(^|\s)@([^\s@]*)$/.exec(before);
  if (file) return { kind: "file", query: file[2], start: before.length - file[2].length - 1 };
  const command = /^\/(\w*)$/.exec(before);
  if (command) return { kind: "command", query: command[1] };
  return null;
}

type Suggestion = { kind: "file"; match: FileMatch } | { kind: "command"; command: AiCommand };

function useSuggestions(state: Completing, root: string | null): Suggestion[] {
  const [files, setFiles] = useState<string[] | null>(null);
  const fsVersion = useWorkspace((s) => s.fsVersion);
  const wantsFiles = state?.kind === "file";
  useEffect(() => {
    if (!wantsFiles || !root) return;
    let current = true;
    void projectFiles(root).then((list) => current && setFiles(list));
    return () => {
      current = false;
    };
  }, [wantsFiles, root, fsVersion]);
  return useMemo(() => {
    if (state?.kind === "command") {
      return AI_COMMANDS.filter((c) => c.name.startsWith(state.query.toLowerCase())).map((command) => ({ kind: "command", command }));
    }
    if (state?.kind === "file" && files) {
      // Nothing typed yet: the first files, shortest paths first.
      const matches = state.query
        ? searchFiles(files, state.query, 30)
        : [...files]
            .sort((a, b) => a.length - b.length)
            .slice(0, 30)
            .map((relative): FileMatch => {
              const name = basename(relative);
              return { relative, name, dir: relative.slice(0, relative.length - name.length).replace(/[\\/]$/, ""), score: 0, indices: [] };
            });
      return matches.map((match) => ({ kind: "file", match }));
    }
    return [];
  }, [state?.kind, state?.query, files]);
}

function SuggestionList({ items, active, onPick, onHover }: { items: Suggestion[]; active: number; onPick: (s: Suggestion) => void; onHover: (i: number) => void }) {
  return (
    <div role="listbox" aria-label="Suggestions" className={POPUP}>
      <div className="min-h-0 overflow-y-auto py-1">
        {items.map((item, i) => (
          <button
            key={item.kind === "file" ? item.match.relative : item.command.name}
            type="button"
            role="option"
            aria-selected={i === active}
            ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(item)}
            className={`flex w-full min-w-0 items-center gap-2 px-2.5 py-1 text-left ${i === active ? "bg-selected" : ""}`}
          >
            {item.kind === "file" ? (
              <>
                <FileIcon name={item.match.name} />
                <span className="shrink-0">{item.match.name}</span>
                <span className="min-w-0 truncate text-xs text-fg-subtle">{item.match.dir}</span>
              </>
            ) : (
              <>
                <span className="shrink-0 font-medium">/{item.command.name}</span>
                {item.command.argument && <span className="shrink-0 text-xs text-fg-subtle">[{item.command.argument}]</span>}
                <span className="min-w-0 truncate text-xs text-fg-subtle">{item.command.description}</span>
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString();
}

/** The project's saved conversations: search, open one to continue it, delete. */
function HistoryList({ onOpen }: { onOpen: () => void }) {
  const history = useAi((s) => s.history);
  const current = useAi((s) => s.conversationId);
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = history.filter((c) => {
    const text = `${c.title} ${c.turns.map((t) => t.prompt).join(" ")}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-3 mb-1 flex shrink-0 items-center gap-1.5 rounded-md border border-input-border bg-input px-2 focus-within:border-accent">
        <Search size={13} className="shrink-0 text-fg-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1" role="list" aria-label="Conversations">
        {shown.length === 0 && <p className="px-3 py-1 text-fg-muted">{history.length ? "No conversations match." : "No saved conversations yet."}</p>}
        {shown.map((c) => {
          const providers = [...new Set(c.turns.map((t) => t.providerId).filter((p): p is NonNullable<typeof p> => !!p))];
          return (
            <div key={c.id} role="listitem" className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-hover ${c.id === current ? "bg-selected-inactive" : ""}`}>
              <button
                type="button"
                onClick={() => {
                  openAiConversation(c.id);
                  onOpen();
                }}
                className="flex min-w-0 flex-1 flex-col text-left"
              >
                <span className="truncate">{c.title}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                  {providers.map((p) => (
                    <AiIcon key={p} name={providerIcon(p)} size={11} />
                  ))}
                  {ago(c.updatedAt)} · {c.turns.length} {c.turns.length === 1 ? "message" : "messages"}
                </span>
              </button>
              <button
                type="button"
                aria-label="Delete conversation"
                {...tooltipProps("Delete")}
                onClick={() => void deleteAiConversation(c.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Empty() {
  const root = useWorkspace((s) => s.root);
  const remote = remoteOf(root);
  const detecting = useAi((s) => s.detecting);
  const detected = useAi((s) => s.detected);
  const detectionError = useAi((s) => s.detectionError);
  const providers = useAi((s) => s.providers);
  if (!detected || detecting) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-fg-muted">
        <DotsSpinner /> Looking for AI assistants…
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2 text-fg-muted">
        <p>
          {detectionError || `No AI assistant was found on the project's host. Install ${Object.values(AI_PROVIDER_NAMES).join(", ")} (their command-line programs), or set an executable path for that host in Settings.`}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => void detectAiProviders(true)} className="flex h-7 items-center gap-1.5 rounded-md border border-input-border px-2.5 hover:bg-hover">
            <RefreshCw size={13} /> Search again
          </button>
          <button type="button" onClick={() => openSettings("ai.")} className="flex h-7 items-center gap-1.5 rounded-md border border-input-border px-2.5 hover:bg-hover">
            <Settings size={13} /> Settings
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 text-fg-muted">
      <p>Ask about the project, or switch to Agent to let the assistant change files and run commands.</p>
      <p className="text-xs text-fg-subtle">
        Type @ to mention a file, / for commands. Found{remote ? ` on ${remoteLabel(remote)}` : " locally"}:{" "}
        {providers.map((p) => `${p.name}${p.version ? ` ${p.version}` : ""}${p.bundled ? " (from its extension)" : ""}`).join(", ")}.
      </p>
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function answerOf(turn: AiTurn): string {
  return turn.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n").trim();
}

/** The conversation as Markdown, to copy. */
function conversationMarkdown(turns: AiTurn[]): string {
  return turns.map((t) => `**You:** ${t.prompt}\n\n**${t.provider}:** ${answerOf(t) || t.error || ""}`).join("\n\n---\n\n");
}

function copy(text: string) {
  void writeText(text).catch(() => navigator.clipboard.writeText(text).catch(() => {}));
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Files attached to the next prompt: an image's preview, or the file's icon. */
function Attachments({ items, onRemove }: { items: AiAttachment[]; onRemove: (path: string) => void }) {
  return (
    <>
      {items.map((a) => (
        <span key={a.path} {...tooltipProps(a.path)} className="flex max-w-full min-w-0 items-center gap-1 rounded bg-hover px-1.5 text-[11px] text-fg-muted">
          {a.preview ? <img src={a.preview} alt="" className="size-4 shrink-0 rounded-sm object-cover" /> : <FileIcon name={a.name} size={12} />}
          <span className="truncate">{a.name}</span>
          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.path)} className="hover:text-fg">
            <X size={11} />
          </button>
        </span>
      ))}
    </>
  );
}

export function AiView() {
  const root = useWorkspace((s) => s.root);
  const trust = useTrust((s) => s.state);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const turns = useAi((s) => s.turns);
  const running = useAi((s) => s.running);
  const includeFile = useAi((s) => s.includeFile);
  const providers = useAi((s) => s.providers);
  const activePath = useWorkspace((s) => s.activePath);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape hides the suggestions until the text changes.
  const [dismissed, setDismissed] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const historyCount = useAi((s) => s.history.length);
  const queue = useAi((s) => s.queue);
  const [attachments, setAttachments] = useState<AiAttachment[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  /** Up/Down through sent prompts: where in the history, and the draft to come back to. */
  const recall = useRef<{ index: number; draft: string } | null>(null);
  const pasted = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = running !== null || turns.some((t) => !t.done);
  const state = dismissed ? null : completing(text, caret);
  const suggestions = useSuggestions(state, root);

  useEffect(() => {
    void detectAiProviders();
    void refreshAiHistory();
  }, []);

  // Follows the answer as it streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setDismissed(false);
  };

  const send = () => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    if (value.startsWith("/") && attachments.length === 0 && runAiCommand(value)) {
      edit("", 0);
      return;
    }
    // While an answer is coming, it waits in the queue.
    submitAiPrompt(value, attachments);
    setAttachments([]);
    recall.current = null;
    edit("", 0);
  };

  const attachFiles = async () => {
    const picked = await open({ multiple: true, title: "Attach Files" }).catch(() => null);
    const paths = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
    setAttachments((current) => [
      ...current,
      ...paths.filter((p) => !current.some((a) => a.path === p)).map((path) => ({ path, name: basename(path), image: IMAGE.test(path) })),
    ]);
    inputRef.current?.focus();
  };

  /** Images pasted from the clipboard are saved and attached; text pastes as usual. */
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (images.length === 0) return;
    e.preventDefault();
    for (const file of images) {
      const extension = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
      try {
        const path = await aiApi.saveImage(await fileToBase64(file), extension);
        const name = `Pasted image ${++pasted.current}.${extension}`;
        setAttachments((current) => [...current, { path, name, image: true, preview: URL.createObjectURL(file) }]);
      } catch (error) {
        notify("error", "Could not attach the image", String(error));
      }
    }
  };

  const messageMenu = (e: ReactMouseEvent, turn: AiTurn, part: MessagePart) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString() ?? "";
    const items: MenuEntry[] = [];
    if (selection.trim()) items.push({ label: "Copy Selection", icon: Copy, action: () => copy(selection) });
    if (part === "prompt") {
      items.push(
        { label: "Copy Message", icon: Copy, action: () => copy(turn.prompt) },
        {
          label: "Edit in Input",
          icon: CornerDownLeft,
          action: () => {
            edit(turn.prompt, turn.prompt.length);
            inputRef.current?.focus();
          },
        },
        { label: "Send Again", icon: RotateCcw, action: () => submitAiPrompt(turn.prompt) },
      );
    } else {
      const answer = answerOf(turn);
      items.push({ label: "Copy Answer", icon: Copy, disabled: !answer, action: () => copy(answer) });
    }
    items.push("separator", { label: "Copy Conversation", action: () => copy(conversationMarkdown(useAi.getState().turns)) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const pick = (item: Suggestion) => {
    if (item.kind === "command") {
      // A command without an argument runs at once; one with an argument waits for it.
      if (item.command.argument) edit(`/${item.command.name} `, item.command.name.length + 2);
      else {
        runAiCommand(`/${item.command.name}`);
        edit("", 0);
      }
    } else if (state?.kind === "file") {
      const inserted = `@${item.match.relative.replace(/\\/g, "/")} `;
      const value = text.slice(0, state.start) + inserted + text.slice(caret);
      const at = state.start + inserted.length;
      edit(value, at);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
    }
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") setActive((i) => Math.min(suggestions.length - 1, i + 1));
      else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
      else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pick(suggestions[Math.min(active, suggestions.length - 1)]);
      else if (e.key === "Escape") setDismissed(true);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    // As in a terminal: Up on the first line goes back through sent prompts, Down on
    // the last line forward, past the newest back to the draft.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const input = e.currentTarget;
      const firstLine = !input.value.slice(0, input.selectionStart).includes("\n");
      const lastLine = !input.value.slice(input.selectionEnd).includes("\n");
      if (e.key === "ArrowUp" ? !firstLine : !lastLine || !recall.current) return;
      const list = promptHistory();
      if (list.length === 0) return;
      e.preventDefault();
      const current = recall.current ?? { index: list.length, draft: text };
      const index = e.key === "ArrowUp" ? Math.max(0, current.index - 1) : current.index + 1;
      const value = index >= list.length ? current.draft : list[index];
      recall.current = index >= list.length ? null : { index, draft: current.draft };
      edit(value, value.length);
      // Suggestions would cover the recalled prompt.
      setDismissed(true);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(value.length, value.length));
    }
  };

  const header = (
    <ToolWindowHeader title="AI">
      <IconButton
        icon={History}
        title={showHistory ? "Back to the Conversation" : `History${historyCount ? ` (${historyCount})` : ""}`}
        onClick={() => setShowHistory(!showHistory)}
        active={showHistory}
        className="size-7"
        size={14}
      />
      <IconButton
        icon={MessageSquarePlus}
        title="New Chat (/clear)"
        onClick={() => {
          newAiChat();
          setShowHistory(false);
        }}
        className="size-7"
        size={14}
      />
      <IconButton icon={Settings} title="AI Settings" onClick={() => openSettings("ai.")} className="size-7" size={14} />
      <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("ai")} className="size-7" />
    </ToolWindowHeader>
  );

  if (!root || trust !== "trusted") {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-col gap-2 px-3 text-fg-muted">
          {!root ? (
            <p>Open a folder: the assistant works in the project's folder.</p>
          ) : (
            <>
              <p>AI assistants are off in Restricted Mode: they read the project's own instructions and settings, and can run its commands.</p>
              <button type="button" onClick={() => showTrustDialog(root)} className="h-7 w-fit rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover">
                Manage Workspace Trust
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const fileName = activePath?.split(/[\\/]/).pop();
  const empty = !text.trim();
  return (
    <div className="flex h-full flex-col">
      {header}
      {showHistory ? (
        <HistoryList onOpen={() => setShowHistory(false)} />
      ) : (
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-2 select-text">
          {turns.length === 0 && <Empty />}
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} onMenu={messageMenu} />
          ))}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <div className="shrink-0 px-3 pt-1 pb-2">
        {queue.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-0.5" aria-label="Queued messages">
            {queue.map((q) => (
              <div key={q.id} className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-fg-subtle">Queued</span>
                <span className="min-w-0 flex-1 truncate">{q.prompt || q.attachments.map((a) => a.name).join(", ")}</span>
                <button type="button" aria-label="Remove from the queue" {...tooltipProps("Remove from the queue")} onClick={() => removeQueuedPrompt(q.id)} className="shrink-0 hover:text-fg">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative flex flex-col gap-1.5 rounded-lg border border-input-border bg-input px-2 py-1.5 focus-within:border-accent">
          {suggestions.length > 0 && (
            <SuggestionList items={suggestions} active={Math.min(active, suggestions.length - 1)} onPick={pick} onHover={setActive} />
          )}
          {((includeFile && fileName) || attachments.length > 0) && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {includeFile && fileName && (
                <span className="flex max-w-full min-w-0 items-center gap-1 rounded bg-hover px-1.5 text-[11px] text-fg-muted" {...tooltipProps("The open file (and its selection) is sent along")}>
                  <FileIcon name={fileName} size={12} />
                  <span className="truncate">{fileName}</span>
                  <button type="button" aria-label="Don't send the open file" onClick={() => setIncludeFile(false)} className="hover:text-fg">
                    <X size={11} />
                  </button>
                </span>
              )}
              <Attachments items={attachments} onRemove={(path) => setAttachments((current) => current.filter((a) => a.path !== path))} />
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              recall.current = null;
              edit(e.target.value, e.target.selectionStart);
            }}
            onPaste={(e) => void onPaste(e)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            disabled={providers.length === 0}
            placeholder="Ask, @ files, / commands"
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            className="w-full resize-none bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
          <div className="flex min-w-0 items-center gap-1">
            <ModeSwitch />
            <ModelPicker />
            <ContextRing />
            <button type="button" aria-label="Attach files" {...tooltipProps("Attach files (or paste an image)")} onClick={() => void attachFiles()} className="flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg">
              <Paperclip size={13} />
            </button>
            {!includeFile && (
              <button type="button" onClick={() => setIncludeFile(true)} {...tooltipProps("Send the open file (and its selection) along")} className="flex shrink-0 items-center gap-1 rounded px-1 text-xs text-fg-subtle hover:text-fg">
                <FileText size={12} /> File
              </button>
            )}
            <span className="flex-1" />
            {busy && empty && attachments.length === 0 ? (
              <button type="button" aria-label="Stop" {...tooltipProps("Stop")} onClick={stopAi} className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fg text-panel hover:opacity-90">
                <Square size={10} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                aria-label={busy ? "Queue" : "Send"}
                {...tooltipProps(busy ? "Queue: sent when the answer is done (Enter)" : "Send (Enter)")}
                disabled={empty && attachments.length === 0}
                onClick={send}
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:bg-hover disabled:text-fg-subtle"
              >
                <ArrowUp size={14} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
