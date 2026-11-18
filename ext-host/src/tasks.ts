//! Tasks: `.vscode/tasks.json` and extensions' task providers (`registerTaskProvider`),
//! run in terminals — shell commands and processes in a real terminal, custom
//! executions in the pseudoterminal the extension returns. Also `fetchTasks`,
//! `executeTask`, the start/end events, and the UI's "Run Task" (`tasks/*`).

import * as fs from "node:fs";
import * as path from "node:path";
import { currentEditor } from "./api";
import { parseJsonc, substitute } from "./debug";
import * as rpc from "./rpc";
import { host } from "./state";
import * as terminals from "./terminals";
import {
  CancellationTokenSource,
  CustomExecution,
  Disposable,
  EventEmitter,
  ProcessExecution,
  ShellExecution,
  ShellQuoting,
  Task,
  TaskGroup,
  TaskRevealKind,
  TaskScope,
  type ShellQuotedString,
} from "./types";

let activate: (event: string) => Promise<void> = async () => {};
export function setTaskActivator(fn: (event: string) => Promise<void>) {
  activate = fn;
}

const providers = new Set<{ type: string; provider: any }>();

export const onDidStartTask = new EventEmitter<any>();
export const onDidEndTask = new EventEmitter<any>();
export const onDidStartTaskProcess = new EventEmitter<any>();
export const onDidEndTaskProcess = new EventEmitter<any>();

export function registerTaskProvider(type: string, provider: any) {
  const entry = { type, provider };
  providers.add(entry);
  return new Disposable(() => providers.delete(entry));
}

// ---- tasks.json ---------------------------------------------------------------------

/** What tasks.json says beyond the `Task` itself: dependencies, by label. */
const dependencies = new WeakMap<Task, { dependsOn: string[]; sequence: boolean }>();

const PLATFORM_KEY = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
const GROUPS: Record<string, TaskGroup> = { build: TaskGroup.Build, test: TaskGroup.Test, clean: TaskGroup.Clean, rebuild: TaskGroup.Rebuild };

function readTasksJson(): any {
  const root = host.workspaceFolders[0]?.uri.fsPath;
  if (!root) return null;
  try {
    return parseJsonc(fs.readFileSync(path.join(root, ".vscode", "tasks.json"), "utf8"));
  } catch {
    return null;
  }
}

/** A tasks.json entry as a `Task` (shell and process types; others are resolved by their provider). */
function configuredTask(json: any, defaults: any): { task: Task; needsProvider: boolean } | null {
  // Per-OS sections override the rest, as do the file's top-level options.
  const merged = { ...json, ...(json[PLATFORM_KEY] ?? {}) };
  const options = { ...(defaults.options ?? {}), ...(merged.options ?? {}), env: { ...(defaults.options?.env ?? {}), ...(merged.options?.env ?? {}) } };
  const type = merged.type ?? "process";
  const label = merged.label ?? merged.taskName ?? (typeof merged.command === "string" ? merged.command : undefined);
  if (!label) return null;
  const folder = host.workspaceFolders[0] ?? TaskScope.Workspace;
  const args = (merged.args ?? []).map((a: any) => (typeof a === "string" ? a : { value: String(a.value), quoting: a.quoting === "escape" ? ShellQuoting.Escape : a.quoting === "weak" ? ShellQuoting.Weak : ShellQuoting.Strong }));
  const executionOptions = { cwd: options.cwd, env: options.env, executable: options.shell?.executable, shellArgs: options.shell?.args };
  let execution: ShellExecution | ProcessExecution | undefined;
  if (type === "shell" && merged.command !== undefined) {
    execution = args.length ? new ShellExecution(merged.command, args, executionOptions) : new ShellExecution(String(merged.command), executionOptions);
  } else if (type === "process" && merged.command !== undefined) {
    execution = new ProcessExecution(String(merged.command), args.map((a: any) => (typeof a === "string" ? a : a.value)), executionOptions);
  }
  const definition = { ...merged, type };
  const task = new Task(definition, folder, label, "Workspace", execution, merged.problemMatcher);
  const group = typeof merged.group === "string" ? merged.group : merged.group?.kind;
  if (group && GROUPS[group]) {
    task.group = new TaskGroup(GROUPS[group].id, GROUPS[group].label);
    task.group.isDefault = merged.group?.isDefault === true;
  }
  task.isBackground = merged.isBackground === true;
  task.detail = merged.detail;
  task.presentationOptions = { ...(defaults.presentation ?? {}), ...(merged.presentation ?? {}) };
  const dependsOn = merged.dependsOn === undefined ? [] : Array.isArray(merged.dependsOn) ? merged.dependsOn : [merged.dependsOn];
  dependencies.set(task, { dependsOn: dependsOn.map((d: any) => (typeof d === "string" ? d : d?.label ?? String(d))), sequence: merged.dependsOrder === "sequence" });
  // A task with only dependencies runs nothing itself.
  return { task, needsProvider: !execution && type !== "shell" && type !== "process" };
}

// ---- Fetching -------------------------------------------------------------------------

const PROVIDER_TIMEOUT_MS = 10_000;

async function provided(type?: string): Promise<Task[]> {
  // Extensions declare their task types; providers register when activated.
  const types = new Set<string>();
  for (const ext of host.extensions) for (const d of ext.manifest.contributes?.taskDefinitions ?? []) if (d?.type) types.add(d.type);
  await Promise.all([...types].filter((t) => !type || t === type).map((t) => activate(`onTaskType:${t}`)));
  const token = new CancellationTokenSource().token;
  const lists = await Promise.all(
    [...providers]
      .filter((p) => !type || p.type === type)
      .map((p) =>
        Promise.race([
          Promise.resolve(p.provider.provideTasks(token)).catch(() => []),
          new Promise<Task[]>((resolve) => setTimeout(() => resolve([]), PROVIDER_TIMEOUT_MS)),
        ]),
      ),
  );
  return lists.flat().filter((t): t is Task => !!t);
}

/** tasks.json tasks, with types like `npm` completed by their provider's `resolveTask`. */
async function configured(): Promise<Task[]> {
  const json = readTasksJson();
  const tasks: Task[] = [];
  for (const entry of json?.tasks ?? []) {
    const result = configuredTask(entry, json);
    if (!result) continue;
    if (result.needsProvider) {
      const type = result.task.definition.type;
      await activate(`onTaskType:${type}`);
      const provider = [...providers].find((p) => p.type === type)?.provider;
      const resolved = await Promise.resolve(provider?.resolveTask?.(result.task, new CancellationTokenSource().token)).catch(() => undefined);
      if (resolved?.execution) {
        // Keep what tasks.json says about the task itself.
        resolved.name = result.task.name;
        resolved.group = result.task.group ?? resolved.group;
        resolved.presentationOptions = { ...resolved.presentationOptions, ...result.task.presentationOptions };
        dependencies.set(resolved, dependencies.get(result.task)!);
        configuredLabels.set(resolved, result.task.name);
        tasks.push(resolved);
        continue;
      }
    }
    configuredLabels.set(result.task, result.task.name);
    tasks.push(result.task);
  }
  return tasks;
}

export async function fetchTasks(filter?: { type?: string }): Promise<Task[]> {
  const [own, others] = await Promise.all([configured(), provided(filter?.type)]);
  return [...own.filter((t) => !filter?.type || t.definition.type === filter.type), ...others];
}

/** Labels tasks.json gives (also to tasks of extensions' types it configures). */
const configuredLabels = new WeakMap<Task, string>();

/** How tasks are named in the UI and in `preLaunchTask`: tasks.json labels, `source: name` for providers'. */
const taskLabel = (task: Task) =>
  configuredLabels.get(task) ?? (task.source === "Workspace" ? task.name : `${task.source}: ${task.name}`);

// ---- Running --------------------------------------------------------------------------

interface Running {
  execution: { task: Task; terminate(): void };
  terminal: any;
  ended: Promise<number | undefined>;
}

const running = new Set<Running>();
/** The last terminal of each task, reused (closed) when it runs again. */
const lastTerminals = new Map<string, any>();

export const taskExecutions = () => [...running].map((r) => r.execution);

function quote(arg: string | ShellQuotedString, windows: boolean): string {
  if (typeof arg === "string") return /[\s"'`$&|<>;]/.test(arg) ? (windows ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, "'\\''")}'`) : arg;
  switch (arg.quoting) {
    case ShellQuoting.Escape:
      return windows ? arg.value.replace(/([ "'])/g, "`$1") : arg.value.replace(/([ "'\\$`])/g, "\\$1");
    case ShellQuoting.Weak:
      return `"${arg.value.replace(/"/g, '\\"')}"`;
    default:
      return windows ? `'${arg.value.replace(/'/g, "''")}'` : `'${arg.value.replace(/'/g, "'\\''")}'`;
  }
}

/** The shell (where the host runs) and its arguments to run `line`. */
function shellFor(line: string, executable?: string, shellArgs?: string[]) {
  const windows = process.platform === "win32";
  if (executable) return { shellPath: executable, shellArgs: [...(shellArgs ?? (/(^|[\\/])cmd(\.exe)?$/i.test(executable) ? ["/d", "/c"] : windows ? ["-Command"] : ["-c"])), line] };
  return windows
    ? { shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile", "-Command", line] }
    : { shellPath: process.env.SHELL || "/bin/sh", shellArgs: ["-c", line] };
}

function editorContext() {
  const editor = currentEditor();
  if (!editor) return {};
  return {
    file: editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined,
    lineNumber: editor.selection.start.line + 1,
    selectedText: editor.document.getText(editor.selection),
  };
}

async function startTerminal(task: Task): Promise<any> {
  const execution = task.execution;
  const context = editorContext();
  const folder = host.workspaceFolders[0]?.uri.fsPath;
  const name = task.name;
  if (execution instanceof CustomExecution) {
    const pty = await execution.callback(task.definition);
    return terminals.createTerminal({ name, pty });
  }
  if (!(execution instanceof ShellExecution) && !(execution instanceof ProcessExecution)) throw new Error(`The task '${name}' has nothing to run.`);
  const options = (await substitute(execution.options ?? {}, context)) as any;
  const cwd = options.cwd ? path.normalize(options.cwd) : folder;
  const env = options.env;
  if (execution instanceof ProcessExecution) {
    const args = (await substitute(execution.args, context)) as string[];
    return terminals.createTerminal({ name, shellPath: await substitute(execution.process, context), shellArgs: args, cwd, env });
  }
  const windows = process.platform === "win32" && !options.executable?.match(/(^|[\\/])(ba|z|fi)?sh(\.exe)?$/i);
  const line =
    execution.commandLine !== undefined
      ? ((await substitute(execution.commandLine, context)) as string)
      : [execution.command!, ...execution.args].map((a) => quote(a, windows)).join(" ");
  const resolvedLine = execution.commandLine !== undefined ? line : ((await substitute(line, context)) as string);
  return terminals.createTerminal({ name, ...shellFor(resolvedLine, options.executable, options.shellArgs), cwd, env });
}

export async function executeTask(task: Task): Promise<Running["execution"]> {
  return (await run(task, new Set())).execution;
}

async function run(task: Task, chain: Set<string>): Promise<Running> {
  const label = taskLabel(task);
  if (chain.has(label)) throw new Error(`The task '${label}' depends on itself.`);
  chain = new Set(chain).add(label);

  // tasks.json `dependsOn`: in parallel, or one after another (`dependsOrder: sequence`).
  const deps = dependencies.get(task);
  if (deps?.dependsOn.length) {
    const all = await configured();
    const find = (l: string) => all.find((t) => taskLabel(t) === l || t.name === l);
    const runDependency = async (l: string) => {
      const dependency = find(l);
      if (!dependency) throw new Error(`Could not find the task '${l}' that '${label}' depends on.`);
      const started = await run(dependency, chain);
      // Background tasks (watchers) are under way once started.
      if (dependency.isBackground) return;
      const code = await started.ended;
      if (code !== undefined && code !== 0) throw new Error(`The task '${l}' failed with exit code ${code}.`);
    };
    if (deps.sequence) for (const l of deps.dependsOn) await runDependency(l);
    else await Promise.all(deps.dependsOn.map(runDependency));
  }

  // A task with only dependencies is done once they are.
  if (!task.execution) {
    const execution = { task, terminate() {} };
    onDidStartTask.fire({ execution });
    onDidEndTask.fire({ execution });
    return { execution, terminal: undefined, ended: Promise.resolve(0) };
  }

  const previous = lastTerminals.get(label);
  if (previous?.exitStatus) previous.dispose();
  const terminal = await startTerminal(task);
  lastTerminals.set(label, terminal);

  const reveal = task.presentationOptions?.reveal ?? TaskRevealKind.Always;
  if (reveal === TaskRevealKind.Always || reveal === "always") terminal.show(task.presentationOptions?.focus !== true);

  const execution = { task, terminate: () => terminal.dispose() };
  let resolveEnded!: (code: number | undefined) => void;
  const ended = new Promise<number | undefined>((resolve) => (resolveEnded = resolve));
  const entry: Running = { execution, terminal, ended };
  running.add(entry);
  onDidStartTask.fire({ execution });
  void terminal.processId.then((processId: number | undefined) => {
    if (processId !== undefined && running.has(entry)) onDidStartTaskProcess.fire({ execution, processId });
  });
  const subscription = terminals.onDidCloseTerminal.event((closed: any) => {
    if (closed !== terminal) return;
    subscription.dispose();
    running.delete(entry);
    const exitCode = terminal.exitStatus?.code;
    onDidEndTaskProcess.fire({ execution, exitCode });
    onDidEndTask.fire({ execution });
    resolveEnded(exitCode);
  });
  return entry;
}

/**
 * Runs the task a debug configuration names (`preLaunchTask`). True when debugging
 * should go on: the task succeeded, is a background task under way, or the user
 * chose to debug anyway.
 */
export async function runTaskForDebugging(label: string): Promise<boolean> {
  const task = (await fetchTasks()).find((t) => taskLabel(t) === label || t.name === label);
  const ask = async (message: string) =>
    (await rpc.request<number | null>("window/showMessage", { severity: "error", message, modal: true, items: ["Debug Anyway", "Abort"] })) === 0;
  if (!task) return ask(`Could not find the task '${label}'.`);
  try {
    const started = await run(task, new Set());
    if (task.isBackground) return true;
    const code = await started.ended;
    if (code === undefined || code === 0) return true;
    return ask(`The preLaunchTask '${label}' terminated with exit code ${code}.`);
  } catch (e) {
    return ask(e instanceof Error ? e.message : String(e));
  }
}

/** `postDebugTask`: runs and is left to finish on its own. */
export function runTaskAfterDebugging(label: string) {
  void fetchTasks().then((all) => {
    const task = all.find((t) => taskLabel(t) === label || t.name === label);
    if (task) void run(task, new Set()).catch(() => {});
  });
}

// ---- The UI's commands ----------------------------------------------------------------

/** The tasks last listed for the UI, by index (the id it runs them by). */
let listed: Task[] = [];

export function listen() {
  rpc.onRequest("tasks/list", async (params: { group?: string }) => {
    const all = await fetchTasks();
    listed = params.group ? all.filter((t) => t.group?.id === params.group) : all;
    return listed.map((t, id) => ({
      id,
      label: taskLabel(t),
      source: t.source,
      detail: t.detail ?? (t.execution instanceof ShellExecution ? (t.execution.commandLine ?? undefined) : undefined),
      isDefault: t.group?.isDefault === true,
    }));
  });
  rpc.onRequest("tasks/run", async (params: { id: number }) => {
    const task = listed[params.id];
    if (!task) throw new Error("The task is no longer available.");
    await run(task, new Set());
    return true;
  });
  rpc.onRequest("tasks/runByLabel", async (params: { label: string }) => {
    const task = (await fetchTasks()).find((t) => taskLabel(t) === params.label || t.name === params.label);
    if (!task) throw new Error(`Could not find the task '${params.label}'.`);
    await run(task, new Set());
    return true;
  });
  rpc.onRequest("tasks/running",async () => [...running].map((r, id) => ({ id, label: taskLabel(r.execution.task) })));
  rpc.onRequest("tasks/terminate", async (params: { id: number }) => {
    [...running][params.id]?.execution.terminate();
    return true;
  });
}
