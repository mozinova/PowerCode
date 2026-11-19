//! The Chat view's state: participants extensions offer (`@name`), the models
//! language model providers offer, and the conversation, whose answers stream in
//! from the extension host (ext-host/src/chat.ts).

import { create } from "zustand";
import { errorMessage } from "../lib/ipc";
import * as rpc from "./rpc";

export interface ChatParticipantInfo {
  id: string;
  name: string;
  fullName: string;
  description: string;
  isDefault: boolean;
  commands: { name: string; description: string }[];
  icon?: { themeIcon: string; color?: string } | { uri: string } | { localPath: string };
}

export interface ChatModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
}

export type ChatPart =
  | { kind: "markdown"; value: string }
  | { kind: "progress"; value: string }
  | { kind: "button"; id: number; title: string }
  | { kind: "anchor" | "reference"; uri?: string; range?: { start: { line: number; character: number } }; title?: string }
  | { kind: "filetree"; base: string; tree: { name: string; children?: unknown[] }[] };

export interface ChatTurn {
  requestId: number;
  participant: string;
  command?: string;
  prompt: string;
  parts: ChatPart[];
  done: boolean;
  error?: string;
  result?: object;
  followups?: { prompt: string; label?: string; command?: string }[];
}

interface ChatState {
  participants: ChatParticipantInfo[];
  models: ChatModelInfo[];
  /** The model requests use (`vendor/id`); null: the first available. */
  model: string | null;
  turns: ChatTurn[];
}

export const useChat = create<ChatState>(() => ({ participants: [], models: [], model: null, turns: [] }));

let nextRequest = 1;

/** The participant a prompt goes to: `@name` at its start, else the default one. */
export function parsePrompt(text: string): { participant?: ChatParticipantInfo; command?: string; prompt: string } {
  const { participants } = useChat.getState();
  let rest = text.trimStart();
  let participant = participants.find((p) => p.isDefault) ?? (participants.length === 1 ? participants[0] : undefined);
  const mention = /^@([\w.-]+)\s*/.exec(rest);
  if (mention) {
    const named = participants.find((p) => p.name === mention[1]);
    if (named) {
      participant = named;
      rest = rest.slice(mention[0].length);
    }
  }
  let command: string | undefined;
  const slash = /^\/([\w.-]+)\s*/.exec(rest);
  if (slash && participant?.commands.some((c) => c.name === slash[1])) {
    command = slash[1];
    rest = rest.slice(slash[0].length);
  }
  return { participant, command, prompt: rest.trim() };
}

function updateTurn(requestId: number, change: (turn: ChatTurn) => Partial<ChatTurn>) {
  useChat.setState(({ turns }) => ({ turns: turns.map((t) => (t.requestId === requestId ? { ...t, ...change(t) } : t)) }));
}

/** Sends a prompt; returns false when no participant takes it. */
export async function sendChat(text: string): Promise<boolean> {
  const { participant, command, prompt } = parsePrompt(text);
  if (!participant) return false;
  const { turns, model, models } = useChat.getState();
  const requestId = nextRequest++;
  // The conversation so far with this participant, as the extension's `context.history`.
  const history = turns
    .filter((t) => t.participant === participant.id && t.done && !t.error)
    .map((t) => ({
      participant: t.participant,
      prompt: t.prompt,
      command: t.command,
      response: t.parts.filter((p) => p.kind === "markdown").map((p) => (p as { value: string }).value).join(""),
      result: t.result,
    }));
  useChat.setState({ turns: [...turns, { requestId, participant: participant.id, command, prompt, parts: [], done: false }] });
  const picked = models.find((m) => `${m.vendor}/${m.id}` === model) ?? models[0];
  try {
    const result = await rpc.request<{ errorDetails?: { message: string }; metadata?: object; followups?: ChatTurn["followups"] }>("chat/request", {
      requestId,
      participant: participant.id,
      prompt,
      command,
      model: picked ? { vendor: picked.vendor, id: picked.id } : undefined,
      history,
    });
    updateTurn(requestId, () => ({ done: true, error: result.errorDetails?.message, result: { metadata: result.metadata }, followups: result.followups }));
  } catch (e) {
    updateTurn(requestId, () => ({ done: true, error: errorMessage(e) }));
  }
  return true;
}

export function cancelChat() {
  for (const turn of useChat.getState().turns) if (!turn.done) rpc.notify("chat/cancel", { requestId: turn.requestId });
}

export function clearChat() {
  cancelChat();
  useChat.setState({ turns: [] });
}

export const runChatButton = (id: number) => rpc.request("chat/button", { id }).catch(() => {});

export async function loadChatModels() {
  const models = await rpc.request<ChatModelInfo[]>("lm/models").catch(() => []);
  useChat.setState(({ model }) => ({ models, model: models.some((m) => `${m.vendor}/${m.id}` === model) ? model : null }));
}

export function setChatModel(key: string) {
  useChat.setState({ model: key });
}

export function registerChatHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("chat/participants", ({ participants }) => {
    useChat.setState({ participants });
    void loadChatModels();
  });
  onNotification("lm/changed", () => void loadChatModels());
  onNotification("chat/part", ({ requestId, part }) =>
    updateTurn(requestId, (turn) => {
      const last = turn.parts[turn.parts.length - 1];
      // Streamed text arrives in pieces: they join into one block.
      if (part.kind === "markdown" && last?.kind === "markdown") {
        return { parts: [...turn.parts.slice(0, -1), { kind: "markdown", value: last.value + part.value }] };
      }
      return { parts: [...turn.parts, part] };
    }),
  );
}

export function resetChat() {
  useChat.setState({ participants: [], models: [], turns: [] });
}
