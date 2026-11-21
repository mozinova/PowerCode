//! The AI assistants installed on the computer (Claude Code, Codex, OpenCode), used
//! through their command-line programs: the AI tool window's conversation, and
//! commit messages. Which program and model to use are settings (`ai.*`).

import { create } from "zustand";
import { activeEditor } from "../components/EditorArea";
import { modelPath } from "../editor/models";
import { aiApi, fsApi, gitApi, type AiModel, type AiProvider, type AiProviderId } from "../lib/ipc";
import { joinPath } from "../lib/paths";
import { conversationTitle, deleteConversation, loadConversations, saveConversation, type SavedConversation } from "./history";
import { notify } from "../state/notifications";
import { setUserSetting, setting, useUserSettings } from "../settings/store";
import { useWorkspace } from "../state/workspace";

export type AiPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      /** Ties the call to its output. */
      id?: string | null;
      title: string;
      detail: string | null;
      /** What the tool was given (JSON or a command), and what it returned. */
      input?: string | null;
      output?: string | null;
      error?: boolean;
    }
  | { kind: "notice"; text: string };

export interface AiTurn {
  id: number;
  prompt: string;
  /** What the prompt was sent with, shown under it (e.g. the open file). */
  context: string | null;
  provider: string;
  providerId: AiProviderId | null;
  agent: boolean;
  parts: AiPart[];
  done: boolean;
  error: string | null;
}

/** A file attached to a prompt: from the computer, or an image pasted (saved by `ai_save_image`). */
export interface AiAttachment {
  path: string;
  name: string;
  image: boolean;
  /** An object URL showing a pasted image. */
  preview?: string;
}

/** A prompt sent while the assistant was busy: it goes once the answer is done. */
export interface QueuedPrompt {
  id: number;
  prompt: string;
  attachments: AiAttachment[];
}

interface AiState {
  providers: AiProvider[];
  /** Detection ran at least once. */
  detected: boolean;
  detecting: boolean;
  models: Partial<Record<AiProviderId, AiModel[]>>;
  turns: AiTurn[];
  /**
   * Each program's session in this conversation, and how many turns it has seen:
   * the turns it missed (answered by another program) are sent along as text.
   */
  sessions: Partial<Record<AiProviderId, { id: string; seen: number }>>;
  /** How full each program's context is, from its last answer. */
  usage: Partial<Record<AiProviderId, { used: number; window: number | null }>>;
  /** The model picker is open (also by `/model`). */
  pickerOpen: boolean;
  /** The saved conversation being continued; set when its first answer is saved. */
  conversationId: string | null;
  /** The open project's saved conversations, newest first. */
  history: SavedConversation[];
  /** Prompts waiting for the current answer to finish. */
  queue: QueuedPrompt[];
  /** The request in progress. */
  running: number | null;
  /** Agent (may edit) or Ask (read-only). */
  agent: boolean;
  /** Send the open file (and selection) along. */
  includeFile: boolean;
}

const MODE_KEY = "powercode.aiAgentMode";
const FILE_KEY = "powercode.aiIncludeFile";

function stored(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function store(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembering it is harmless.
  }
}

export const useAi = create<AiState>(() => ({
  providers: [],
  detected: false,
  detecting: false,
  models: {},
  turns: [],
  sessions: {},
  usage: {},
  pickerOpen: false,
  conversationId: null,
  history: [],
  queue: [],
  running: null,
  agent: stored(MODE_KEY, false),
  includeFile: stored(FILE_KEY, true),
}));

export const AI_PROVIDER_IDS: AiProviderId[] = ["claude", "codex", "opencode", "antigravity"];
export const AI_PROVIDER_NAMES: Record<AiProviderId, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity" };

// ---- Providers and models -------------------------------------------------------------

let detection: Promise<AiProvider[]> | null = null;

/** Looks for the AI programs (once; `force` looks again). */
export function detectAiProviders(force = false): Promise<AiProvider[]> {
  if (detection && !force) return detection;
  useAi.setState({ detecting: true });
  const paths = Object.fromEntries(
    AI_PROVIDER_IDS.map((id) => [id, setting(`ai.${id}.path`, "")]).filter(([, path]) => path),
  );
  detection = aiApi
    .detect(paths)
    .catch(() => [])
    .then((providers) => {
      // Models may differ for another program at the same path.
      useAi.setState({ providers, detected: true, detecting: false, models: {} });
      return providers;
    });
  return detection;
}

// Looks again when a program's path changes in the settings.
useUserSettings.subscribe((state, previous) => {
  if (!detection) return;
  if (AI_PROVIDER_IDS.some((id) => state.values[`ai.${id}.path`] !== previous.values[`ai.${id}.path`])) void detectAiProviders(true);
});

const loadingModels = new Map<AiProviderId, Promise<AiModel[]>>();

export function loadAiModels(id: AiProviderId): Promise<AiModel[]> {
  const known = useAi.getState().models[id];
  if (known) return Promise.resolve(known);
  const pending = loadingModels.get(id);
  if (pending) return pending;
  const provider = useAi.getState().providers.find((p) => p.id === id);
  if (!provider) return Promise.resolve([]);
  const load = aiApi
    .models(id, provider.path)
    .catch(() => [] as AiModel[])
    .then((models) => {
      useAi.setState((s) => ({ models: { ...s.models, [id]: models } }));
      loadingModels.delete(id);
      return models;
    });
  loadingModels.set(id, load);
  return load;
}

/** The program `key` names (`ai.provider`), or the first one found. */
function pick(providers: AiProvider[], wanted: string): AiProvider | null {
  return providers.find((p) => p.id === wanted) ?? providers[0] ?? null;
}

/** The program and model chosen for the chat, outside React. */
export function chatSelection(values = useUserSettings.getState().values): { provider: AiProvider | null; model: string } {
  return { provider: pick(useAi.getState().providers, setting("ai.provider", "", values)), model: setting("ai.model", "", values) };
}

/** The program and model chosen for the chat, following settings and detection. */
export function useChatSelection(): { provider: AiProvider | null; model: string } {
  const providers = useAi((s) => s.providers);
  const wanted = useUserSettings((s) => setting("ai.provider", "", s.values));
  const model = useUserSettings((s) => setting("ai.model", "", s.values));
  return { provider: pick(providers, wanted), model };
}

/** The program and model for commit messages: their own settings, else the chat's program. */
export function commitSelection(values = useUserSettings.getState().values): { provider: AiProvider | null; model: string } {
  const wanted = setting("ai.commitMessage.provider", "", values) || setting("ai.provider", "", values);
  const provider = pick(useAi.getState().providers, wanted);
  const model = setting("ai.commitMessage.model", "", values);
  // A model of another program (saved before the program changed) means its default.
  const known = provider ? useAi.getState().models[provider.id] : undefined;
  return { provider, model: known && !known.some((m) => m.id === model) ? "" : model };
}

export function useCommitSelection(): { provider: AiProvider | null; model: string } {
  useAi((s) => s.providers);
  useAi((s) => s.models);
  const values = useUserSettings((s) => s.values);
  return commitSelection(values);
}

/** Choosing another program also goes back to its default model (model names differ). */
export async function setChatProvider(id: AiProviderId) {
  if (setting<string>("ai.provider", "", useUserSettings.getState().values) === id) return;
  await switchChatProvider(id);
  await setUserSetting("ai.model", undefined);
}

/** Commit messages that follow the chat's program lose a model of the previous one. */
async function switchChatProvider(id: AiProviderId) {
  const values = useUserSettings.getState().values;
  await setUserSetting("ai.provider", id);
  if (!setting("ai.commitMessage.provider", "", values) && setting("ai.commitMessage.model", "", values)) {
    await setUserSetting("ai.commitMessage.model", undefined);
  }
}

/** A model of any program, from the AI tool window's unified picker. */
export async function setChatChoice(provider: AiProviderId, model: string) {
  if (setting<string>("ai.provider", "", useUserSettings.getState().values) !== provider) await switchChatProvider(provider);
  await setUserSetting("ai.model", model || undefined);
}

export function setChatModel(model: string) {
  void setUserSetting("ai.model", model || undefined);
}

export async function setCommitProvider(id: string) {
  await setUserSetting("ai.commitMessage.provider", id || undefined);
  await setUserSetting("ai.commitMessage.model", undefined);
}

export function setAgentMode(agent: boolean) {
  useAi.setState({ agent });
  store(MODE_KEY, agent);
}

export function setIncludeFile(includeFile: boolean) {
  useAi.setState({ includeFile });
  store(FILE_KEY, includeFile);
}

// ---- Conversation ---------------------------------------------------------------------

let nextTurn = 1;

function updateTurn(id: number, change: (turn: AiTurn) => AiTurn) {
  useAi.setState((s) => ({ turns: s.turns.map((t) => (t.id === id ? change(t) : t)) }));
}

const MAX_SELECTION = 20_000;

/** The open file (relative to the project) and its selection, as context for the prompt. */
export function editorContext(root: string): { label: string; text: string } | null {
  const editor = activeEditor();
  const model = editor?.getModel();
  // A file's editor: not a diff, an output or an extension's document.
  const path = model ? modelPath(model) : undefined;
  if (!editor || !model || !path) return null;
  const relative = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, "") : path;
  const selection = editor.getSelection();
  if (!selection || selection.isEmpty()) {
    return { label: relative, text: `The file open in the editor is \`${relative}\`.` };
  }
  const selected = model.getValueInRange(selection).slice(0, MAX_SELECTION);
  const lines = `${selection.startLineNumber}-${selection.endLineNumber}`;
  return {
    label: `${relative}:${lines}`,
    text: `The file open in the editor is \`${relative}\`; lines ${lines} are selected:\n\n\`\`\`${model.getLanguageId()}\n${selected}\n\`\`\``,
  };
}

// ---- @ mentions -------------------------------------------------------------------------

/** The project's files (relative paths), as the file search lists them; rebuilt when stale. */
let fileIndex: { root: string; fsVersion: number; at: number; files: Promise<string[]> } | null = null;
const FILE_INDEX_MAX_AGE_MS = 30_000;

export function projectFiles(root: string): Promise<string[]> {
  const fsVersion = useWorkspace.getState().fsVersion;
  const fresh = fileIndex && fileIndex.root === root && fileIndex.fsVersion === fsVersion && Date.now() - fileIndex.at < FILE_INDEX_MAX_AGE_MS;
  if (!fresh) fileIndex = { root, fsVersion, at: Date.now(), files: fsApi.listProjectFiles(root).catch(() => []) };
  return fileIndex!.files;
}

/** `@path` words of a prompt. */
export function mentions(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1].replace(/[.,;:!?)]+$/, "")))];
}

const MAX_MENTION = 50_000;
const MAX_MENTIONS = 150_000;

/** The contents of the files a prompt mentions with `@`, for programs that do not read them themselves. */
async function mentionedFiles(root: string, prompt: string): Promise<{ text: string; labels: string[] }> {
  // Mentions are written with `/`; the index has the system's separators.
  const files = new Map((await projectFiles(root)).map((f) => [f.replace(/\\/g, "/"), f]));
  let budget = MAX_MENTIONS;
  const blocks: string[] = [];
  const labels: string[] = [];
  for (const relative of mentions(prompt)) {
    const original = files.get(relative);
    if (!original || budget <= 0) continue;
    const content = await fsApi.readTextFile(joinPath(root, original)).catch(() => null);
    if (content === null) continue;
    const cut = content.slice(0, Math.min(MAX_MENTION, budget));
    budget -= cut.length;
    labels.push(relative);
    blocks.push(`\`${relative}\`${cut.length < content.length ? " (cut)" : ""}:\n\`\`\`\n${cut}\n\`\`\``);
  }
  return { text: blocks.length ? `Files mentioned with @:\n\n${blocks.join("\n\n")}` : "", labels };
}

// ---- Sharing the conversation between programs ---------------------------------------

const MAX_TRANSCRIPT = 40_000;

function answerText(turn: AiTurn): string {
  return turn.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n").trim();
}

/**
 * What another program said in turns this one has not seen: a program only
 * continues its own sessions, so switching hands it the conversation as text.
 */
function transcript(turns: AiTurn[]): string {
  if (turns.length === 0) return "";
  let text = turns
    .map((t) => `User: ${t.prompt}\n\n${t.provider}: ${answerText(t) || (t.error ? `(failed: ${t.error})` : "(no answer)")}`)
    .join("\n\n---\n\n");
  if (text.length > MAX_TRANSCRIPT) text = `…${text.slice(-MAX_TRANSCRIPT)}`;
  return `Earlier in this conversation, with other AI assistants:\n\n${text}\n\n---\n\nContinue the conversation from there.`;
}

// ---- Sending ---------------------------------------------------------------------------

/** The model's context window when the program does not say: Codex lists it per model. */
function knownWindow(provider: AiProviderId, model: string): number | null {
  const list = useAi.getState().models[provider] ?? [];
  const exact = list.find((m) => m.id === model && m.contextWindow);
  // The default model is the program's first one.
  const fallback = model ? undefined : list.find((m) => m.id && m.contextWindow);
  return (exact ?? fallback)?.contextWindow ?? useAi.getState().usage[provider]?.window ?? null;
}

/** Sends `prompt` to the chosen program, continuing its session and sharing what others said. */
// ---- Prompt history (Up/Down in the input, as in a terminal) -------------------------------

const PROMPT_HISTORY_KEY = "powercode.aiPromptHistory";
const MAX_PROMPT_HISTORY = 100;

/** Prompts sent, oldest first. */
export function promptHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberPrompt(prompt: string) {
  const list = promptHistory().filter((p) => p !== prompt);
  list.push(prompt);
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(list.slice(-MAX_PROMPT_HISTORY)));
  } catch {
    // The history is a convenience.
  }
}

// ---- Attachments and the queue -----------------------------------------------------------

const MAX_ATTACHED_TEXT = 150_000;

/** Text files attached go inline (as @ mentions do); images and other files by path, for the program to open. */
async function attachedFiles(attachments: AiAttachment[]): Promise<{ text: string; paths: string[] }> {
  let budget = MAX_ATTACHED_TEXT;
  const blocks: string[] = [];
  const paths: string[] = [];
  for (const file of attachments) {
    const content = file.image || budget <= 0 ? null : await fsApi.readTextFile(file.path).catch(() => null);
    // Binary files read as text show NUL characters.
    if (content === null || content.includes("\u0000")) {
      paths.push(file.path);
      continue;
    }
    const cut = content.slice(0, Math.min(MAX_MENTION, budget));
    budget -= cut.length;
    blocks.push(`\`${file.name}\`${cut.length < content.length ? " (cut)" : ""}:\n\`\`\`\n${cut}\n\`\`\``);
  }
  const parts = [];
  if (blocks.length) parts.push(`Files attached:\n\n${blocks.join("\n\n")}`);
  if (paths.length) parts.push(`Files attached (open them to see them):\n${paths.map((p) => `- ${p}`).join("\n")}`);
  return { text: parts.join("\n\n"), paths };
}

let nextQueued = 1;

const isBusy = () => {
  const { running, turns } = useAi.getState();
  return running !== null || turns.some((t) => !t.done);
};

/** Sends `prompt`, or queues it while an answer is in progress. */
export function submitAiPrompt(prompt: string, attachments: AiAttachment[] = []) {
  if (!prompt.trim() && attachments.length === 0) return;
  rememberPrompt(prompt);
  if (isBusy()) {
    useAi.setState((s) => ({ queue: [...s.queue, { id: nextQueued++, prompt, attachments }] }));
    return;
  }
  void sendAiPrompt(prompt, attachments);
}

export function removeQueuedPrompt(id: number) {
  useAi.setState((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
}

/** The next queued prompt, once nothing is running. */
function drainQueue() {
  const { queue } = useAi.getState();
  if (queue.length === 0 || isBusy()) return;
  const [next, ...rest] = queue;
  useAi.setState({ queue: rest });
  void sendAiPrompt(next.prompt, next.attachments);
}

export async function sendAiPrompt(prompt: string, attachments: AiAttachment[] = []): Promise<void> {
  const state = useAi.getState();
  if (state.running !== null || (!prompt.trim() && attachments.length === 0)) return;
  const root = useWorkspace.getState().root;
  const { provider, model } = chatSelection();
  const id = nextTurn++;
  const index = state.turns.length;
  const context = root && state.includeFile ? editorContext(root) : null;
  const turn: AiTurn = {
    id,
    prompt,
    context: [context?.label, ...attachments.map((a) => a.name)].filter(Boolean).join(", ") || null,
    provider: provider?.name ?? "AI",
    providerId: provider?.id ?? null,
    agent: state.agent,
    parts: [],
    done: false,
    error: null,
  };
  useAi.setState((s) => ({ turns: [...s.turns, turn] }));
  const fail = (error: string) => {
    updateTurn(id, (t) => ({ ...t, done: true, error }));
    drainQueue();
  };
  if (!root) return fail("Open a folder first: the assistant works in the project's folder.");
  if (!provider) return fail("No AI assistant was found. Install Claude Code, Codex, OpenCode or Antigravity, or set its path in Settings › AI.");

  const session = state.sessions[provider.id] ?? { id: null, seen: 0 };
  const files = await mentionedFiles(root, prompt);
  if (files.labels.length) updateTurn(id, (t) => ({ ...t, context: [t.context, ...files.labels].filter(Boolean).join(", ") }));
  const attached = await attachedFiles(attachments);
  const full = [transcript(state.turns.slice(session.seen, index)), context?.text, files.text, attached.text, prompt].filter(Boolean).join("\n\n");
  let sessionId = session.id;
  try {
    const run = await aiApi.run(
      { provider: provider.id, path: provider.path, model: model || null, prompt: full, cwd: root, agent: state.agent, session: session.id, oneShot: false, attachments: attached.paths },
      (event) => {
        switch (event.kind) {
          case "session":
            sessionId = event.id;
            break;
          case "text":
            updateTurn(id, (t) => {
              const last = t.parts[t.parts.length - 1];
              if (last?.kind === "text" && !event.start) {
                return { ...t, parts: [...t.parts.slice(0, -1), { kind: "text", text: last.text + event.text }] };
              }
              // A new block of text after another one reads as a new paragraph.
              return { ...t, parts: [...t.parts, { kind: "text", text: event.text }] };
            });
            break;
          case "tool":
            updateTurn(id, (t) => ({ ...t, parts: [...t.parts, { kind: "tool", id: event.id, title: event.title, detail: event.detail, input: event.input }] }));
            break;
          case "toolOutput":
            updateTurn(id, (t) => {
              // The latest call with that id.
              const at = t.parts.map((p) => p.kind === "tool" && p.id === event.id).lastIndexOf(true);
              if (at < 0) return t;
              const parts = [...t.parts];
              parts[at] = { ...(parts[at] as Extract<AiPart, { kind: "tool" }>), output: event.output, error: event.error };
              return { ...t, parts };
            });
            break;
          case "notice":
            updateTurn(id, (t) => ({ ...t, parts: [...t.parts, { kind: "notice", text: event.text }] }));
            break;
          case "usage":
            useAi.setState((s) => ({
              usage: { ...s.usage, [provider.id]: { used: event.used, window: event.window ?? knownWindow(provider.id, model) } },
            }));
            break;
          case "done":
            updateTurn(id, (t) => ({ ...t, done: true, error: event.error }));
            useAi.setState((s) => ({
              running: s.running === run ? null : s.running,
              // Not after "New chat" meanwhile.
              sessions: s.turns.some((t) => t.id === id) && sessionId ? { ...s.sessions, [provider.id]: { id: sessionId, seen: index + 1 } } : s.sessions,
            }));
            if (useAi.getState().turns.some((t) => t.id === id)) void persistConversation(root);
            drainQueue();
            break;
        }
      },
    );
    // `done` may already have arrived.
    if (!useAi.getState().turns.find((t) => t.id === id)?.done) useAi.setState({ running: run });
  } catch (e) {
    fail(String(e));
  }
}

export function stopAi() {
  const { running } = useAi.getState();
  if (running !== null) void aiApi.cancel(running);
}

export function newAiChat() {
  stopAi();
  useAi.setState({ turns: [], sessions: {}, usage: {}, running: null, conversationId: null, queue: [] });
}

// ---- History ----------------------------------------------------------------------------

/** Saves the conversation (its finished turns) in the project's history. */
async function persistConversation(root: string) {
  const { turns, sessions, conversationId, history } = useAi.getState();
  const finished = turns.filter((t) => t.done);
  if (finished.length === 0) return;
  const id = conversationId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!conversationId) useAi.setState({ conversationId: id });
  const previous = history.find((c) => c.id === id);
  const now = Date.now();
  const list = await saveConversation(root, {
    id,
    title: previous?.title ?? conversationTitle(finished),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    turns: finished,
    sessions,
  }).catch(() => null);
  if (list && useWorkspace.getState().root === root) useAi.setState({ history: list });
}

/** Reads the open project's saved conversations. */
export async function refreshAiHistory() {
  const root = useWorkspace.getState().root;
  const history = root ? await loadConversations(root) : [];
  if (useWorkspace.getState().root === root) useAi.setState({ history });
}

/** Continues a saved conversation: its turns come back, and each program resumes its session. */
export function openAiConversation(id: string) {
  const saved = useAi.getState().history.find((c) => c.id === id);
  if (!saved) return;
  stopAi();
  // New turns get ids after the saved ones.
  nextTurn = Math.max(nextTurn, ...saved.turns.map((t) => t.id + 1));
  useAi.setState({ turns: saved.turns, sessions: saved.sessions ?? {}, usage: {}, running: null, conversationId: saved.id });
}

export async function deleteAiConversation(id: string) {
  const root = useWorkspace.getState().root;
  if (!root) return;
  if (useAi.getState().conversationId === id) useAi.setState({ conversationId: null });
  const list = await deleteConversation(root, id).catch(() => null);
  if (list && useWorkspace.getState().root === root) useAi.setState({ history: list });
}

// Another project: its own conversation and history.
useWorkspace.subscribe((state, previous) => {
  if (state.root === previous.root) return;
  newAiChat();
  useAi.setState({ history: [] });
  void refreshAiHistory();
});

// ---- Commands -------------------------------------------------------------------------

export interface AiCommand {
  name: string;
  description: string;
  /** Takes an argument (`/model opus`). */
  argument?: string;
  run: (argument: string) => void | Promise<void>;
}

/** Picks the first model (of any program) matching `query`; false if none does. */
async function chooseModel(query: string): Promise<boolean> {
  const { providers } = useAi.getState();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const provider of providers) {
    const models = await loadAiModels(provider.id);
    const match = models.find((m) => words.every((w) => `${provider.name} ${m.name} ${m.id}`.toLowerCase().includes(w)));
    if (match) {
      await setChatChoice(provider.id, match.id);
      return true;
    }
  }
  return false;
}

export const AI_COMMANDS: AiCommand[] = [
  {
    name: "model",
    description: "Pick the model, or switch to one by name",
    argument: "name",
    run: async (argument) => {
      if (!argument.trim()) useAi.setState({ pickerOpen: true });
      else if (!(await chooseModel(argument))) notify("info", `No model matches "${argument.trim()}"`);
    },
  },
  { name: "clear", description: "Start a new conversation", run: newAiChat },
  { name: "ask", description: "Ask mode: reads the project, changes nothing", run: () => setAgentMode(false) },
  { name: "agent", description: "Agent mode: may edit files and run commands", run: () => setAgentMode(true) },
];

/** Runs `text` if it is a command (`/name argument`); false otherwise. */
export function runAiCommand(text: string): boolean {
  const match = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = match && AI_COMMANDS.find((c) => c.name === match[1].toLowerCase());
  if (!command) return false;
  void command.run(match[2] ?? "");
  return true;
}

// ---- Commit messages ------------------------------------------------------------------

function commitPrompt(context: { diff: string; untracked: string[]; recent: string[] }): string {
  const parts = [
    "Write a git commit message for the changes below.",
    "Follow the style of the repository's recent commit subjects (format, tense, prefixes such as \"feat:\" or \"fix:\").",
    "Reply with the commit message only: a subject line of at most 72 characters, then, if the change needs it, a blank line and a short body. No code fences, quotes or commentary.",
  ];
  if (context.recent.length) parts.push(`Recent commit subjects:\n${context.recent.map((s) => `- ${s}`).join("\n")}`);
  if (context.untracked.length) parts.push(`New files:\n${context.untracked.map((f) => `- ${f}`).join("\n")}`);
  parts.push(`Diff:\n${context.diff}`);
  return parts.join("\n\n");
}

/** The answer without the wrapping a model may add anyway. */
export function cleanCommitMessage(text: string): string {
  let message = text.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(message);
  if (fenced) message = fenced[1].trim();
  if (/^(["'`]).*\1$/s.test(message)) message = message.slice(1, -1).trim();
  return message.replace(/^(commit message|message):\s*/i, "").trim();
}

/** Writes a commit message for the staged changes (or all of them) with the chosen program. */
export async function generateCommitMessage(root: string, signal?: { cancel?: () => void }): Promise<string> {
  await detectAiProviders();
  const { provider, model } = commitSelection();
  if (!provider) throw new Error("No AI assistant was found. Install Claude Code, Codex, OpenCode or Antigravity, or set its path in Settings › AI.");
  const context = await gitApi.commitContext(root);
  if (!context.diff.trim() && context.untracked.length === 0) throw new Error("There are no changes to describe.");
  return new Promise<string>((resolve, reject) => {
    let text = "";
    aiApi
      .run(
        { provider: provider.id, path: provider.path, model: model || null, prompt: commitPrompt(context), cwd: root, agent: false, session: null, oneShot: true, attachments: [] },
        (event) => {
          if (event.kind === "text") text += (event.start && text ? "\n\n" : "") + event.text;
          if (event.kind === "done") {
            if (event.error) reject(new Error(event.error));
            else if (!text.trim()) reject(new Error(`${provider.name} gave no message.`));
            else resolve(cleanCommitMessage(text));
          }
        },
      )
      .then((run) => {
        if (signal) signal.cancel = () => void aiApi.cancel(run);
      })
      .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}
