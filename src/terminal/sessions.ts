import { FitAddon } from "@xterm/addon-fit";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal, type ITheme } from "@xterm/xterm";
import { create } from "zustand";
import { terminalApi, type TerminalProfile, type TerminalProgram } from "../lib/ipc";
import { remoteLabel, remoteOf } from "../lib/remote";
import { setting, useUserSettings } from "../settings/store";
import { linkProvider, openTerminalUrl } from "./links";
import { generateTerminalCommand } from "../ai/store";

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

export function terminalThemeFor(themeId: string): ITheme {
  if (themeId === "powercode-light") {
    return {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      selectionBackground: "#accef7",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    };
  }
  if (themeId === "powercode-matrix-cyber") {
    return {
      background: "#060f08",
      foreground: "#a3f7bf",
      cursor: "#00ff66",
      selectionBackground: "#0d421e",
      black: "#060f08",
      red: "#ff3366",
      green: "#00ff66",
      yellow: "#39ff14",
      blue: "#00e5ff",
      magenta: "#e040fb",
      cyan: "#00ffff",
      white: "#a3f7bf",
      brightBlack: "#14331b",
      brightRed: "#ff6699",
      brightGreen: "#55ffaa",
      brightYellow: "#80ff00",
      brightBlue: "#80ffff",
      brightMagenta: "#ea80fc",
      brightCyan: "#a7ffeb",
      brightWhite: "#ffffff",
    };
  }
  return THEME;
}

let activeTerminalTheme: ITheme = THEME;

export function updateTerminalThemes(themeId: string) {
  activeTerminalTheme = terminalThemeFor(themeId);
  for (const session of useTerminals.getState().sessions) {
    session.setTheme(activeTerminalTheme);
  }
}

let nextKey = 1;

const TERMINAL_FONT = '"JetBrains Mono", "Cascadia Mono", Consolas, Menlo, monospace';

/** Brown string colour (#CF8E6D) for natural language commands starting with '>'. */
const NL_STRING_COLOR = "\x1b[38;2;207;142;109m";
const NL_PROMPT_COLOR = "\x1b[1;36m";
const ANSI_RESET = "\x1b[0m";

/** `terminal.integrated.fontFamily` (else the editor's font) and `fontSize`. */
function terminalFont(values = useUserSettings.getState().values) {
  const family = setting("terminal.integrated.fontFamily", "", values) || setting("editor.fontFamily", "", values) || TERMINAL_FONT;
  return { family, size: setting("terminal.integrated.fontSize", 13, values) };
}

/** An extension's `Pseudoterminal`: it writes the output (`write`) and handles input itself. */
export interface ExtensionPty {
  open(cols: number, rows: number): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface SessionOptions {
  /** A program to run instead of a shell. */
  program?: TerminalProgram;
  /** Variables for a local shell (`null` removes one). */
  env?: Record<string, string | null>;
  /** No process: an extension drives the terminal. */
  pty?: ExtensionPty;
}

/**
 * An xterm instance bound to a shell process. It lives outside React so the
 * shell survives the terminal tool window being hidden. The process starts
 * right away; the terminal is drawn once shown.
 */
export class TerminalSession {
  readonly key = nextKey++;
  readonly title: string;
  /** Background of this terminal, which the tab bar takes so they read as one surface. */
  background = activeTerminalTheme.background!;
  /** The shell's or program's process id, once started. */
  pid: number | null = null;
  /** Set when the process exited: its code, or null when unknown. */
  exit: { code: number | null } | null = null;
  private readonly host = document.createElement("div");
  private readonly term = new Terminal({
    theme: activeTerminalTheme,
    fontFamily: terminalFont().family,
    fontSize: terminalFont().size,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    // Hyperlinks programs print (OSC 8), as the detected ones: Ctrl+Click (Cmd on macOS).
    linkHandler: {
      activate: (event, uri) => {
        if (navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey) openTerminalUrl(uri);
      },
      allowNonHttpProtocols: true,
    },
  });
  private readonly fit = new FitAddon();
  private ptyId: number | null = null;
  private opened = false;
  private disposed = false;
  /** Text sent before the shell started (e.g. by an extension), written once it has. */
  private queued = "";
  private readonly startListeners = new Set<(pid: number | null) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  isGenerating = false;
  private currentLine = "";
  private nlActive = false;
  private nlPrompt = "";
  private nlGenerating = false;
  private nlCancel: (() => void) | null = null;

  constructor(
    private readonly cwd: string | null,
    /** Terminal profile id; null for the default shell. */
    private readonly profile: string | null,
    title: string,
    private readonly options: SessionOptions = {},
  ) {
    this.title = title;
    this.host.style.height = "100%";
    this.term.loadAddon(this.fit);
    this.term.registerLinkProvider(linkProvider(this.term, () => this.cwd));
    this.term.attachCustomKeyEventHandler((e) => this.clipboardKey(e));
    // After the creator registered its listeners.
    queueMicrotask(() => void this.start());
  }

  /** Calls `listener` once the process started (with its id); returns the unsubscribe function. */
  onStart(listener: (pid: number | null) => void) {
    this.startListeners.add(listener);
    return () => void this.startListeners.delete(listener);
  }

  /** Calls `listener` when the process exits (with its code); returns the unsubscribe function. */
  onExit(listener: (code: number | null) => void) {
    this.exitListeners.add(listener);
    return () => void this.exitListeners.delete(listener);
  }

  attach(container: HTMLElement) {
    container.appendChild(this.host);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      this.fit.fit();
    }
    this.layout();
    this.term.focus();
  }

  hasSelection() {
    return this.term.hasSelection();
  }

  /** Copies the selected text; false when nothing is selected. */
  copySelection(): boolean {
    const text = this.term.getSelection();
    if (!text) return false;
    void writeText(text).catch(() => navigator.clipboard.writeText(text));
    return true;
  }

  /** Pastes the clipboard's text as typed input (bracketed for shells that ask for it). */
  async paste() {
    const text = await readText().catch(() => navigator.clipboard.readText().catch(() => ""));
    if (text) this.term.paste(text);
    this.term.focus();
  }

  selectAll() {
    this.term.selectAll();
  }

  /** Clears the scrollback and the screen, keeping the prompt line. */
  clear() {
    this.term.clear();
    this.term.focus();
  }

  /**
   * The clipboard keys, as in VS Code's terminal: Ctrl+Shift+C / Ctrl+Insert copy,
   * Ctrl+Shift+V / Shift+Insert paste; on Windows also Ctrl+C with a selection (without
   * one it interrupts, as always) and Ctrl+V. Returns false for the keys it handled.
   */
  private clipboardKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const windows = navigator.userAgent.includes("Windows");
    const copy = (ctrl && e.shiftKey && key === "c") || (ctrl && !e.shiftKey && key === "insert") || (windows && ctrl && !e.shiftKey && !e.altKey && key === "c" && this.term.hasSelection());
    const paste = (ctrl && e.shiftKey && key === "v") || (e.shiftKey && !ctrl && key === "insert") || (windows && ctrl && !e.shiftKey && !e.altKey && key === "v");
    if (copy) {
      this.copySelection();
      this.term.clearSelection();
    } else if (paste) {
      void this.paste();
    } else {
      return true;
    }
    // Not the browser's own paste as well, nor the app's shortcuts.
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  /** Output of an extension's pseudoterminal. */
  write(data: string) {
    this.term.write(data);
  }

  /** The process (or the extension's pseudoterminal) ended. */
  markExited(code: number | null) {
    if (this.exit) return;
    this.ptyId = null;
    this.exit = { code };
    this.term.write(`\r\n\x1b[90m[Process exited${code ? ` with code ${code}` : ""}]\x1b[0m\r\n`);
    this.exitListeners.forEach((listener) => listener(code));
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
    if (this.options.pty) {
      if (!this.exit) this.options.pty.input(text);
    } else if (this.ptyId !== null) void terminalApi.write(this.ptyId, text);
    else if (!this.exit) this.queued += text;
  }

  private async start() {
    const { pty } = this.options;
    if (pty) {
      this.term.onData((data) => !this.exit && pty.input(data));
      this.term.onResize(({ cols, rows }) => pty.resize(cols, rows));
      pty.open(this.term.cols, this.term.rows);
      this.startListeners.forEach((listener) => listener(null));
      return;
    }
    try {
      const spawned = await terminalApi.spawn(
        this.cwd,
        this.profile,
        this.term.cols,
        this.term.rows,
        (e) => {
          if (e.event === "output") this.term.write(e.data);
          else this.markExited(e.data);
        },
        this.options.program,
        this.options.env,
      );
      // Closed while it was starting.
      if (this.disposed) {
        void terminalApi.kill(spawned.id);
        return;
      }
      this.ptyId = spawned.id;
      this.pid = spawned.pid;
      this.startListeners.forEach((listener) => listener(spawned.pid));
      this.term.write("\x1b[90mTip: Start with \x1b[38;2;207;142;109m>\x1b[90m to ask AI for a command suggestion\x1b[0m\r\n");
    } catch (e) {
      this.term.write(`\x1b[31mCould not start the terminal: ${e}\x1b[0m\r\n`);
      this.markExited(null);
      return;
    }
    this.term.onData((data) => {
      this.handleTerminalData(data);
    });
    if (this.queued && this.ptyId !== null) {
      void terminalApi.write(this.ptyId, this.queued);
      this.queued = "";
    }
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId !== null) void terminalApi.resize(this.ptyId, cols, rows);
    });
  }

  private handleTerminalData(data: string) {
    if (this.ptyId === null || this.exit) return;

    // While AI is generating: allow cancellation with Ctrl+C or Escape.
    if (this.nlGenerating) {
      if (data === "\x03" || data === "\x1b") {
        this.nlCancel?.();
        this.nlCancel = null;
        this.nlGenerating = false;
        this.isGenerating = false;
        useTerminals.setState({ generating: false });
        this.nlActive = false;
        this.nlPrompt = "";
        this.currentLine = "";
        this.term.write("\r\x1b[2K^C\r\n");
        void terminalApi.write(this.ptyId, "\x03");
      }
      return;
    }

    // While natural language query is active:
    if (this.nlActive) {
      // 1. Enter: execute AI command generation
      if (data === "\r" || data === "\n" || data === "\r\n") {
        const query = this.nlPrompt.trim();
        if (!query) {
          this.nlActive = false;
          this.nlPrompt = "";
          this.currentLine = "";
          this.term.write("\r\n");
          void terminalApi.write(this.ptyId, "\r");
          return;
        }

        this.nlGenerating = true;
        this.isGenerating = true;
        useTerminals.setState({ generating: true });
        this.term.write("\r\n\x1b[90m■ Generating command…\x1b[0m");

        const signal = { cancel: () => {} };
        this.nlCancel = () => signal.cancel();

        generateTerminalCommand(query, this.cwd, this.profile, signal)
          .then((command) => {
            if (!this.nlGenerating) return;
            this.nlGenerating = false;
            this.isGenerating = false;
            useTerminals.setState({ generating: false });
            this.nlActive = false;
            this.nlPrompt = "";
            this.currentLine = command;

            // Clear the "■ Generating command…" line and move cursor back to query line
            this.term.write("\r\x1b[2K\x1b[A");

            // Advance the shell to the next line and feed the suggested command
            if (this.ptyId !== null && !this.exit) {
              void terminalApi.write(this.ptyId, "\r");
              setTimeout(() => {
                if (this.ptyId !== null && !this.exit) {
                  void terminalApi.write(this.ptyId, command);
                }
              }, 60);
            }
          })
          .catch((err) => {
            if (!this.nlGenerating) return;
            this.nlGenerating = false;
            this.isGenerating = false;
            useTerminals.setState({ generating: false });
            this.nlActive = false;
            this.nlPrompt = "";
            this.currentLine = "";
            const msg = err instanceof Error ? err.message : String(err);
            this.term.write(`\r\x1b[2K\x1b[31m[AI: ${msg}]\x1b[0m\r\n`);
            if (this.ptyId !== null && !this.exit) void terminalApi.write(this.ptyId, "\r");
          });
        return;
      }

      // 2. Backspace
      if (data === "\x7f" || data === "\x08") {
        if (this.nlPrompt.length > 0) {
          this.nlPrompt = this.nlPrompt.slice(0, -1);
          this.term.write("\b \b");
        } else {
          // Erase the '>' prefix and exit NL mode
          this.term.write("\b \b");
          this.nlActive = false;
          this.currentLine = "";
        }
        return;
      }

      // 3. Ctrl+C or Escape: cancel NL mode
      if (data === "\x03" || data === "\x1b") {
        this.nlActive = false;
        this.nlPrompt = "";
        this.currentLine = "";
        this.term.write("^C\r\n");
        void terminalApi.write(this.ptyId, "\x03");
        return;
      }

      // 4. Ctrl+U: clear line
      if (data === "\x15") {
        const eraseLen = this.nlPrompt.length + 1;
        this.term.write("\b \b".repeat(eraseLen));
        this.nlActive = false;
        this.nlPrompt = "";
        this.currentLine = "";
        return;
      }

      // 5. Arrow keys and other escape sequences: ignore while typing NL query
      if (data.startsWith("\x1b")) {
        return;
      }

      // 6. Normal typed text: highlight in brown string colour
      this.nlPrompt += data;
      this.term.write(`${NL_STRING_COLOR}${data}${ANSI_RESET}`);
      return;
    }

    // Natural language command trigger: line starts with '>'
    if (this.currentLine.trim() === "" && data.startsWith(">")) {
      this.nlActive = true;
      let after = data.slice(1);
      const hasNewline = after.includes("\r") || after.includes("\n");
      after = after.replace(/[\r\n]+$/, "");
      this.nlPrompt = after;
      this.term.write(`${NL_PROMPT_COLOR}>${ANSI_RESET}`);
      if (after) {
        this.term.write(`${NL_STRING_COLOR}${after}${ANSI_RESET}`);
      }
      if (hasNewline) {
        this.handleTerminalData("\r");
      }
      return;
    }

    // Normal command line tracking
    if (data === "\r" || data === "\n" || data === "\r\n") {
      this.currentLine = "";
    } else if (data === "\x03" || data === "\x15") {
      this.currentLine = "";
    } else if (data === "\x7f" || data === "\x08") {
      this.currentLine = this.currentLine.slice(0, -1);
    } else if (!data.startsWith("\x1b")) {
      this.currentLine += data;
    }

    void terminalApi.write(this.ptyId, data);
  }

  setTheme(theme: ITheme) {
    this.background = theme.background!;
    this.term.options.theme = theme;
  }

  dispose() {
    this.disposed = true;
    this.nlCancel?.();
    this.nlCancel = null;
    if (this.nlGenerating) {
      this.nlGenerating = false;
      this.isGenerating = false;
      useTerminals.setState({ generating: false });
    }
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
  generating: boolean;
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
  generating: false,
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
export function newTerminal(cwd: string | null, profileId?: string, name?: string, options?: SessionOptions) {
  const { sessions, profiles, defaultProfile } = useTerminals.getState();
  const remote = remoteOf(cwd);
  const profile = remote ? null : (profiles.find((p) => p.id === (profileId ?? defaultProfile)) ?? null);
  const base = remote ? remoteLabel(remote) : (profile?.name ?? "Local");
  // "PowerShell", "PowerShell (2)", ... per profile.
  const count = sessions.filter((s) => s.title === base || s.title.startsWith(`${base} (`)).length;
  const title = name ?? (count === 0 ? base : `${base} (${count + 1})`);
  const session = new TerminalSession(cwd, profile?.id ?? null, title, options);
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

export function currentTerminalBackground(): string {
  return activeTerminalTheme.background!;
}

/** Opens a terminal running `program` (not a shell), e.g. for a debugger's `runInTerminal`. */
export function newProgramTerminal(cwd: string | null, title: string, program: TerminalProgram) {
  const session = new TerminalSession(cwd, null, title, { program });
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
