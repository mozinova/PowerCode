//! JSON-RPC between the extension host (this Node process) and PowerCode's UI,
//! one message per line on stdout/stdin. Protocol lines carry a prefix so
//! anything an extension prints to stdout cannot be mistaken for a message.

import * as readline from "node:readline";

export const PREFIX = "\u0001PC ";

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
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 1;

const write = process.stdout.write.bind(process.stdout);

function send(message: Message) {
  write(PREFIX + JSON.stringify(message) + "\n");
}

export function onRequest(method: string, handler: Handler) {
  requestHandlers.set(method, handler);
}

export function onNotification(method: string, handler: Handler) {
  notificationHandlers.set(method, handler);
}

export function notify(method: string, params?: unknown) {
  send({ method, params });
}

export function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}

async function dispatch(message: Message) {
  if (message.method === undefined) {
    // A response to one of our requests.
    const waiting = message.id !== undefined ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id!);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
    return;
  }
  if (message.id === undefined) {
    try {
      await notificationHandlers.get(message.method)?.(message.params);
    } catch (e) {
      notify("log", { level: "error", message: `${message.method}: ${errorText(e)}` });
    }
    return;
  }
  const handler = requestHandlers.get(message.method);
  try {
    if (!handler) throw new Error(`Unknown method ${message.method}`);
    send({ id: message.id, result: (await handler(message.params)) ?? null });
  } catch (e) {
    send({ id: message.id, error: { message: errorText(e) } });
  }
}

export function listen() {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      void dispatch(JSON.parse(line) as Message);
    } catch (e) {
      notify("log", { level: "error", message: `Bad message: ${errorText(e)}` });
    }
  });
  // The UI closed the pipe: nothing is left to serve.
  lines.on("close", () => process.exit(0));
}
