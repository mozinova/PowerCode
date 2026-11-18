//! The UI side of the JSON-RPC with the extension host (see ext-host/src/rpc.ts).
//! Messages travel through the Rust process as JSON lines.

import { Channel, invoke } from "@tauri-apps/api/core";
import { UNTRANSLATED_METHODS, type Translator } from "./remoteUris";

type Handler = (params: any) => unknown | Promise<unknown>;

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

const requestHandlers = new Map<string, Handler>();
const notificationHandlers = new Map<string, Handler>();
let pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 1;
let running = false;
/** The current host's message channel; messages from earlier hosts are ignored. */
let current: Channel<string> | null = null;

/**
 * Messages go out one at a time: separate `invoke`s may otherwise reach the host
 * out of order (e.g. a provider request before the edit it depends on).
 */
let sending: Promise<unknown> = Promise.resolve();

/** Paths and URIs translation while the host runs on a remote (see remoteUris.ts). */
let translator: Translator | null = null;
/** Methods of our pending requests, so their results are translated (or not) like them. */
const pendingMethods = new Map<number, string>();

const translated = (method: string | undefined) => translator !== null && !(method && UNTRANSLATED_METHODS.has(method));

function send(message: Message, method = message.method) {
  if (translated(method)) {
    if (message.params !== undefined) message = { ...message, params: translator!.toHost(message.params) };
    if (message.result !== undefined) message = { ...message, result: translator!.toHost(message.result) };
  }
  const line = JSON.stringify(message);
  sending = sending.then(() => invoke("exthost_send", { message: line }).catch(() => {}));
}

export function onRequest(method: string, handler: Handler) {
  requestHandlers.set(method, handler);
}

export function onNotification(method: string, handler: Handler) {
  notificationHandlers.set(method, handler);
}

export function notify(method: string, params?: unknown) {
  if (running) send({ method, params });
}

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!running) return Promise.reject(new Error("The extension host is not running."));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pendingMethods.set(id, method);
    send({ id, method, params });
  });
}

async function dispatch(message: Message) {
  if (message.method === undefined) {
    const waiting = message.id !== undefined ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id!);
    const method = pendingMethods.get(message.id!);
    pendingMethods.delete(message.id!);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(translated(method) ? translator!.fromHost(message.result) : message.result);
    return;
  }
  const method = message.method;
  const params = translated(method) ? translator!.fromHost(message.params) : message.params;
  if (message.id === undefined) {
    await notificationHandlers.get(method)?.(params);
    return;
  }
  const handler = requestHandlers.get(method);
  try {
    if (!handler) throw new Error(`PowerCode does not handle ${method}`);
    send({ id: message.id, result: (await handler(params)) ?? null }, method);
  } catch (e) {
    send({ id: message.id, error: { message: e instanceof Error ? e.message : String(e) } });
  }
}

function rejectPending(reason: string) {
  for (const waiting of pending.values()) waiting.reject(new Error(reason));
  pending = new Map();
  pendingMethods.clear();
}

/** Where the host runs: locally, or on a remote prepared by `remote_exthost_prepare`. */
export interface RemoteLaunch {
  target: { kind: "ssh"; host: string } | { kind: "wsl"; distro: string };
  node: string;
  script: string;
}

/**
 * Starts the host process (stopping a previous one); `onExit` runs if it
 * stops on its own, i.e. not through `startProcess` or `stopProcess`.
 * A remote host gets its messages' paths and URIs translated by `remoteTranslator`.
 */
export async function startProcess(onExit: () => void, remote?: RemoteLaunch, remoteTranslator?: Translator) {
  translator = remote ? (remoteTranslator ?? null) : null;
  // Requests to a previous host will never be answered.
  rejectPending("The extension host restarted.");
  const channel = new Channel<string>();
  current = channel;
  channel.onmessage = (line) => {
    if (current !== channel) return;
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "exit") {
      running = false;
      current = null;
      rejectPending("The extension host stopped.");
      onExit();
      return;
    }
    void dispatch(message).catch((e) => console.error("Extension host message failed", e));
  };
  try {
    await invoke("exthost_start", { remote: remote ?? null, onMessage: channel });
  } catch (e) {
    if (current === channel) current = null;
    throw e;
  }
  running = current === channel;
}

export async function stopProcess() {
  running = false;
  current = null;
  rejectPending("The extension host stopped.");
  await invoke("exthost_stop").catch(() => {});
}

export const isRunning = () => running;
