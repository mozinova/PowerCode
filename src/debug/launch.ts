//! Launch configurations: `.vscode/launch.json` (configurations and
//! compounds), the selected one, and starting it; without a launch.json, the
//! debugger for the current file's language makes one up (as in VS Code).

import { parse as parseJsonc } from "jsonc-parser";
import { create } from "zustand";
import { getModel } from "../editor/models";
import { showQuickPick } from "../exthost/dialogs";
import { useExtensionHost } from "../exthost/state";
import { useExtensions } from "../extensions/runtime";
import { fsApi } from "../lib/ipc";
import { joinPath } from "../lib/paths";
import { ask, notify } from "../state/notifications";
import { isTrusted, showTrustDialog } from "../state/trust";
import { useWorkspace } from "../state/workspace";
import { debugContinue, startConfiguration, useDebug } from "./model";

export interface LaunchConfig {
  name: string;
  type?: string;
  request?: string;
  [key: string]: unknown;
}

export interface Compound {
  name: string;
  configurations: (string | { name: string })[];
}

interface LaunchState {
  configurations: LaunchConfig[];
  compounds: Compound[];
  /** Name of the selected configuration or compound. */
  selected: string | null;
}

export const useLaunch = create<LaunchState>(() => ({ configurations: [], compounds: [], selected: null }));

const SELECTED_KEY = "powercode.debugConfiguration";

const launchJsonPath = (root: string) => joinPath(joinPath(root, ".vscode"), "launch.json");

export async function loadLaunchConfigurations() {
  const root = useWorkspace.getState().root;
  let configurations: LaunchConfig[] = [];
  let compounds: Compound[] = [];
  if (root) {
    const path = launchJsonPath(root);
    // An open launch.json tab may have newer text than the disk.
    const text = getModel(path)?.getValue() ?? (await fsApi.readTextFile(path).catch(() => null));
    if (text) {
      const value = parseJsonc(text, [], { allowTrailingComma: true }) ?? {};
      configurations = (Array.isArray(value.configurations) ? value.configurations : []).filter((c: any) => typeof c?.name === "string");
      compounds = (Array.isArray(value.compounds) ? value.compounds : []).filter((c: any) => typeof c?.name === "string");
    }
  }
  let selected: string | null = null;
  try {
    selected = localStorage.getItem(`${SELECTED_KEY}:${root}`);
  } catch {
    // No remembered choice.
  }
  const names = [...configurations.map((c) => c.name), ...compounds.map((c) => c.name)];
  useLaunch.setState({ configurations, compounds, selected: selected && names.includes(selected) ? selected : (names[0] ?? null) });
}

export function selectConfiguration(name: string) {
  useLaunch.setState({ selected: name });
  try {
    localStorage.setItem(`${SELECTED_KEY}:${useWorkspace.getState().root}`, name);
  } catch {
    // Not remembering it is harmless.
  }
}

/** Debuggers the installed extensions contribute (`contributes.debuggers`). */
export function debuggers(): { type: string; label: string; languages: string[]; initialConfigurations?: unknown[] }[] {
  return useExtensions
    .getState()
    .installed.flatMap((ext) => ((ext.manifest.contributes as any)?.debuggers ?? []) as any[])
    .filter((d) => d?.type && (d.label || d.program || d.languages))
    .map((d) => ({ type: d.type, label: d.label ?? d.type, languages: d.languages ?? [], initialConfigurations: d.initialConfigurations }));
}

/** The debugger for the current file: the only one for its language, or the user's pick. */
async function pickDebugger(): Promise<string | null> {
  const all = debuggers();
  if (all.length === 0) {
    notify("info", "No debugger is installed", "Install a debugger extension (e.g. JavaScript Debugger, Python Debugger or CodeLLDB) from the Extensions view.");
    useWorkspace.getState().showTool("extensions");
    return null;
  }
  const active = useWorkspace.getState().activePath;
  const language = active ? getModel(active)?.getLanguageId() : undefined;
  const forLanguage = language ? all.filter((d) => d.languages.includes(language)) : [];
  if (forLanguage.length === 1) return forLanguage[0].type;
  const choices = forLanguage.length > 0 ? forLanguage : all;
  const picked = await showQuickPick({
    title: "Select Debugger",
    placeHolder: "Select a debugger to run the current file",
    items: choices.map((d) => ({ label: d.label, description: d.type })),
    canPickMany: false,
  });
  return picked?.[0] !== undefined ? choices[picked[0]].type : null;
}

/** F5: continues a stopped session, else starts the selected configuration (or the current file). */
export async function startDebugging(noDebug = false) {
  const { sessions } = useDebug.getState();
  if (!noDebug && sessions.some((s) => s.status === "stopped")) return debugContinue();
  const root = useWorkspace.getState().root;
  if (root && !isTrusted()) {
    // Debugging runs the folder's code (and launch.json): only in trusted folders.
    const choice = await ask("info", "Debugging is disabled in Restricted Mode", "Trust this folder to run and debug its code.", ["Manage Workspace Trust"]);
    if (choice === 0) showTrustDialog(root);
    return;
  }
  if (useExtensionHost.getState().status !== "running") {
    notify("info", "Extensions are not running", "Debuggers are provided by extensions; install one and open a local folder.");
    return;
  }
  await loadLaunchConfigurations();
  const { configurations, compounds, selected } = useLaunch.getState();
  const compound = compounds.find((c) => c.name === selected);
  if (compound) {
    for (const entry of compound.configurations) {
      const name = typeof entry === "string" ? entry : entry.name;
      const config = configurations.find((c) => c.name === name);
      if (config) await startConfiguration(config, { noDebug });
    }
    return;
  }
  const config = configurations.find((c) => c.name === selected);
  if (config) {
    await startConfiguration(config, { noDebug });
    return;
  }
  // No launch.json: the debugger's providers resolve an empty configuration.
  const type = await pickDebugger();
  if (type) await startConfiguration({}, { type, noDebug });
}

/** Opens `.vscode/launch.json`, creating it from a debugger's initial configurations if needed. */
export async function openLaunchJson() {
  const root = useWorkspace.getState().root;
  if (!root) return;
  const path = launchJsonPath(root);
  const exists = await fsApi
    .readTextFile(path)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const all = debuggers();
    let initial: unknown[] = [];
    if (all.length > 0) {
      const picked = await showQuickPick({
        title: "Create launch.json",
        placeHolder: "Select the debugger to configure",
        items: all.map((d) => ({ label: d.label, description: d.type })),
        canPickMany: false,
      });
      if (picked?.[0] === undefined) return;
      initial = all[picked[0]].initialConfigurations ?? [];
    }
    await fsApi.createDir(joinPath(root, ".vscode")).catch(() => {});
    const content = { version: "0.2.0", configurations: initial };
    await fsApi.writeTextFile(path, `${JSON.stringify(content, null, 2)}\n`);
    useWorkspace.getState().filesChanged();
  }
  useWorkspace.getState().openFile(path);
  await loadLaunchConfigurations();
}
