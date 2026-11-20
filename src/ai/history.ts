//! Saved conversations of the AI tool window, per project: a JSON file in the app's
//! data folder (`ai-history/<project>.json`), newest first. Each keeps the programs'
//! session ids, so a reopened conversation continues where it stopped.

import { appDataDir, join } from "@tauri-apps/api/path";
import type { AiProviderId } from "../lib/ipc";
import { fsApi } from "../lib/ipc";
import type { AiTurn } from "./store";

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: AiTurn[];
  sessions: Partial<Record<AiProviderId, { id: string; seen: number }>>;
}

/** Older conversations beyond this are dropped. */
const MAX_CONVERSATIONS = 100;

/** A file name for the project: FNV-1a of its path (paths compare case-insensitively on Windows). */
function projectKey(root: string): string {
  const text = navigator.userAgent.includes("Windows") ? root.toLowerCase() : root;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function historyFile(root: string): Promise<{ dir: string; file: string }> {
  const dir = await join(await appDataDir(), "ai-history");
  return { dir, file: await join(dir, `${projectKey(root)}.json`) };
}

/** Each project's conversations, once read. */
const cache = new Map<string, Promise<SavedConversation[]>>();

export function loadConversations(root: string): Promise<SavedConversation[]> {
  let list = cache.get(root);
  if (!list) {
    list = historyFile(root)
      .then(({ file }) => fsApi.readTextFile(file))
      .then((text) => {
        const value = JSON.parse(text);
        return Array.isArray(value) ? (value as SavedConversation[]).filter((c) => c && c.id && Array.isArray(c.turns)) : [];
      })
      .catch(() => []);
    cache.set(root, list);
  }
  return list;
}

/** Writes go one at a time, each from the list the previous one left. */
let writing: Promise<unknown> = Promise.resolve();

function update(root: string, change: (list: SavedConversation[]) => SavedConversation[]): Promise<SavedConversation[]> {
  const next = writing.then(async () => {
    const list = change(await loadConversations(root)).slice(0, MAX_CONVERSATIONS);
    cache.set(root, Promise.resolve(list));
    const { dir, file } = await historyFile(root);
    // Fails when the folder exists, which is fine.
    await fsApi.createDir(dir).catch(() => {});
    await fsApi.writeTextFile(file, JSON.stringify(list));
    return list;
  });
  writing = next.catch(() => {});
  return next;
}

/** Saves (or replaces) a conversation and moves it to the top. */
export function saveConversation(root: string, conversation: SavedConversation) {
  return update(root, (list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
}

export function deleteConversation(root: string, id: string) {
  return update(root, (list) => list.filter((c) => c.id !== id));
}

export function conversationTitle(turns: AiTurn[]): string {
  const first = turns[0]?.prompt.split("\n").find((l) => l.trim()) ?? "Conversation";
  return first.length > 80 ? `${first.slice(0, 80)}…` : first.trim();
}
