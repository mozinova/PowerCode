//! `window.terminals` and `createTerminal`: every terminal of the Terminal tool
//! window (the UI reports the user's own), and the ones extensions create —
//! shells, programs (`shellPath`) or pseudoterminals they drive (`pty`).

import * as rpc from "./rpc";
import { EventEmitter, TerminalExitReason, Uri } from "./types";

interface Entry {
  terminal: any;
  resolvePid: (pid: number | undefined) => void;
  pty?: any;
  disposedByExtension?: boolean;
  subscriptions: { dispose(): unknown }[];
}

const entries = new Map<string, Entry>();
let active: any;
let nextId = 1;

export const onDidOpenTerminal = new EventEmitter<any>();
export const onDidCloseTerminal = new EventEmitter<any>();
export const onDidChangeActiveTerminal = new EventEmitter<any>();
export const onDidChangeTerminalState = new EventEmitter<any>();

function makeTerminal(id: string, name: string, creationOptions: object, pty?: any) {
  let resolvePid!: (pid: number | undefined) => void;
  const processId = new Promise<number | undefined>((resolve) => (resolvePid = resolve));
  const terminal = {
    name,
    processId,
    creationOptions: Object.freeze({ ...creationOptions }),
    exitStatus: undefined as { code: number | undefined; reason: TerminalExitReason } | undefined,
    state: { isInteractedWith: false, shell: undefined },
    shellIntegration: undefined,
    sendText(text: string, shouldExecute = true) {
      rpc.notify("terminal/sendText", { id, text: shouldExecute ? `${text}\r` : text });
    },
    show(preserveFocus?: boolean) {
      rpc.notify("terminal/show", { id, preserveFocus: preserveFocus === true });
    },
    hide() {},
    dispose() {
      const entry = entries.get(id);
      if (entry) entry.disposedByExtension = true;
      rpc.notify("terminal/dispose", { id });
    },
  };
  entries.set(id, { terminal, resolvePid, pty, subscriptions: [] });
  return terminal;
}

/** The terminal is gone (closed, or its process ended): extensions learn how, once. */
function close(id: string, exitStatus: { code: number | undefined; reason: TerminalExitReason }) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entry.terminal.exitStatus ??= exitStatus;
  entry.resolvePid(undefined);
  entry.subscriptions.forEach((s) => s.dispose());
  // A pseudoterminal learns it was closed, unless it ended itself (`onDidClose`).
  if (exitStatus.reason !== TerminalExitReason.Process) {
    try {
      entry.pty?.close?.();
    } catch {
      // The extension's own failure; the terminal is closed anyway.
    }
  }
  if (active === entry.terminal) {
    active = undefined;
    onDidChangeActiveTerminal.fire(undefined);
  }
  onDidCloseTerminal.fire(entry.terminal);
}

export function createTerminal(nameOrOptions?: string | any, shellPath?: string, shellArgs?: string[] | string) {
  const options = typeof nameOrOptions === "string" ? { name: nameOrOptions, shellPath, shellArgs } : (nameOrOptions ?? {});
  const id = `extension#${nextId++}`;
  const pty = options.pty;
  const cwd = options.cwd ? (typeof options.cwd === "string" ? options.cwd : (options.cwd as Uri).fsPath) : undefined;
  const args = options.shellArgs === undefined ? [] : Array.isArray(options.shellArgs) ? options.shellArgs : [options.shellArgs];
  const terminal = makeTerminal(id, options.name ?? (pty ? "Extension" : "Terminal"), options, pty);
  rpc.notify("terminal/create", {
    id,
    name: options.name,
    cwd,
    shellPath: pty ? undefined : options.shellPath,
    shellArgs: args.map(String),
    env: options.env,
    pty: !!pty,
  });
  if (pty) {
    const entry = entries.get(id)!;
    const add = (d: { dispose(): unknown } | undefined) => d && entry.subscriptions.push(d);
    add(pty.onDidWrite?.((data: string) => rpc.notify("terminal/ptyWrite", { id, data })));
    add(pty.onDidClose?.((code: number | void) => rpc.notify("terminal/ptyExit", { id, code: typeof code === "number" ? code : null })));
    add(pty.onDidChangeName?.((name: string) => (terminal.name = name)));
  }
  onDidOpenTerminal.fire(terminal);
  return terminal;
}

export const terminals = () => [...entries.values()].map((e) => e.terminal);
export const activeTerminal = () => active;

export function listen() {
  // A terminal the user opened in PowerCode.
  rpc.onNotification("terminal/opened", (params: { id: string; name: string; pid: number | null; exitCode?: number | null }) => {
    if (entries.has(params.id)) return;
    const terminal = makeTerminal(params.id, params.name, { name: params.name });
    if (params.pid !== null) entries.get(params.id)!.resolvePid(params.pid);
    onDidOpenTerminal.fire(terminal);
  });
  rpc.onNotification("terminal/started", (params: { id: string; pid: number | null }) =>
    entries.get(params.id)?.resolvePid(params.pid ?? undefined),
  );
  rpc.onNotification("terminal/exited", (params: { id: string; code: number | null }) => {
    const entry = entries.get(params.id);
    const reason = entry?.disposedByExtension ? TerminalExitReason.Extension : TerminalExitReason.Process;
    close(params.id, { code: params.code ?? undefined, reason });
  });
  rpc.onNotification("terminal/closed", (params: { id: string }) => {
    const entry = entries.get(params.id);
    close(params.id, { code: undefined, reason: entry?.disposedByExtension ? TerminalExitReason.Extension : TerminalExitReason.User });
  });
  rpc.onNotification("terminal/active", (params: { id: string | null }) => {
    const terminal = params.id ? entries.get(params.id)?.terminal : undefined;
    if (terminal === active) return;
    active = terminal;
    onDidChangeActiveTerminal.fire(terminal);
  });

  // Pseudoterminals: the UI shows them and passes the user's input on.
  rpc.onNotification("terminal/ptyOpen", (params: { id: string; cols: number; rows: number }) => {
    const entry = entries.get(params.id);
    if (!entry?.pty) return;
    entry.resolvePid(undefined);
    try {
      entry.pty.open({ columns: params.cols, rows: params.rows });
    } catch (e) {
      rpc.notify("log", { level: "error", message: `A pseudoterminal failed to open: ${e instanceof Error ? e.stack : String(e)}` });
    }
  });
  rpc.onNotification("terminal/ptyInput", (params: { id: string; data: string }) => {
    const entry = entries.get(params.id);
    if (!entry?.pty) return;
    if (!entry.terminal.state.isInteractedWith) {
      entry.terminal.state = { ...entry.terminal.state, isInteractedWith: true };
      onDidChangeTerminalState.fire(entry.terminal);
    }
    entry.pty.handleInput?.(params.data);
  });
  rpc.onNotification("terminal/ptyResize", (params: { id: string; cols: number; rows: number }) =>
    entries.get(params.id)?.pty?.setDimensions?.({ columns: params.cols, rows: params.rows }),
  );
}
