//! The terminals extensions see: every terminal of the Terminal tool window is
//! reported to the host (opened, started, exited, closed, active), and the host's
//! `createTerminal` opens shells, programs or pseudoterminals here.

import { useWorkspace } from "../state/workspace";
import { closeTerminal, newTerminal, setActiveTerminal, useTerminals, type TerminalSession } from "../terminal/sessions";
import { pathFromUri } from "./languages";
import * as rpc from "./rpc";

/** Host ids of the sessions it knows, both ways. */
const ids = new Map<TerminalSession, string>();
const sessions = new Map<string, TerminalSession>();
let nextUserId = 1;
let lastActive: string | null = null;
/** The id a session being created for the host takes (instead of being reported as the user's). */
let creatingFor: string | null = null;
/** Pseudoterminals: the host drives them, so they end with it. */
const ptys = new Set<string>();

function track(session: TerminalSession, id: string) {
  ids.set(session, id);
  sessions.set(id, session);
  session.onStart((pid) => {
    if (ids.get(session) === id && rpc.isRunning()) rpc.notify("terminal/started", { id, pid });
  });
  session.onExit((code) => {
    if (ids.get(session) === id && rpc.isRunning()) rpc.notify("terminal/exited", { id, code });
  });
}

/** Reports terminals opened or closed since the last call, and the active one. */
export function syncTerminals(state = useTerminals.getState()) {
  if (!rpc.isRunning()) return;
  for (const session of state.sessions) {
    if (ids.has(session)) continue;
    const id = creatingFor ?? `user#${nextUserId++}`;
    track(session, id);
    // Terminals the host created it knows already.
    if (!creatingFor) {
      rpc.notify("terminal/opened", { id, name: session.title, pid: session.pid });
      if (session.exit) rpc.notify("terminal/exited", { id, code: session.exit.code });
    }
  }
  for (const [session, id] of [...ids]) {
    if (state.sessions.includes(session)) continue;
    ids.delete(session);
    sessions.delete(id);
    rpc.notify("terminal/closed", { id });
  }
  const active = state.active ? (ids.get(state.active) ?? null) : null;
  if (active !== lastActive) {
    lastActive = active;
    rpc.notify("terminal/active", { id: active });
  }
}

function showPanel(session: TerminalSession) {
  setActiveTerminal(session);
  const { bottomTool, toggleBottomTool } = useWorkspace.getState();
  if (bottomTool !== "terminal") toggleBottomTool("terminal");
}

interface CreateParams {
  id: string;
  name?: string;
  cwd?: string;
  shellPath?: string;
  shellArgs?: string[];
  env?: Record<string, string | null>;
  pty?: boolean;
}

function create({ id, name, cwd, shellPath, shellArgs, env, pty }: CreateParams) {
  // A path (translated to the workspace's spelling for remote hosts), or a `file:` URI.
  const folder = cwd ? (cwd.startsWith("file:") ? pathFromUri(cwd) : cwd) : useWorkspace.getState().root;
  creatingFor = id;
  try {
    if (pty) {
      ptys.add(id);
      newTerminal(folder, undefined, name ?? "Extension", {
        pty: {
          open: (cols, rows) => rpc.notify("terminal/ptyOpen", { id, cols, rows }),
          input: (data) => rpc.notify("terminal/ptyInput", { id, data }),
          resize: (cols, rows) => rpc.notify("terminal/ptyResize", { id, cols, rows }),
        },
      });
    } else if (shellPath) {
      newTerminal(folder, undefined, name ?? shellPath, { program: { command: shellPath, args: shellArgs ?? [], env: env ?? {} } });
    } else {
      newTerminal(folder, undefined, name, { env });
    }
  } finally {
    creatingFor = null;
  }
}

export function registerTerminalHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("terminal/create", create);
  onNotification("terminal/sendText", ({ id, text }) => sessions.get(id)?.sendText(text));
  onNotification("terminal/show", ({ id }) => {
    const session = sessions.get(id);
    if (session) showPanel(session);
  });
  onNotification("terminal/dispose", ({ id }) => {
    const session = sessions.get(id);
    if (session) closeTerminal(session);
  });
  onNotification("terminal/ptyWrite", ({ id, data }) => sessions.get(id)?.write(data));
  onNotification("terminal/ptyExit", ({ id, code }) => sessions.get(id)?.markExited(code ?? null));
  useTerminals.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions || state.active !== previous.active) syncTerminals(state);
  });
}

/** The host stopped: its pseudoterminals have nobody driving them, and a new host learns every terminal anew. */
export function resetTerminals() {
  for (const [id, session] of sessions) if (ptys.has(id) && !session.exit) session.markExited(null);
  ptys.clear();
  ids.clear();
  sessions.clear();
  lastActive = null;
}
