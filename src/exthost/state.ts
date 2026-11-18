import { create } from "zustand";

export interface StatusItem {
  id: string;
  text: string;
  tooltip?: string;
  command?: { command: string; arguments?: unknown[] };
  /** 1 = left, 2 = right, as `vscode.StatusBarAlignment`. */
  alignment: number;
  priority: number;
}

export interface OutputChannel {
  id: string;
  name: string;
  text: string;
}

export interface ContributedCommand {
  command: string;
  title: string;
  category?: string;
  extension: string;
}

export type HostStatus = "stopped" | "starting" | "running" | "crashed";

interface ExtensionHostState {
  status: HostStatus;
  statusItems: StatusItem[];
  /** Text set by `window.setStatusBarMessage`. */
  statusMessage: string;
  outputs: OutputChannel[];
  /** The output channel shown in the Output panel. */
  activeOutput: string | null;
  commands: ContributedCommand[];
}

export const useExtensionHost = create<ExtensionHostState>(() => ({
  status: "stopped",
  statusItems: [],
  statusMessage: "",
  outputs: [{ id: "host", name: "Extension Host", text: "" }],
  activeOutput: "host",
  commands: [],
}));

/** Output text kept per channel; older text is dropped. */
const MAX_OUTPUT_CHARS = 500_000;

export function appendOutput(id: string, text: string) {
  useExtensionHost.setState(({ outputs }) => ({
    outputs: outputs.map((o) => {
      if (o.id !== id) return o;
      const next = o.text + text;
      return { ...o, text: next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next };
    }),
  }));
}

export function log(level: string, message: string) {
  appendOutput("host", `[${new Date().toLocaleTimeString()}] [${level}] ${message}\n`);
}
