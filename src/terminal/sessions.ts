import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { create } from "zustand";
import { terminalApi, type TerminalProfile, type TerminalProgram } from "../lib/ipc";
import { remoteLabel, remoteOf } from "../lib/remote";
import { setting, useUserSettings } from "../settings/store";

const THEME: ITheme = {
  background: "#1e1f22",
  foreground: "#bcbec4",
  cursor: "#ced0d6",
  selectionBackground: "#214283",
  black: "#1e1f22",
  red: "#f0524f",
  green: "#5c962c",
  yellow: "#a68a0d",
  blue: "#3993d4",
  magenta: "#a771bf",
  cyan: "#00a3a3",
  white: "#808080",
  brightBlack: "#595959",
  brightRed: "#ff4050",
  brightGreen: "#4fc414",
  brightYellow: "#e5bf00",
  brightBlue: "#1fb0ff",
  brightMagenta: "#ed7eed",
  brightCyan: "#00e5e5",
  brightWhite: "#ffffff",
};

let nextKey = 1;

const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Mono", Consolas, Menlo, monospace';

/** `terminal.integrated.fontFamily` (else the editor's font) and `fontSize`. */
function terminalFont(values = useUserSettings.getState().values) {
  const family = setting("terminal.integrated.fontFamily", "", values) || setting("editor.fontFamily", "", values) || TERMINAL_FONT;
  return { family, size: setting("terminal.integrated.fontSize", 13, values) };
}

/**
 * An xterm instance bound to a shell process. It lives outside React so the
 * shell survives the terminal tool window being hidden.
 */
export class TerminalSession {
  readonly key = nextKey++;
  readonly title: string;
  /** Background of this terminal, which the tab bar takes so they read as one surface. */
  readonly background = THEME.background!;
  private readonly host = document.createElement("div");
  private readonly term = new Terminal({
    theme: THEME,
    fontFamily: terminalFont().family,
    fontSize: terminalFont().size,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  });
  private readonly fit = new FitAddon();
  private ptyId: number | null = null;
  private opened = false;
  /** Text sent before the shell started (e.g. by an extension), written once it has. */
  private queued = "";

  constructor(
    private readonly cwd: string | null,
    /** Terminal profile id; null for the default shell. */
    private readonly profile: string | null,
    title: string,
    /** A program to run instead of a shell. */
    private readonly program?: TerminalProgram,
  ) {
    this.title = title;
    this.host.style.height = "100%";
    this.term.loadAddon(this.fit);
  }

  attach(container: HTMLElement) {
    container.appendChild(this.host);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      this.fit.fit();
      void this.start();
    }
    this.layout();
    this.term.focus();
  }

  detach() {
    this.host.remove();
  }

  /** Fits the terminal to its container, if it is visible. */
  layout() {
    if (this.host.isConnected && this.host.clientWidth > 0 && this.host.clientHeight > 0) {
      this.fit.fit();
    }
  }

  focus() {
    this.term.focus();
  }

  /** Applies the terminal font settings. */
  setFont(family: string, size: number) {
    this.term.options.fontFamily = family;
    this.term.options.fontSize = size;
    this.layout();
  }

  /** Types `text` into the shell, as if entered by the user. */
  sendText(text: string) {
    if (this.ptyId !== null) void terminalApi.write(this.ptyId, text);
    else this.queued += text;
  }

  private async start() {
    try {
      this.ptyId = await terminalApi.spawn(this.cwd, this.profile, this.term.cols, this.term.rows, (e) => {
        if (e.event === "output") {
          this.term.write(e.data);
        } else {
          this.ptyId = null;
          this.term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        }
      }, this.program);
    } catch (e) {
      this.term.write(`\x1b[31mCould not start the terminal: ${e}\x1b[0m\r\n`);
      return;
    }
    this.term.onData((data) => {
      if (this.ptyId !== null) void terminalApi.write(this.ptyId, data);
    });
    if (this.queued && this.ptyId !== null) {
      void terminalApi.write(this.ptyId, this.queued);
      this.queued = "";
    }
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) void terminalApi.resize(this.ptyId, cols, rows);
    });
  }

  dispose() {
    if (this.ptyId !== null) void terminalApi.kill(this.ptyId);
    this.term.dispose();
    this.host.remove();
  }
}

const DEFAULT_PROFILE_KEY = "powercode.terminalProfile";

interface TerminalsState {
  sessions: TerminalSession[];
  active: TerminalSession | null;
  profiles: TerminalProfile[];
  /** Profile used by "+" and Alt+F12; null until profiles load (the backend default). */
  defaultProfile: string | null;
}

function storedDefaultProfile(): string | null {
  try {
    return localStorage.getItem(DEFAULT_PROFILE_KEY);
  } catch {
    return null;
  }
}

export const useTerminals = create<TerminalsState>(() => ({
  sessions: [],
  active: null,
  profiles: [],
  defaultProfile: storedDefaultProfile(),
}));

export async function loadTerminalProfiles() {
  const profiles = await terminalApi.profiles().catch(() => []);
  const stored = useTerminals.getState().defaultProfile;
  useTerminals.setState({
    profiles,
    defaultProfile: profiles.some((p) => p.id === stored) ? stored : (profiles[0]?.id ?? null),
  });
}

export function setDefaultTerminalProfile(id: string) {
  useTerminals.setState({ defaultProfile: id });
  try {
    localStorage.setItem(DEFAULT_PROFILE_KEY, id);
  } catch {
    // Not remembering the choice is harmless.
  }
}

/** Opens a terminal in `cwd`; remote workspaces get the remote shell whatever the profile. */
export function newTerminal(cwd: string | null, profileId?: string, name?: string) {
  const { sessions, profiles, defaultProfile } = useTerminals.getState();
  const remote = remoteOf(cwd);
  const profile = remote ? null : (profiles.find((p) => p.id === (profileId ?? defaultProfile)) ?? null);
  const base = remote ? remoteLabel(remote) : (profile?.name ?? "Local");
  // "PowerShell", "PowerShell (2)", ... per profile.
  const count = sessions.filter((s) => s.title === base || s.title.startsWith(`${base} (`)).length;
  const title = name ?? (count === 0 ? base : `${base} (${count + 1})`);
  const session = new TerminalSession(cwd, profile?.id ?? null, title);
  useTerminals.setState({ sessions: [...sessions, session], active: session });
  return session;
}

export function closeTerminal(session: TerminalSession) {
  const { sessions, active } = useTerminals.getState();
  const index = sessions.indexOf(session);
  const remaining = sessions.filter((s) => s !== session);
  session.dispose();
  useTerminals.setState({
    sessions: remaining,
    active: active === session ? (remaining[Math.max(0, index - 1)] ?? null) : active,
  });
}

export function setActiveTerminal(session: TerminalSession) {
  useTerminals.setState({ active: session });
}

export function closeAllTerminals() {
  useTerminals.getState().sessions.forEach((s) => s.dispose());
  useTerminals.setState({ sessions: [], active: null });
}

/** The terminal background, for chrome shown before any session exists. */
export const TERMINAL_BACKGROUND = THEME.background!;

/** Opens a terminal running `program` (not a shell), e.g. for a debugger's `runInTerminal`. */
export function newProgramTerminal(cwd: string | null, title: string, program: TerminalProgram) {
  const session = new TerminalSession(cwd, null, title, program);
  const { sessions } = useTerminals.getState();
  useTerminals.setState({ sessions: [...sessions, session], active: session });
  return session;
}

// Open terminals follow font changes in the settings.
useUserSettings.subscribe((state, previous) => {
  if (state.values === previous.values) return;
  const { family, size } = terminalFont(state.values);
  useTerminals.getState().sessions.forEach((session) => session.setFont(family, size));
});
