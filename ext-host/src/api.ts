//! The `vscode` module given to each extension: commands, window, workspace,
//! languages, env, extensions, views and webviews (views.ts) and the API value
//! types. Parts not implemented yet (debugging, SCM, ...) are inert stubs, so
//! extensions that touch them still activate.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { documentFor, documents, onDidChange, onDidClose, onDidOpen, onDidSave, saveDocument, TextDocumentImpl } from "./documents";
import * as dto from "./dto";
import { matchesGlob } from "./glob";
import { watchTree } from "./watcher";
import * as providers from "./providers";
import * as rpc from "./rpc";
import { host, lookup, onDidChangeColorTheme, onDidChangeConfiguration, type ExtensionDescription } from "./state";
import * as types from "./types";
import * as views from "./views";
import * as decorations from "./decorations";
import * as authentication from "./authentication";
import * as files from "./files";
import { BUILTIN_EXTENSIONS } from "./git";
import * as chat from "./chat";
import * as comments from "./comments";
import * as lm from "./lm";
import * as scm from "./scm";
import * as testing from "./testing";
import * as tabs from "./tabs";
import * as tasks from "./tasks";
import * as terminals from "./terminals";
import * as virtual from "./virtual";
import { SURFACE, TOP_LEVEL, type MemberKind } from "./surface";
import { createDebugApi } from "./debug";

/** One debug namespace for all extensions: sessions and breakpoints are shared. */
const debugApi = createDebugApi();
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  FileType,
  Position,
  Range,
  RelativePattern,
  Selection,
  StatusBarAlignment,
  Uri,
  WorkspaceEdit,
} from "./types";

export const VSCODE_VERSION = "1.95.0";

// ---- Commands ---------------------------------------------------------------

const commands = new Map<string, { callback: (...args: any[]) => unknown; thisArg?: unknown }>();

/** Set by the host: activates extensions waiting for `onCommand:<id>`. */
export let activateForCommand: (id: string) => Promise<void> = async () => {};
export function setCommandActivator(fn: (id: string) => Promise<void>) {
  activateForCommand = fn;
}

export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  if (!commands.has(id)) await activateForCommand(id);
  const local = commands.get(id);
  if (local) return local.callback.apply(local.thisArg, args);
  // Not an extension command: PowerCode itself may know it (vscode.open, setContext, ...).
  return rpc.request("commands/executeBuiltin", { command: id, args: args.map(serializeArg) });
}

/** Uris and ranges become JSON-friendly; other values pass as they are. */
function serializeArg(arg: unknown): unknown {
  if (Uri.isUri(arg)) return { $uri: arg.toString() };
  if (arg instanceof Range) return dto.range(arg);
  if (arg instanceof Position) return dto.position(arg);
  return arg;
}

// ---- Diagnostics ------------------------------------------------------------

const diagnosticsByOwner = new Map<string, Map<string, types.Diagnostic[]>>();
const onDidChangeDiagnostics = new EventEmitter<{ uris: Uri[] }>();
let nextCollection = 1;

function diagnosticDto(d: types.Diagnostic) {
  const code = typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
  return {
    range: dto.range(d.range),
    message: d.message,
    severity: d.severity,
    source: d.source,
    code: code === undefined ? undefined : String(code),
    tags: d.tags,
  };
}

function createDiagnosticCollection(name = "diagnostics") {
  const owner = `${name}#${nextCollection++}`;
  const entries = new Map<string, types.Diagnostic[]>();
  diagnosticsByOwner.set(owner, entries);
  const publish = (uri: string) => {
    rpc.notify("diagnostics/set", { owner, uri, diagnostics: (entries.get(uri) ?? []).map(diagnosticDto) });
    onDidChangeDiagnostics.fire({ uris: [Uri.parse(uri)] });
  };
  const collection = {
    name,
    set(uriOrEntries: Uri | [Uri, types.Diagnostic[] | undefined][], diagnostics?: types.Diagnostic[]) {
      if (Array.isArray(uriOrEntries)) {
        for (const [uri, list] of uriOrEntries) {
          entries.set(uri.toString(), list ?? []);
          publish(uri.toString());
        }
      } else {
        entries.set(uriOrEntries.toString(), [...(diagnostics ?? [])]);
        publish(uriOrEntries.toString());
      }
    },
    delete(uri: Uri) {
      entries.delete(uri.toString());
      publish(uri.toString());
    },
    clear() {
      const uris = [...entries.keys()];
      entries.clear();
      uris.forEach(publish);
    },
    forEach(callback: (uri: Uri, diagnostics: types.Diagnostic[], collection: unknown) => void) {
      for (const [uri, list] of entries) callback(Uri.parse(uri), list, collection);
    },
    get: (uri: Uri) => entries.get(uri.toString()),
    has: (uri: Uri) => entries.has(uri.toString()),
    dispose() {
      collection.clear();
      diagnosticsByOwner.delete(owner);
    },
    [Symbol.iterator]: function* () {
      for (const [uri, list] of entries) yield [Uri.parse(uri), list];
    },
  };
  return collection;
}

function getDiagnostics(uri?: Uri): any {
  if (uri) return [...diagnosticsByOwner.values()].flatMap((entries) => entries.get(uri.toString()) ?? []);
  const all = new Map<string, types.Diagnostic[]>();
  for (const entries of diagnosticsByOwner.values()) {
    for (const [key, list] of entries) all.set(key, [...(all.get(key) ?? []), ...list]);
  }
  return [...all].map(([key, list]) => [Uri.parse(key), list]);
}

// ---- Editors ----------------------------------------------------------------

const onDidChangeActiveTextEditor = new EventEmitter<unknown>();
const onDidChangeTextEditorSelection = new EventEmitter<unknown>();
const onDidChangeVisibleTextEditors = new EventEmitter<unknown[]>();
const onDidChangeTextEditorVisibleRanges = new EventEmitter<unknown>();

const toRanges = (ranges?: dto.RangeDto[]) => (ranges ?? []).map((r) => new Range(dto.toPosition(r.start), dto.toPosition(r.end)));

/** The focused editor scrolled. */
function setVisibleRanges(params: { uri: string; ranges: dto.RangeDto[] }) {
  if (!activeEditor || activeEditor.document.uri.toString() !== params.uri) return;
  activeEditor.visibleRanges = toRanges(params.ranges);
  onDidChangeTextEditorVisibleRanges.fire({ textEditor: activeEditor, visibleRanges: activeEditor.visibleRanges });
}
let activeEditor: ReturnType<typeof textEditor> | undefined;

/** The editor the user is in, for other host modules (e.g. `${file}` in debug configurations). */
export function currentEditor() {
  return activeEditor;
}

function textEditor(document: TextDocumentImpl, selections: Selection[]) {
  const editor = {
    document,
    selections,
    get selection() {
      return editor.selections[0] ?? new Selection(new Position(0, 0), new Position(0, 0));
    },
    set selection(value: Selection) {
      editor.selections = [value];
      void rpc.request("editor/reveal", { uri: document.uri.toString(), range: dto.range(value), select: true });
    },
    // Updated by the UI for the focused editor; never empty (extensions read `visibleRanges[0]`).
    visibleRanges: [new Range(0, 0, 0, 0)] as Range[],
    options: { tabSize: 4, insertSpaces: true },
    viewColumn: 1,
    async edit(callback: (builder: any) => void) {
      const edits: { range: dto.RangeDto; newText: string }[] = [];
      callback({
        replace: (where: Range | Position, text: string) =>
          edits.push({ range: dto.range(where instanceof Range ? where : new Range(where, where)), newText: text }),
        insert: (at: Position, text: string) => edits.push({ range: dto.range(new Range(at, at)), newText: text }),
        delete: (range: Range) => edits.push({ range: dto.range(range), newText: "" }),
        setEndOfLine: () => {},
      });
      return rpc.request<boolean>("workspace/applyEdit", {
        edits: [{ uri: document.uri.toString(), edits }],
        operations: [],
      });
    },
    insertSnippet(snippet: types.SnippetString, location?: Position | Range) {
      const at = location instanceof Range ? location : location ? new Range(location, location) : editor.selection;
      return rpc.request<boolean>("editor/insertSnippet", {
        uri: document.uri.toString(),
        range: dto.range(at),
        snippet: snippet.value,
      });
    },
    setDecorations(type: { key: string }, items: any[]) {
      decorations.setDecorations(document.uri, type, items, dto.range);
    },
    revealRange(range: Range) {
      void rpc.request("editor/reveal", { uri: document.uri.toString(), range: dto.range(range), select: false });
    },
    show() {},
    hide() {},
  };
  return editor;
}

/** The editors of every group showing a document, left to right (`visibleTextEditors`). */
let visibleEditors: ReturnType<typeof textEditor>[] = [];

const ORIGIN = () => new Selection(new Position(0, 0), new Position(0, 0));

function setActiveEditor(
  params: { uri: string | null; selection?: dto.RangeDto; visible?: (string | null)[]; activeIndex?: number; visibleRanges?: dto.RangeDto[] } | null,
) {
  const document = params?.uri ? documentFor(params.uri) : undefined;
  const selection = params?.selection
    ? new Selection(dto.toPosition(params.selection.start), dto.toPosition(params.selection.end))
    : ORIGIN();
  const list = params?.visible ?? (params?.uri ? [params.uri] : []);
  const activeIndex = params?.activeIndex ?? 0;
  // An editor keeps its identity while its group shows the same document.
  const previousIn = (doc: TextDocumentImpl, index: number) =>
    visibleEditors.find((e) => e.document === doc && e.viewColumn === index + 1);

  const sameActive = !!document && activeEditor?.document === document;
  if (sameActive) {
    const moved = !activeEditor!.selection.isEqual(selection);
    activeEditor!.selections = [selection];
    if (moved) onDidChangeTextEditorSelection.fire({ textEditor: activeEditor, selections: [selection], kind: undefined });
  } else if (document) {
    activeEditor = previousIn(document, activeIndex) ?? textEditor(document, [selection]);
    activeEditor.selections = [selection];
  } else {
    activeEditor = undefined;
  }

  // Never empty: extensions read `visibleRanges[0]` (e.g. where the Markdown preview opens).
  if (activeEditor) {
    const ranges = toRanges(params?.visibleRanges);
    activeEditor.visibleRanges = ranges.length ? ranges : [new Range(selection.start.line, 0, selection.start.line, 0)];
  }
  const visible = list.flatMap((uri, index) => {
    const doc = uri ? documentFor(uri) : undefined;
    if (!doc) return [];
    const editor = index === activeIndex && activeEditor?.document === doc ? activeEditor : (previousIn(doc, index) ?? textEditor(doc, [ORIGIN()]));
    editor.viewColumn = index + 1;
    return [editor];
  });
  const visibleChanged = visible.length !== visibleEditors.length || visible.some((e, i) => e !== visibleEditors[i]);
  visibleEditors = visible;
  if (!sameActive) onDidChangeActiveTextEditor.fire(activeEditor);
  if (visibleChanged) onDidChangeVisibleTextEditors.fire(visibleEditors);
}

// ---- Window -----------------------------------------------------------------

type MessageItem = string | { title: string; isCloseAffordance?: boolean };

async function showMessage(severity: "info" | "warning" | "error", message: string, ...rest: any[]) {
  const options = rest[0] && typeof rest[0] === "object" && !("title" in rest[0]) ? rest.shift() : {};
  const items: MessageItem[] = rest.flat();
  const index = await rpc.request<number | null>("window/showMessage", {
    severity,
    message,
    detail: options.detail,
    modal: options.modal ?? false,
    items: items.map((i) => (typeof i === "string" ? i : i.title)),
  });
  return index === null || index === undefined ? undefined : items[index];
}

let nextOutput = 1;

function createOutputChannel(name: string, options?: string | { log: true }) {
  const id = `${name}#${nextOutput++}`;
  rpc.notify("output/create", { id, name });
  const log = (level: string) => (message: string, ...args: unknown[]) =>
    rpc.notify("output/append", {
      id,
      text: `${new Date().toISOString()} [${level}] ${[message, ...args.map(String)].join(" ")}\n`,
    });
  return {
    name,
    logLevel: types.LogLevel.Info,
    onDidChangeLogLevel: new EventEmitter<unknown>().event,
    append: (text: string) => rpc.notify("output/append", { id, text }),
    appendLine: (text: string) => rpc.notify("output/append", { id, text: `${text}\n` }),
    replace: (text: string) => {
      rpc.notify("output/clear", { id });
      rpc.notify("output/append", { id, text });
    },
    clear: () => rpc.notify("output/clear", { id }),
    show: () => rpc.notify("output/show", { id }),
    hide: () => {},
    dispose: () => rpc.notify("output/dispose", { id }),
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warning"),
    error: (error: string | Error, ...args: unknown[]) => log("error")(error instanceof Error ? error.stack ?? error.message : error, ...args),
    ...(typeof options === "object" && options.log ? {} : {}),
  };
}

let nextStatusItem = 1;

function createStatusBarItem(idOrAlignment?: string | StatusBarAlignment, alignmentOrPriority?: number, priority?: number) {
  const [alignment, prio] =
    typeof idOrAlignment === "string" ? [alignmentOrPriority, priority] : [idOrAlignment, alignmentOrPriority];
  const id = `status#${nextStatusItem++}`;
  let visible = false;
  const state: Record<string, unknown> = {
    text: "",
    tooltip: undefined,
    command: undefined,
    name: undefined,
    alignment: alignment ?? StatusBarAlignment.Left,
    priority: prio ?? 0,
  };
  const update = () =>
    rpc.notify("statusBar/update", {
      id,
      visible,
      text: state.text,
      tooltip: typeof state.tooltip === "object" && state.tooltip ? (state.tooltip as any).value : state.tooltip,
      command:
        typeof state.command === "string" ? { command: state.command } : dto.command(state.command as types.Command),
      alignment: state.alignment,
      priority: state.priority,
    });
  return new Proxy(
    {
      id,
      show() {
        visible = true;
        update();
      },
      hide() {
        visible = false;
        update();
      },
      dispose() {
        rpc.notify("statusBar/dispose", { id });
      },
    } as Record<string | symbol, any>,
    {
      get: (target, key) => (key in target ? target[key] : state[key as string]),
      set: (_target, key, value) => {
        state[key as string] = value;
        if (visible) update();
        return true;
      },
    },
  );
}

async function showQuickPick(items: any, options: any = {}, _token?: unknown) {
  const resolved: any[] = await items;
  const labels = resolved.map((item) =>
    typeof item === "string"
      ? { label: item }
      : { label: item.label, description: item.description, detail: item.detail, picked: item.picked, separator: item.kind === -1 },
  );
  const picked = await rpc.request<number[] | null>("window/showQuickPick", {
    items: labels,
    title: options.title,
    placeHolder: options.placeHolder,
    canPickMany: options.canPickMany ?? false,
  });
  if (!picked) return undefined;
  options.onDidSelectItem?.(resolved[picked[0]]);
  return options.canPickMany ? picked.map((i) => resolved[i]) : resolved[picked[0]];
}

async function showInputBox(options: any = {}) {
  for (;;) {
    const value = await rpc.request<string | null>("window/showInputBox", {
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.value,
      password: options.password ?? false,
    });
    if (value === null || value === undefined) return undefined;
    // Validation runs here, so the box asks again until the value is accepted.
    const problem = await options.validateInput?.(value);
    const message = typeof problem === "object" && problem ? problem.message : problem;
    if (!message) return value;
    options = { ...options, value, prompt: message };
  }
}

/**
 * `createQuickPick` / `createInputBox` on top of the one-shot dialogs: `show()`
 * opens the dialog with the current items and value; changing them while it
 * is open takes effect the next time it is shown.
 */
function createQuickPick() {
  const onDidAccept = new EventEmitter<void>();
  const onDidHide = new EventEmitter<void>();
  const onDidChangeSelection = new EventEmitter<any[]>();
  const onDidChangeActive = new EventEmitter<any[]>();
  const onDidChangeValue = new EventEmitter<string>();
  const onDidTriggerButton = new EventEmitter<any>();
  const quickPick: any = {
    items: [] as any[],
    selectedItems: [] as any[],
    activeItems: [] as any[],
    value: "",
    title: undefined,
    placeholder: undefined,
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    buttons: [],
    onDidAccept: onDidAccept.event,
    onDidHide: onDidHide.event,
    onDidChangeSelection: onDidChangeSelection.event,
    onDidChangeActive: onDidChangeActive.event,
    onDidChangeValue: onDidChangeValue.event,
    onDidTriggerButton: onDidTriggerButton.event,
    onDidTriggerItemButton: new EventEmitter<any>().event,
    async show() {
      const items: any[] = quickPick.items;
      const picked = await rpc.request<number[] | null>("window/showQuickPick", {
        items: items.map((item) => ({ label: item.label, description: item.description, detail: item.detail, picked: item.picked, separator: item.kind === -1 })),
        title: quickPick.title,
        placeHolder: quickPick.placeholder,
        canPickMany: quickPick.canSelectMany,
      }).catch(() => null);
      if (picked) {
        quickPick.selectedItems = picked.map((i) => items[i]);
        quickPick.activeItems = quickPick.selectedItems;
        onDidChangeActive.fire(quickPick.activeItems);
        onDidChangeSelection.fire(quickPick.selectedItems);
        onDidAccept.fire();
      }
      onDidHide.fire();
    },
    hide() {},
    dispose() {},
  };
  return quickPick;
}

function createInputBox() {
  const onDidAccept = new EventEmitter<void>();
  const onDidHide = new EventEmitter<void>();
  const onDidChangeValue = new EventEmitter<string>();
  const inputBox: any = {
    value: "",
    title: undefined,
    prompt: undefined,
    placeholder: undefined,
    password: false,
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    validationMessage: undefined,
    buttons: [],
    onDidAccept: onDidAccept.event,
    onDidHide: onDidHide.event,
    onDidChangeValue: onDidChangeValue.event,
    onDidTriggerButton: new EventEmitter<any>().event,
    async show() {
      const value = await rpc.request<string | null>("window/showInputBox", {
        title: inputBox.title,
        prompt: inputBox.validationMessage ?? inputBox.prompt,
        placeHolder: inputBox.placeholder,
        value: inputBox.value,
        password: inputBox.password,
      }).catch(() => null);
      if (value !== null && value !== undefined) {
        inputBox.value = value;
        onDidChangeValue.fire(value);
        onDidAccept.fire();
      }
      onDidHide.fire();
    },
    hide() {},
    dispose() {},
  };
  return inputBox;
}

let nextProgress = 1;

async function withProgress(options: { title?: string; location: number; cancellable?: boolean }, task: (progress: any, token: any) => Promise<unknown>) {
  const id = nextProgress++;
  rpc.notify("progress/start", { id, title: options.title ?? "" });
  const source = new CancellationTokenSource();
  try {
    return await task({ report: (value: { message?: string }) => rpc.notify("progress/report", { id, message: value.message }) }, source.token);
  } finally {
    rpc.notify("progress/end", { id });
  }
}

async function showTextDocument(target: TextDocumentImpl | Uri, options?: { selection?: Range; preview?: boolean }) {
  const uri = target instanceof TextDocumentImpl ? target.uri : target;
  await rpc.request("window/showTextDocument", {
    uri: uri.toString(),
    selection: options?.selection ? dto.range(options.selection) : undefined,
  });
  const document = documentFor(uri) ?? (await openTextDocument(uri));
  return activeEditor?.document === document ? activeEditor : textEditor(document, [new Selection(new Position(0, 0), new Position(0, 0))]);
}

// ---- Workspace --------------------------------------------------------------

export async function openTextDocument(target?: Uri | string | { language?: string; content?: string }) {
  if (target === undefined || (typeof target === "object" && !Uri.isUri(target))) {
    const untitled = Uri.from({ scheme: "untitled", path: `Untitled-${documents.size + 1}` });
    const document = new TextDocumentImpl(untitled, (target as any)?.language ?? "plaintext", 1, (target as any)?.content ?? "");
    documents.set(untitled.toString(), document);
    return document;
  }
  const uri = typeof target === "string" ? Uri.file(target) : target;
  const existing = documentFor(uri);
  if (existing) return existing;
  // Documents of `registerTextDocumentContentProvider` / `registerFileSystemProvider` schemes.
  const text = virtual.isVirtualScheme(uri.scheme) ? await virtual.read(uri) : await fsp.readFile(uri.fsPath, "utf8");
  const languageId = await rpc.request<string>("languages/detect", { uri: uri.toString() }).catch(() => "plaintext");
  const document = new TextDocumentImpl(uri, languageId ?? "plaintext", 1, text);
  documents.set(uri.toString(), document);
  onDidOpen.fire(document);
  return document;
}

function getConfiguration(section?: string, _scope?: unknown) {
  const full = (key: string) => (section ? `${section}.${key}` : key);
  const configuration = {
    get<T>(key: string, defaultValue?: T): T | undefined {
      const value = lookup(full(key));
      return (value === undefined ? defaultValue : value) as T | undefined;
    },
    has: (key: string) => lookup(full(key)) !== undefined,
    inspect: (key: string) => ({
      key: full(key),
      defaultValue: host.defaults[full(key)],
      globalValue: host.settings[full(key)],
    }),
    update: (key: string, value: unknown) => rpc.request("configuration/update", { key: full(key), value }),
  };
  // Settings can also be read as properties: `getConfiguration("editor").tabSize`.
  return new Proxy(configuration, {
    get: (target, key) =>
      key in target || typeof key === "symbol" ? (target as any)[key] : lookup(full(String(key))),
  });
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

async function findFiles(include: string | RelativePattern, exclude?: string | RelativePattern | null, maxResults?: number) {
  const [base, pattern] =
    include instanceof RelativePattern ? [include.baseUri.fsPath, include.pattern] : [host.workspaceFolders[0]?.uri.fsPath, include];
  if (!base) return [];
  const excludePattern = exclude instanceof RelativePattern ? exclude.pattern : exclude ?? undefined;
  const results: Uri[] = [];
  const walk = async (dir: string) => {
    if (maxResults !== undefined && results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(full);
      } else if (matchesGlob(relative, pattern) && !(excludePattern && matchesGlob(relative, excludePattern))) {
        results.push(Uri.file(full));
        if (maxResults !== undefined && results.length >= maxResults) return;
      }
    }
  };
  await walk(base);
  return results;
}

function createFileSystemWatcher(pattern: string | RelativePattern, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) {
  const [base, glob] =
    pattern instanceof RelativePattern ? [pattern.baseUri.fsPath, pattern.pattern] : [host.workspaceFolders[0]?.uri.fsPath, pattern];
  const created = new EventEmitter<Uri>();
  const changed = new EventEmitter<Uri>();
  const deleted = new EventEmitter<Uri>();
  let stop: (() => void) | undefined;
  if (base) {
    // Shared and bounded (see watcher.ts): `*.json` watches one folder, `**/x` the tree.
    const recursive = glob.includes("/") || glob.includes("**");
    stop = watchTree(base, recursive, (event, full) => {
      const relative = path.relative(base, full).replace(/\\/g, "/");
      if (relative.startsWith("..") || relative.split("/").some((part) => SKIPPED_DIRECTORIES.has(part)) || !matchesGlob(relative, glob)) return;
      const uri = Uri.file(full);
      fs.stat(full, (error) => {
        if (error) !ignoreDelete && deleted.fire(uri);
        else if (event === "rename") !ignoreCreate && created.fire(uri);
        else !ignoreChange && changed.fire(uri);
      });
    });
  }
  return {
    ignoreCreateEvents: ignoreCreate,
    ignoreChangeEvents: ignoreChange,
    ignoreDeleteEvents: ignoreDelete,
    onDidCreate: created.event,
    onDidChange: changed.event,
    onDidDelete: deleted.event,
    dispose: () => stop?.(),
  };
}

/** The `FileSystemProvider` an extension registered for `uri`'s scheme; files use Node's fs. */
const providerOf = (uri: Uri) => (uri.scheme === "file" ? undefined : virtual.fileSystemFor(uri)?.provider);

const workspaceFs = {
  async stat(uri: Uri) {
    const provider = providerOf(uri);
    if (provider) return provider.stat(uri);
    const s = await fsp.stat(uri.fsPath);
    return {
      type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown,
      ctime: s.ctimeMs,
      mtime: s.mtimeMs,
      size: s.size,
    };
  },
  async readDirectory(uri: Uri) {
    const provider = providerOf(uri);
    if (provider) return provider.readDirectory(uri);
    const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]);
  },
  async readFile(uri: Uri) {
    const provider = providerOf(uri);
    return provider ? provider.readFile(uri) : new Uint8Array(await fsp.readFile(uri.fsPath));
  },
  async writeFile(uri: Uri, content: Uint8Array) {
    const provider = providerOf(uri);
    if (provider) return provider.writeFile(uri, content, { create: true, overwrite: true });
    await fsp.writeFile(uri.fsPath, content);
  },
  async createDirectory(uri: Uri) {
    const provider = providerOf(uri);
    if (provider) return provider.createDirectory(uri);
    await fsp.mkdir(uri.fsPath, { recursive: true });
  },
  async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }) {
    const provider = providerOf(uri);
    if (provider) return provider.delete(uri, { recursive: options?.recursive ?? false, useTrash: false });
    await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: false });
  },
  async rename(from: Uri, to: Uri, options?: { overwrite?: boolean }) {
    const provider = providerOf(from);
    if (provider && from.scheme === to.scheme) return provider.rename(from, to, { overwrite: options?.overwrite ?? false });
    if (provider || providerOf(to)) {
      await workspaceFs.copy(from, to, options);
      return workspaceFs.delete(from, { recursive: true });
    }
    await fsp.rename(from.fsPath, to.fsPath);
  },
  async copy(from: Uri, to: Uri, options?: { overwrite?: boolean }) {
    const provider = providerOf(from);
    if (provider?.copy && from.scheme === to.scheme) return provider.copy(from, to, { overwrite: options?.overwrite ?? false });
    // Across schemes (or without `copy`): a file's bytes.
    if (provider || providerOf(to)) return workspaceFs.writeFile(to, await workspaceFs.readFile(from));
    await fsp.cp(from.fsPath, to.fsPath, { recursive: true });
  },
  isWritableFileSystem(scheme: string) {
    if (scheme === "file") return true;
    const fs = virtual.fileSystemFor(Uri.from({ scheme, path: "/" }));
    return fs ? !fs.readonly : undefined;
  },
};

// ---- Misc helpers -------------------------------------------------------------

/** An event that never fires, for API parts PowerCode does not produce. */
const never = () => new EventEmitter<any>().event;

/** Inert stand-ins for namespaces not implemented yet; each logs once when first used. */
function stub(name: string): any {
  const warned = new Set<string>();
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key === "symbol") return undefined;
        if (key.startsWith("onDid") || key.startsWith("onWill")) return never();
        return (..._args: unknown[]) => {
          if (!warned.has(key)) {
            warned.add(key);
            rpc.notify("log", { level: "warning", message: `vscode.${name}.${key} is not supported yet` });
          }
          return inertObject();
        };
      },
    },
  );
}

/** An object that absorbs any use: properties are no-op functions or events, and dispose works. */
function inertObject(): any {
  return new Proxy(() => {}, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      if (typeof key === "string" && (key.startsWith("onDid") || key.startsWith("onWill"))) return never();
      return inertObject();
    },
    apply: () => inertObject(),
  });
}

/**
 * A stand-in for an API class PowerCode lacks: it can be constructed and
 * extended, and its static members (`Foo.create(...)`, `Foo.Default`) are inert
 * instead of undefined, so module-level uses do not throw.
 */
const inertClasses = new Map<string, unknown>();
function inertClass(name: string): unknown {
  let cls = inertClasses.get(name);
  if (!cls) {
    // Logged when an extension uses it (not when the API is built: most never are).
    let warned = false;
    const warn = () => {
      if (warned) return;
      warned = true;
      rpc.notify("log", { level: "warning", message: `vscode.${name} is not supported yet` });
    };
    cls = new Proxy(class {}, {
      get: (target, key, receiver) => {
        if (key in target || typeof key === "symbol") return Reflect.get(target, key, receiver);
        warn();
        return inertObject();
      },
      construct: (target, args, newTarget) => {
        warn();
        return Reflect.construct(target, args, newTarget);
      },
    });
    inertClasses.set(name, cls);
  }
  return cls;
}

/**
 * Adds the members of namespace `name` that PowerCode does not implement, by
 * kind: events that never fire, `register*` functions returning a Disposable,
 * functions returning a promise of `undefined`, empty lists. Calling one logs
 * once, so the Extension Host output says what an extension missed.
 */
function completeNamespace(name: string, namespace: Record<string, unknown>, members: Record<string, MemberKind>) {
  const warned = new Set<string>();
  const warn = (member: string) => {
    if (warned.has(member)) return;
    warned.add(member);
    rpc.notify("log", { level: "warning", message: `vscode.${name}.${member} is not supported yet` });
  };
  // Which members are only stand-ins (for diagnostics: `globalThis.__powercodeUnimplemented`).
  const registry = ((globalThis as any).__powercodeUnimplemented ??= {}) as Record<string, string[]>;
  for (const [member, kind] of Object.entries(members)) {
    if (member in namespace) continue;
    if (!(registry[name] ??= []).includes(member)) registry[name].push(member);
    let value: unknown;
    switch (kind) {
      case "event":
        value = never();
        break;
      case "array":
        value = [];
        break;
      case "property":
        value = undefined;
        break;
      case "disposable":
        value = () => (warn(member), new Disposable(() => {}));
        break;
      case "promise":
        value = () => (warn(member), Promise.resolve(undefined));
        break;
      case "value":
        // `create*` returns an object the extension goes on using: an inert one absorbs that.
        value = () => (warn(member), member.startsWith("create") ? inertObject() : undefined);
        break;
    }
    namespace[member] = value;
  }
  return namespace;
}

function formatL10n(message: string, args: unknown[]) {
  const named = args.length === 1 && typeof args[0] === "object" && args[0] !== null ? (args[0] as Record<string, unknown>) : null;
  return message.replace(/\{(\w+)\}/g, (match, key) =>
    named ? String(named[key] ?? match) : String(args[Number(key)] ?? match),
  );
}

/** An extension PowerCode provides itself (`vscode.git`), when the real one is not installed. */
function builtinExtension(id: string) {
  const builtin = BUILTIN_EXTENSIONS[id];
  if (!builtin) return undefined;
  return {
    id,
    extensionUri: Uri.file(host.appRoot || "/"),
    extensionPath: host.appRoot,
    packageJSON: { name: builtin.name, publisher: "vscode", displayName: builtin.displayName, version: VSCODE_VERSION },
    extensionKind: types.ExtensionKind.Workspace,
    isActive: true,
    exports: builtin.exports,
    activate: () => Promise.resolve(builtin.exports),
  };
}

function extensionObject(description: ExtensionDescription, state: { exports?: unknown; active: boolean }) {
  return {
    id: `${description.manifest.publisher}.${description.manifest.name}`,
    extensionUri: Uri.file(description.path),
    extensionPath: description.path,
    packageJSON: description.manifest,
    extensionKind: types.ExtensionKind.Workspace,
    get isActive() {
      return state.active;
    },
    get exports() {
      return state.exports;
    },
    activate: () => Promise.resolve(state.exports),
  };
}

/** Activation state of every extension, shared with the host's activation logic. */
export const extensionStates = new Map<string, { exports?: unknown; active: boolean; activate?: Promise<void> }>();

/** Builds the `vscode` module for one extension. */
export function createApi(description: ExtensionDescription) {
  const extensionId = description.id;
  const api: Record<string, unknown> = {
    ...types,
    version: VSCODE_VERSION,

    commands: {
      registerCommand(id: string, callback: (...args: any[]) => unknown, thisArg?: unknown) {
        commands.set(id, { callback, thisArg });
        return new Disposable(() => commands.delete(id));
      },
      registerTextEditorCommand(id: string, callback: (editor: unknown, edit: unknown, ...args: any[]) => unknown, thisArg?: unknown) {
        commands.set(id, {
          callback: (...args: any[]) => activeEditor && activeEditor.edit((edit: unknown) => callback.call(thisArg, activeEditor, edit, ...args)),
        });
        return new Disposable(() => commands.delete(id));
      },
      executeCommand,
      getCommands: async () => [...commands.keys()],
    },

    window: {
      get activeTextEditor() {
        return activeEditor;
      },
      get visibleTextEditors() {
        return visibleEditors.length || !activeEditor ? visibleEditors : [activeEditor];
      },
      get terminals() {
        return terminals.terminals();
      },
      get activeTerminal() {
        return terminals.activeTerminal();
      },
      get activeColorTheme() {
        return { kind: host.colorThemeKind };
      },
      state: { focused: true, active: true },
      tabGroups: tabs.tabGroups,
      onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
      onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
      onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
      onDidChangeTextEditorVisibleRanges: onDidChangeTextEditorVisibleRanges.event,
      onDidChangeTextEditorOptions: never(),
      onDidChangeWindowState: never(),
      onDidChangeActiveColorTheme: onDidChangeColorTheme.event,
      onDidOpenTerminal: terminals.onDidOpenTerminal.event,
      onDidCloseTerminal: terminals.onDidCloseTerminal.event,
      onDidChangeActiveTerminal: terminals.onDidChangeActiveTerminal.event,
      onDidChangeTerminalState: terminals.onDidChangeTerminalState.event,
      showInformationMessage: (message: string, ...rest: any[]) => showMessage("info", message, ...rest),
      showWarningMessage: (message: string, ...rest: any[]) => showMessage("warning", message, ...rest),
      showErrorMessage: (message: string, ...rest: any[]) => showMessage("error", message, ...rest),
      showQuickPick,
      showInputBox,
      createOutputChannel,
      createStatusBarItem,
      setStatusBarMessage(text: string, hideAfter?: number | PromiseLike<unknown>) {
        rpc.notify("statusBar/message", { text });
        const clear = () => rpc.notify("statusBar/message", { text: "" });
        if (typeof hideAfter === "number") setTimeout(clear, hideAfter);
        else hideAfter?.then(clear, clear);
        return new Disposable(clear);
      },
      withProgress,
      showTextDocument,
      async showOpenDialog(options: any = {}) {
        const paths = await rpc.request<string[] | null>("window/showOpenDialog", {
          canSelectFolders: options.canSelectFolders ?? false,
          canSelectMany: options.canSelectMany ?? false,
          title: options.title,
        });
        return paths?.map((p) => Uri.file(p));
      },
      async showSaveDialog(options: any = {}) {
        const file = await rpc.request<string | null>("window/showSaveDialog", { title: options.title });
        return file ? Uri.file(file) : undefined;
      },
      showWorkspaceFolderPick: async () => host.workspaceFolders[0],
      createTerminal: terminals.createTerminal,
      createTextEditorDecorationType: (options: unknown) => decorations.createDecorationType(options),
      registerUriHandler: () => new Disposable(() => {}),
      // Proposed API (the GitHub extension's "Copy vscode.dev Link"): PowerCode has no Share menu.
      registerShareProvider: () => new Disposable(() => {}),
      registerTreeDataProvider(viewId: string, treeDataProvider: unknown) {
        const view = views.registerTree(viewId, { treeDataProvider });
        return new Disposable(() => view.dispose());
      },
      createTreeView: (viewId: string, options: unknown) => views.registerTree(viewId, options),
      registerWebviewViewProvider: (viewId: string, provider: unknown, options?: unknown) =>
        views.registerWebviewViewProvider(extensionId, viewId, provider, options),
      createWebviewPanel: (viewType: string, title: string, showOptions: unknown, options?: unknown) =>
        views.createWebviewPanel(extensionId, viewType, title, showOptions, options),
      registerWebviewPanelSerializer: () => new Disposable(() => {}),
      registerCustomEditorProvider: (viewType: string, provider: unknown, options?: unknown) =>
        views.registerCustomEditorProvider(extensionId, viewType, provider, options),
      registerFileDecorationProvider: () => new Disposable(() => {}),
      registerTerminalLinkProvider: () => new Disposable(() => {}),
      registerTerminalProfileProvider: () => new Disposable(() => {}),
      createQuickPick,
      createInputBox,
    },

    workspace: {
      get workspaceFolders() {
        return host.workspaceFolders.length ? host.workspaceFolders : undefined;
      },
      get name() {
        return host.workspaceFolders[0]?.name;
      },
      get rootPath() {
        return host.workspaceFolders[0]?.uri.fsPath;
      },
      workspaceFile: undefined,
      get isTrusted() {
        return host.trusted;
      },
      get textDocuments() {
        return [...documents.values()].filter((d) => !d.isClosed);
      },
      notebookDocuments: [],
      getWorkspaceFolder: (uri: Uri) =>
        host.workspaceFolders.find((f) => uri.fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase())),
      asRelativePath(pathOrUri: string | Uri) {
        const full = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
        const root = host.workspaceFolders[0]?.uri.fsPath;
        return root && full.toLowerCase().startsWith(root.toLowerCase())
          ? path.relative(root, full).replace(/\\/g, "/")
          : full;
      },
      getConfiguration,
      openTextDocument,
      findFiles,
      createFileSystemWatcher,
      // Proposed API (the GitHub extension maps vscode.dev URIs with it): nothing to map here.
      registerCanonicalUriProvider: () => new Disposable(() => {}),
      fs: workspaceFs,
      async applyEdit(edit: WorkspaceEdit) {
        return rpc.request<boolean>("workspace/applyEdit", dto.workspaceEdit(edit));
      },
      saveAll: () => rpc.request<boolean>("workspace/saveAll", {}),
      async save(uri: Uri) {
        return (await saveDocument(uri)) ? uri : undefined;
      },
      async saveAs(uri: Uri) {
        const saved = await rpc.request<string | null>("documents/saveAs", { uri: uri.toString() });
        return saved ? Uri.parse(saved) : undefined;
      },
      updateWorkspaceFolders: () => false,
      registerTextDocumentContentProvider: (scheme: string, provider: unknown) => virtual.registerContentProvider(scheme, provider),
      registerFileSystemProvider: (scheme: string, provider: unknown, options?: { isReadonly?: unknown }) =>
        virtual.registerFileSystem(scheme, provider, options),
      // Deprecated home of `tasks.registerTaskProvider`.
      registerTaskProvider: (type: string, provider: unknown) => tasks.registerTaskProvider(type, provider),
      onDidOpenTextDocument: onDidOpen.event,
      onDidCloseTextDocument: onDidClose.event,
      onDidChangeTextDocument: onDidChange.event,
      onDidSaveTextDocument: onDidSave.event,
      onWillSaveTextDocument: files.onWillSave.event,
      onDidChangeConfiguration: onDidChangeConfiguration.event,
      onDidChangeWorkspaceFolders: never(),
      // Operations the user makes in PowerCode (and `applyEdit` file operations), not `workspace.fs`, as in VS Code.
      onDidCreateFiles: files.onDidCreate.event,
      onDidDeleteFiles: files.onDidDelete.event,
      onDidRenameFiles: files.onDidRename.event,
      onWillCreateFiles: files.onWillCreate.event,
      onWillDeleteFiles: files.onWillDelete.event,
      onWillRenameFiles: files.onWillRename.event,
      // The UI restarts the host when trust is granted, so this never fires within a host.
      onDidGrantWorkspaceTrust: never(),
      onDidOpenNotebookDocument: never(),
      onDidCloseNotebookDocument: never(),
      onDidChangeNotebookDocument: never(),
    },

    languages: {
      getLanguages: async () => host.languages,
      match: providers.match,
      createDiagnosticCollection,
      getDiagnostics,
      onDidChangeDiagnostics: onDidChangeDiagnostics.event,
      setTextDocumentLanguage: async (document: TextDocumentImpl, languageId: string) => {
        document.languageId = languageId;
        return document;
      },
      setLanguageConfiguration(language: string, configuration: any) {
        const regex = (r?: RegExp) => (r ? { source: r.source, flags: r.flags } : undefined);
        rpc.notify("languages/configuration", {
          language,
          configuration: {
            comments: configuration.comments,
            brackets: configuration.brackets,
            wordPattern: regex(configuration.wordPattern),
            indentationRules: configuration.indentationRules && {
              increaseIndentPattern: regex(configuration.indentationRules.increaseIndentPattern),
              decreaseIndentPattern: regex(configuration.indentationRules.decreaseIndentPattern),
            },
          },
        });
        return new Disposable(() => {});
      },
      registerCompletionItemProvider: (selector: providers.DocumentSelector, provider: unknown, ...triggerCharacters: string[]) =>
        providers.register("completion", extensionId, selector, provider, { triggerCharacters }),
      registerHoverProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("hover", extensionId, s, p),
      registerDefinitionProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("definition", extensionId, s, p),
      registerDeclarationProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("declaration", extensionId, s, p),
      registerTypeDefinitionProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("typeDefinition", extensionId, s, p),
      registerImplementationProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("implementation", extensionId, s, p),
      registerReferenceProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("references", extensionId, s, p),
      registerDocumentHighlightProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("documentHighlight", extensionId, s, p),
      registerDocumentSymbolProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("documentSymbol", extensionId, s, p),
      registerDocumentFormattingEditProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("formatting", extensionId, s, p),
      registerDocumentRangeFormattingEditProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("rangeFormatting", extensionId, s, p),
      registerOnTypeFormattingEditProvider: (s: providers.DocumentSelector, p: unknown, first: string, ...more: string[]) =>
        providers.register("onTypeFormatting", extensionId, s, p, { triggerCharacters: [first, ...more] }),
      registerCodeActionsProvider: (s: providers.DocumentSelector, p: unknown, metadata?: { providedCodeActionKinds?: { value: string }[] }) =>
        providers.register("codeActions", extensionId, s, p, { kinds: metadata?.providedCodeActionKinds?.map((k) => k.value) }),
      registerCodeLensProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("codeLens", extensionId, s, p),
      registerSignatureHelpProvider: (s: providers.DocumentSelector, p: unknown, first?: string | { triggerCharacters: string[]; retriggerCharacters?: string[] }, ...more: string[]) =>
        providers.register("signatureHelp", extensionId, s, p,
          typeof first === "object" ? first : { triggerCharacters: first ? [first, ...more] : [], retriggerCharacters: [] }),
      registerRenameProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("rename", extensionId, s, p),
      registerFoldingRangeProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("foldingRanges", extensionId, s, p),
      registerDocumentLinkProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("documentLinks", extensionId, s, p),
      registerInlayHintsProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("inlayHints", extensionId, s, p),
      registerColorProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("colors", extensionId, s, p),
      registerSelectionRangeProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("selectionRanges", extensionId, s, p),
      registerLinkedEditingRangeProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("linkedEditing", extensionId, s, p),
      registerInlineCompletionItemProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("inlineCompletions", extensionId, s, p),
      // Not tied to documents: the UI asks every one of them (Go to Symbol in Workspace).
      registerWorkspaceSymbolProvider: (p: unknown) => providers.register("workspaceSymbols", extensionId, "*", p),
      // Merged with the TextMate colouring in the UI (semantic tokens drawn over it, as in VS Code).
      registerDocumentSemanticTokensProvider: (s: providers.DocumentSelector, p: unknown, legend: types.SemanticTokensLegend) =>
        providers.register("semanticTokens", extensionId, s, p, { legend: { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers } }),
      registerDocumentRangeSemanticTokensProvider: (s: providers.DocumentSelector, p: unknown, legend: types.SemanticTokensLegend) =>
        providers.register("rangeSemanticTokens", extensionId, s, p, { legend: { tokenTypes: legend.tokenTypes, tokenModifiers: legend.tokenModifiers } }),
      registerCallHierarchyProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("callHierarchy", extensionId, s, p),
      registerTypeHierarchyProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("typeHierarchy", extensionId, s, p),
      registerEvaluatableExpressionProvider: (s: providers.DocumentSelector, p: unknown) =>
        providers.register("evaluatableExpression", extensionId, s, p),
      registerInlineValuesProvider: (s: providers.DocumentSelector, p: unknown) => providers.register("inlineValues", extensionId, s, p),
      registerDocumentDropEditProvider: (
        s: providers.DocumentSelector,
        p: unknown,
        metadata?: { providedDropEditKinds?: { value: string }[]; dropMimeTypes?: string[] },
      ) =>
        providers.register("drop", extensionId, s, p, {
          kinds: metadata?.providedDropEditKinds?.map((k) => k.value) ?? [],
          // Without metadata VS Code offers it every drop.
          mimeTypes: metadata?.dropMimeTypes ?? ["*/*"],
        }),
      registerDocumentPasteEditProvider: (
        s: providers.DocumentSelector,
        p: { prepareDocumentPaste?: unknown },
        metadata: { providedPasteEditKinds?: { value: string }[]; copyMimeTypes?: string[]; pasteMimeTypes?: string[] },
      ) =>
        providers.register("paste", extensionId, s, p, {
          kinds: metadata?.providedPasteEditKinds?.map((k) => k.value) ?? [],
          copyMimeTypes: metadata?.copyMimeTypes ?? [],
          mimeTypes: metadata?.pasteMimeTypes ?? [],
          prepare: typeof p?.prepareDocumentPaste === "function",
        }),
      createLanguageStatusItem: (id: string) => ({ id, text: "", severity: 0, dispose() {} }),
      // Proposed API the built-in TypeScript extension calls unconditionally (highlights
      // across open files); accepted so it registers the rest of its features.
      registerMultiDocumentHighlightProvider: () => new Disposable(() => {}),
    },

    env: {
      appName: "PowerCode",
      appRoot: host.appRoot,
      appHost: "desktop",
      language: "en",
      machineId: "powercode",
      sessionId: `${Date.now()}`,
      uriScheme: "powercode",
      shell: process.env.SHELL ?? process.env.ComSpec ?? "",
      uiKind: types.UIKind.Desktop,
      remoteName: undefined,
      isNewAppInstall: false,
      isTelemetryEnabled: false,
      onDidChangeTelemetryEnabled: never(),
      onDidChangeShell: never(),
      logLevel: types.LogLevel.Info,
      onDidChangeLogLevel: never(),
      clipboard: {
        readText: () => rpc.request<string>("env/clipboardRead", {}),
        writeText: (text: string) => rpc.request("env/clipboardWrite", { text }).then(() => undefined),
      },
      openExternal: (uri: Uri) => rpc.request<boolean>("env/openExternal", { uri: uri.toString() }),
      asExternalUri: async (uri: Uri) => uri,
      createTelemetryLogger: () => inertObject(),
    },

    extensions: {
      getExtension(id: string) {
        const description = host.extensions.find((e) => e.id === id.toLowerCase());
        if (!description) return builtinExtension(id.toLowerCase());
        let state = extensionStates.get(description.id);
        if (!state) {
          state = { active: false };
          extensionStates.set(description.id, state);
        }
        return extensionObject(description, state);
      },
      get all() {
        const installed = host.extensions.map((e) => (api.extensions as any).getExtension(e.id));
        const builtins = Object.keys(BUILTIN_EXTENSIONS).filter((id) => !host.extensions.some((e) => e.id === id)).map(builtinExtension);
        return [...installed, ...builtins];
      },
      onDidChange: never(),
    },

    l10n: {
      t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]) =>
        typeof message === "string" ? formatL10n(message, args) : formatL10n(message.message, message.args ?? []),
      bundle: undefined,
      uri: undefined,
    },

    debug: debugApi,
    // Not implemented yet: completed from the API's definition below.
    tasks: {
      registerTaskProvider: tasks.registerTaskProvider,
      fetchTasks: tasks.fetchTasks,
      executeTask: tasks.executeTask,
      get taskExecutions() {
        return tasks.taskExecutions();
      },
      onDidStartTask: tasks.onDidStartTask.event,
      onDidEndTask: tasks.onDidEndTask.event,
      onDidStartTaskProcess: tasks.onDidStartTaskProcess.event,
      onDidEndTaskProcess: tasks.onDidEndTaskProcess.event,
    },
    scm: {
      createSourceControl: scm.createSourceControl,
      get inputBox() {
        return scm.firstInputBox();
      },
    },
    comments: {
      createCommentController: comments.createCommentController,
    },
    tests: {
      createTestController: testing.createTestController,
    },
    notebooks: {},
    authentication: {
      registerAuthenticationProvider: authentication.registerAuthenticationProvider,
      getSession: (providerId: string, scopes: readonly string[], options?: unknown) =>
        authentication.getSession(extensionId, providerId, scopes, options),
      getAccounts: authentication.getAccounts,
      onDidChangeSessions: authentication.onDidChangeSessions.event,
    },
    chat: {
      createChatParticipant: (id: string, handler: unknown) => chat.createChatParticipant(extensionId, id, handler),
      // Proposed API (the built-in TypeScript extension registers one): nothing asks for mapped edits here.
      registerMappedEditsProvider: () => new Disposable(() => {}),
      registerMappedEditsProvider2: () => new Disposable(() => {}),
    },
    lm: {
      registerLanguageModelChatProvider: (vendor: string, provider: unknown) => lm.registerLanguageModelChatProvider(extensionId, vendor, provider),
      selectChatModels: (selector?: { vendor?: string; family?: string; version?: string; id?: string }) => lm.selectChatModels(extensionId, selector),
      onDidChangeChatModels: lm.onDidChangeChatModels.event,
      registerTool: (name: string, tool: unknown) => lm.registerTool(extensionId, name, tool),
      invokeTool: lm.invokeTool,
      get tools() {
        return lm.toolInfos();
      },
      registerMcpServerDefinitionProvider: lm.registerMcpServerDefinitionProvider,
    },
  };

  // Every member VS Code has exists, implemented or not (see completeNamespace).
  for (const [name, members] of Object.entries(SURFACE)) {
    api[name] = completeNamespace(name, (api[name] as Record<string, unknown>) ?? {}, members);
  }
  // So do its classes and enums: bundlers copy the module's own properties.
  for (const name of TOP_LEVEL) {
    if (!(name in api)) api[name] = inertClass(name);
  }

  // Unknown members (newer API) get inert stand-ins rather than `undefined`.
  return new Proxy(api, {
    get: (target, key) => {
      if (key in target || typeof key === "symbol") return (target as any)[key];
      return /^[A-Z]/.test(key) ? inertClass(key) : stub(key);
    },
  });
}

export const hostEvents = { setActiveEditor, setVisibleRanges };
