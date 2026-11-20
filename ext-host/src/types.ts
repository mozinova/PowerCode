//! The value types of the `vscode` API (positions, ranges, diagnostics,
//! completion items, ...), following VS Code's own definitions.

import { URI, Utils } from "vscode-uri";

/**
 * `vscode.Uri` is VS Code's own URI class (the one Monaco uses too, so URIs
 * print identically on both sides), plus `Uri.joinPath`. Being the same
 * class, `instanceof vscode.Uri` holds for every URI an extension receives.
 */
export const Uri = URI as typeof URI & { joinPath: typeof Utils.joinPath };
Uri.joinPath = Utils.joinPath;
export type Uri = URI;

export class Disposable {
  static from(...disposables: { dispose(): unknown }[]) {
    return new Disposable(() => disposables.forEach((d) => d?.dispose()));
  }
  private disposed = false;
  constructor(private readonly callOnDispose: () => unknown) {}
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.callOnDispose();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const disposable = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(disposable);
    return disposable;
  };
  fire(data: T) {
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (e) {
        console.error(e);
      }
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() {
    this.emitter.dispose();
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isBefore(other: Position) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: Position) {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other: Position) {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: Position) {
    return !this.isBefore(other);
  }
  isEqual(other: Position) {
    return this.line === other.line && this.character === other.character;
  }
  compareTo(other: Position) {
    return this.isBefore(other) ? -1 : this.isEqual(other) ? 0 : 1;
  }
  translate(lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0) {
    if (typeof lineDelta === "object") {
      return new Position(this.line + (lineDelta.lineDelta ?? 0), this.character + (lineDelta.characterDelta ?? 0));
    }
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line: number | { line?: number; character?: number } = this.line, character = this.character) {
    if (typeof line === "object") return new Position(line.line ?? this.line, line.character ?? this.character);
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    const [a, b] =
      typeof start === "number"
        ? [new Position(start, end as number), new Position(endLine!, endCharacter!)]
        : [start, end as Position];
    [this.start, this.end] = a.isBefore(b) ? [a, b] : [b, a];
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(value: Position | Range): boolean {
    if (value instanceof Range) return this.contains(value.start) && this.contains(value.end);
    return value.isAfterOrEqual(this.start) && value.isBeforeOrEqual(this.end);
  }
  isEqual(other: Range) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other: Range) {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other: Range) {
    return new Range(
      this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end,
    );
  }
  with(start: Position | { start?: Position; end?: Position } = this.start, end = this.end) {
    if (start instanceof Position) return new Range(start, end);
    return new Range(start.start ?? this.start, start.end ?? this.end);
  }
}

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {
    super(anchor, active);
  }
  get isReversed() {
    return this.anchor === this.end;
  }
}

export class Location {
  readonly range: Range;
  /** A position stands for an empty range there, as in VS Code. */
  constructor(
    readonly uri: Uri,
    rangeOrPosition: Range | Position,
  ) {
    this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export class DiagnosticRelatedInformation {
  constructor(
    readonly location: Location,
    readonly message: string,
  ) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  tags?: DiagnosticTag[];
  relatedInformation?: DiagnosticRelatedInformation[];
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export class MarkdownString {
  isTrusted?: boolean;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  constructor(
    public value = "",
    supportThemeIcons = false,
  ) {
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(text: string) {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }
  appendMarkdown(markdown: string) {
    this.value += markdown;
    return this;
  }
  appendCodeblock(code: string, language = "") {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class SnippetString {
  constructor(public value = "") {}
  appendText(text: string) {
    this.value += text.replace(/[$}\\]/g, "\\$&");
    return this;
  }
  appendPlaceholder(value: string, number = 1) {
    this.value += `\${${number}:${value}}`;
    return this;
  }
  appendTabstop(number = 0) {
    this.value += `$${number}`;
    return this;
  }
}

export class Hover {
  contents: (MarkdownString | string)[];
  constructor(
    contents: MarkdownString | string | (MarkdownString | string)[],
    public range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export enum CompletionItemKind {
  Text, Method, Function, Constructor, Field, Variable, Class, Interface, Module, Property, Unit, Value,
  Enum, Keyword, Snippet, Color, File, Reference, Folder, EnumMember, Constant, Struct, Event, Operator,
  TypeParameter, User, Issue,
}

export enum CompletionItemTag {
  Deprecated = 1,
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2,
}

export class CompletionItem {
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  additionalTextEdits?: TextEdit[];
  command?: Command;
  tags?: CompletionItemTag[];
  constructor(
    public label: string | { label: string; detail?: string; description?: string },
    kind?: CompletionItemKind,
  ) {
    this.kind = kind;
  }
}

export class CompletionList {
  constructor(
    public items: CompletionItem[] = [],
    public isIncomplete = false,
  ) {}
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export class TextEdit {
  static replace(range: Range, newText: string) {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string) {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range) {
    return new TextEdit(range, "");
  }
  static setEndOfLine() {
    return new TextEdit(new Range(0, 0, 0, 0), "");
  }
  constructor(
    public range: Range,
    public newText: string,
  ) {}
}

export class WorkspaceEdit {
  private edits = new Map<string, { uri: Uri; edits: TextEdit[] }>();
  private fileOps: { kind: "create" | "delete" | "rename"; uri?: Uri; from?: Uri; to?: Uri }[] = [];
  get size() {
    return this.edits.size;
  }
  private entry(uri: Uri) {
    const key = uri.toString();
    let entry = this.edits.get(key);
    if (!entry) {
      entry = { uri, edits: [] };
      this.edits.set(key, entry);
    }
    return entry;
  }
  replace(uri: Uri, range: Range, newText: string) {
    this.entry(uri).edits.push(new TextEdit(range, newText));
  }
  insert(uri: Uri, position: Position, newText: string) {
    this.entry(uri).edits.push(TextEdit.insert(position, newText));
  }
  delete(uri: Uri, range: Range) {
    this.entry(uri).edits.push(TextEdit.delete(range));
  }
  set(uri: Uri, edits: TextEdit[]) {
    this.entry(uri).edits = [...edits];
  }
  get(uri: Uri) {
    return this.edits.get(uri.toString())?.edits ?? [];
  }
  has(uri: Uri) {
    return this.edits.has(uri.toString());
  }
  entries(): [Uri, TextEdit[]][] {
    return [...this.edits.values()].map((e) => [e.uri, e.edits]);
  }
  createFile(uri: Uri) {
    this.fileOps.push({ kind: "create", uri });
  }
  deleteFile(uri: Uri) {
    this.fileOps.push({ kind: "delete", uri });
  }
  renameFile(from: Uri, to: Uri) {
    this.fileOps.push({ kind: "rename", from, to });
  }
  /** Not part of the API: file operations, for applying the edit. */
  get operations() {
    return this.fileOps;
  }
}

export enum SymbolKind {
  File, Module, Namespace, Package, Class, Method, Property, Field, Constructor, Enum, Interface, Function,
  Variable, Constant, String, Number, Boolean, Array, Object, Key, Null, EnumMember, Struct, Event, Operator,
  TypeParameter,
}

export enum SymbolTag {
  Deprecated = 1,
}

export class DocumentSymbol {
  children: DocumentSymbol[] = [];
  tags?: SymbolTag[];
  constructor(
    public name: string,
    public detail: string,
    public kind: SymbolKind,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

export class SymbolInformation {
  location: Location;
  constructor(
    public name: string,
    public kind: SymbolKind,
    containerNameOrRange: string | Range,
    locationOrUri?: Location | Uri,
    public containerName = "",
  ) {
    if (containerNameOrRange instanceof Range) {
      this.location = new Location(locationOrUri as Uri, containerNameOrRange);
    } else {
      this.containerName = containerNameOrRange;
      this.location = locationOrUri as Location;
    }
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly Notebook = new CodeActionKind("notebook");
  constructor(readonly value: string) {}
  append(part: string) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  intersects(other: CodeActionKind) {
    return this.contains(other) || other.contains(this);
  }
  contains(other: CodeActionKind) {
    return this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`);
  }
}

export enum CodeActionTriggerKind {
  Invoke = 1,
  Automatic = 2,
}

export class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: Command;
  isPreferred?: boolean;
  disabled?: { reason: string };
  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export class CodeLens {
  constructor(
    public range: Range,
    public command?: Command,
  ) {}
  get isResolved() {
    return this.command !== undefined;
  }
}

export class ParameterInformation {
  constructor(
    public label: string | [number, number],
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureInformation {
  parameters: ParameterInformation[] = [];
  activeParameter?: number;
  constructor(
    public label: string,
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export enum SignatureHelpTriggerKind {
  Invoke = 1,
  TriggerCharacter = 2,
  ContentChange = 3,
}

export enum DocumentHighlightKind {
  Text,
  Read,
  Write,
}

export class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: DocumentHighlightKind = DocumentHighlightKind.Text,
  ) {}
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind,
  ) {}
}

export class SelectionRange {
  constructor(
    public range: Range,
    public parent?: SelectionRange,
  ) {}
}

export class Color {
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha: number,
  ) {}
}

export class ColorInformation {
  constructor(
    public range: Range,
    public color: Color,
  ) {}
}

export class ColorPresentation {
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  constructor(public label: string) {}
}

export class DocumentLink {
  tooltip?: string;
  constructor(
    public range: Range,
    public target?: Uri,
  ) {}
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2,
}

export class InlayHint {
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  textEdits?: TextEdit[];
  constructor(
    public position: Position,
    public label: string | { value: string }[],
    public kind?: InlayHintKind,
  ) {}
}

export class SemanticTokensLegend {
  constructor(
    readonly tokenTypes: string[],
    readonly tokenModifiers: string[] = [],
  ) {}
}

export class SemanticTokens {
  constructor(
    readonly data: Uint32Array,
    readonly resultId?: string,
  ) {}
}

export class SemanticTokensBuilder {
  private data: number[] = [];
  private prevLine = 0;
  private prevChar = 0;
  constructor(private readonly legend?: SemanticTokensLegend) {}
  push(line: number | Range, char: number | string, length?: number | string[], tokenType?: number, tokenModifiers = 0) {
    if (typeof line !== "number") {
      const range = line;
      const type = this.legend?.tokenTypes.indexOf(char as string) ?? -1;
      const modifiers = ((length as string[] | undefined) ?? []).reduce(
        (bits, m) => bits | (1 << (this.legend?.tokenModifiers.indexOf(m) ?? 0)),
        0,
      );
      return this.push(range.start.line, range.start.character, range.end.character - range.start.character, type, modifiers);
    }
    const deltaLine = line - this.prevLine;
    const deltaChar = deltaLine === 0 ? (char as number) - this.prevChar : (char as number);
    this.data.push(deltaLine, deltaChar, length as number, tokenType!, tokenModifiers);
    this.prevLine = line;
    this.prevChar = char as number;
  }
  build(resultId?: string) {
    return new SemanticTokens(Uint32Array.from(this.data), resultId);
  }
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum TextDocumentSaveReason {
  Manual = 1,
  AfterDelay = 2,
  FocusOut = 3,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export class FileSystemError extends Error {
  static FileNotFound = (uri?: unknown) => new FileSystemError(`File not found: ${uri}`, "FileNotFound");
  static FileExists = (uri?: unknown) => new FileSystemError(`File exists: ${uri}`, "FileExists");
  static FileNotADirectory = (uri?: unknown) => new FileSystemError(`Not a directory: ${uri}`, "FileNotADirectory");
  static FileIsADirectory = (uri?: unknown) => new FileSystemError(`Is a directory: ${uri}`, "FileIsADirectory");
  static NoPermissions = (uri?: unknown) => new FileSystemError(`No permissions: ${uri}`, "NoPermissions");
  static Unavailable = (uri?: unknown) => new FileSystemError(`Unavailable: ${uri}`, "Unavailable");
  constructor(
    message: string,
    readonly code = "Unknown",
  ) {
    super(message);
  }
}

export class RelativePattern {
  baseUri: Uri;
  base: string;
  constructor(
    base: string | Uri | { uri: Uri },
    readonly pattern: string,
  ) {
    this.baseUri = typeof base === "string" ? Uri.file(base) : "uri" in base ? base.uri : base;
    this.base = this.baseUri.fsPath;
  }
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum LogLevel {
  Off, Trace, Debug, Info, Warning, Error,
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export enum TextEditorRevealType {
  Default, InCenter, InCenterIfOutsideViewport, AtTop,
}

export enum TreeItemCollapsibleState {
  None, Collapsed, Expanded,
}

export class TreeItem {
  id?: string;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  iconPath?: unknown;
  command?: Command;
  contextValue?: string;
  resourceUri?: Uri;
  label?: string | { label: string };
  constructor(
    labelOrUri: string | { label: string } | Uri,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {
    if (labelOrUri instanceof URI) this.resourceUri = labelOrUri as Uri;
    else this.label = labelOrUri as string | { label: string };
  }
}

export enum LanguageStatusSeverity {
  Information, Warning, Error,
}

// ---- Notebooks (value types only: PowerCode has no notebook editor) ----

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export class NotebookCellOutputItem {
  static text(value: string, mime = "text/plain") {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static json(value: unknown, mime = "text/x-json") {
    return NotebookCellOutputItem.text(JSON.stringify(value, undefined, "\t"), mime);
  }
  static stdout(value: string) {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stdout");
  }
  static stderr(value: string) {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stderr");
  }
  static error(value: Error) {
    return NotebookCellOutputItem.json(
      { name: value.name, message: value.message, stack: value.stack },
      "application/vnd.code.notebook.error",
    );
  }
  constructor(
    public data: Uint8Array,
    public mime: string,
  ) {}
}

export class NotebookCellOutput {
  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: Record<string, unknown>,
  ) {}
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[];
  metadata?: Record<string, unknown>;
  constructor(
    public kind: NotebookCellKind,
    public value: string,
    public languageId: string,
  ) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;
  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookRange {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}
  get isEmpty() {
    return this.start === this.end;
  }
  with(change: { start?: number; end?: number }) {
    return new NotebookRange(change.start ?? this.start, change.end ?? this.end);
  }
}

export class NotebookEdit {
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]) {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(index: number, newCells: NotebookCellData[]) {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange) {
    return new NotebookEdit(range, []);
  }
  constructor(
    public range: NotebookRange,
    public newCells: NotebookCellData[],
  ) {}
}

// ---- Debugging ----

export class DebugAdapterExecutable {
  constructor(
    readonly command: string,
    readonly args: string[] = [],
    readonly options?: { env?: Record<string, string>; cwd?: string },
  ) {}
}

export class DebugAdapterServer {
  constructor(
    readonly port: number,
    readonly host?: string,
  ) {}
}

export class DebugAdapterNamedPipeServer {
  constructor(readonly path: string) {}
}

export class DebugAdapterInlineImplementation {
  constructor(readonly implementation: { handleMessage(message: unknown): void; onDidSendMessage(listener: (message: unknown) => void): { dispose(): unknown }; dispose?(): void }) {}
}

let nextBreakpointId = 1;

export class Breakpoint {
  readonly id: string;
  constructor(
    readonly enabled = true,
    readonly condition?: string,
    readonly hitCondition?: string,
    readonly logMessage?: string,
  ) {
    this.id = `bp-${nextBreakpointId++}`;
  }
}

export class SourceBreakpoint extends Breakpoint {
  constructor(
    readonly location: Location,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export class FunctionBreakpoint extends Breakpoint {
  constructor(
    readonly functionName: string,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string,
  ) {
    super(enabled, condition, hitCondition, logMessage);
  }
}

export enum DebugConsoleMode {
  Separate = 0,
  MergeWithParent = 1,
}

export enum DebugConfigurationProviderTriggerKind {
  Initial = 1,
  Dynamic = 2,
}

// ---- The rest of the API's values (enums and plain value classes) ----
// Bundled extensions copy the module's own properties (esbuild's __toESM), so
// every name VS Code exports must exist here, even where PowerCode does not act on it.

export enum ColorThemeKind {
  Light = 1, Dark = 2, HighContrast = 3, HighContrastLight = 4,
}

export enum TreeItemCheckboxState {
  Unchecked = 0, Checked = 1,
}

export enum IndentAction {
  None = 0, Indent = 1, IndentOutdent = 2, Outdent = 3,
}

export enum TextEditorCursorStyle {
  Line = 1, Block = 2, Underline = 3, LineThin = 4, BlockOutline = 5, UnderlineThin = 6,
}

export enum TextEditorLineNumbersStyle {
  Off = 0, On = 1, Relative = 2, Interval = 3,
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1, Mouse = 2, Command = 3,
}

export enum OverviewRulerLane {
  Left = 1, Center = 2, Right = 4, Full = 7,
}

export enum DecorationRangeBehavior {
  OpenOpen = 0, ClosedClosed = 1, OpenClosed = 2, ClosedOpen = 3,
}

export enum QuickPickItemKind {
  Separator = -1, Default = 0,
}

export enum FileChangeType {
  Changed = 1, Created = 2, Deleted = 3,
}

export enum TaskScope {
  Global = 1, Workspace = 2,
}

export enum TaskRevealKind {
  Always = 1, Silent = 2, Never = 3,
}

export enum TaskPanelKind {
  Shared = 1, Dedicated = 2, New = 3,
}

export enum TerminalLocation {
  Panel = 1, Editor = 2,
}

export enum TerminalExitReason {
  Unknown = 0, Shutdown = 1, Process = 2, User = 3, Extension = 4,
}

export enum EnvironmentVariableMutatorType {
  Replace = 1, Append = 2, Prepend = 3,
}

export enum InlineCompletionTriggerKind {
  Invoke = 0, Automatic = 1,
}

export enum CommentMode {
  Editing = 0, Preview = 1,
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0, Expanded = 1,
}

export enum CommentThreadState {
  Unresolved = 0, Resolved = 1,
}

export enum TestRunProfileKind {
  Run = 1, Debug = 2, Coverage = 3,
}

export enum InputBoxValidationSeverity {
  Info = 1, Warning = 2, Error = 3,
}

export enum TextDocumentChangeReason {
  Undo = 1, Redo = 2,
}

export class QuickInputButtons {
  static readonly Back = { iconPath: new ThemeIcon("arrow-left") };
}

export class SnippetTextEdit {
  static replace(range: Range, snippet: SnippetString) {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: SnippetString) {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
  constructor(
    public range: Range,
    public snippet: SnippetString,
  ) {}
}

export class InlayHintLabelPart {
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: unknown;
  constructor(public value: string) {}
}

export class SemanticTokensEdit {
  constructor(
    readonly start: number,
    readonly deleteCount: number,
    readonly data?: Uint32Array,
  ) {}
}

export class SemanticTokensEdits {
  constructor(
    readonly edits: SemanticTokensEdit[],
    readonly resultId?: string,
  ) {}
}

export class CallHierarchyItem {
  tags?: number[];
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

export class CallHierarchyIncomingCall {
  constructor(
    public from: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class CallHierarchyOutgoingCall {
  constructor(
    public to: CallHierarchyItem,
    public fromRanges: Range[],
  ) {}
}

export class TypeHierarchyItem {
  tags?: number[];
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

export class EvaluatableExpression {
  constructor(
    readonly range: Range,
    readonly expression?: string,
  ) {}
}

export class InlineValueText {
  constructor(
    readonly range: Range,
    readonly text: string,
  ) {}
}

export class InlineValueVariableLookup {
  constructor(
    readonly range: Range,
    readonly variableName?: string,
    readonly caseSensitiveLookup = true,
  ) {}
}

export class InlineValueEvaluatableExpression {
  constructor(
    readonly range: Range,
    readonly expression?: string,
  ) {}
}

export class LinkedEditingRanges {
  constructor(
    readonly ranges: Range[],
    readonly wordPattern?: RegExp,
  ) {}
}

export class InlineCompletionItem {
  filterText?: string;
  constructor(
    public insertText: string | SnippetString,
    public range?: Range,
    public command?: unknown,
  ) {}
}

export class InlineCompletionList {
  constructor(public items: InlineCompletionItem[]) {}
}

/** A file in a `DataTransfer` (e.g. an image pasted into the editor). */
export interface DataTransferFile {
  readonly name: string;
  readonly uri?: Uri;
  data(): PromiseLike<Uint8Array>;
}

export class DataTransferItem {
  constructor(
    readonly value: unknown,
    private readonly file?: DataTransferFile,
  ) {}
  async asString() {
    if (this.file) return "";
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value);
  }
  asFile(): DataTransferFile | undefined {
    return this.file;
  }
}

export class DocumentDropOrPasteEditKind {
  static readonly sep = ".";
  static readonly Empty = new DocumentDropOrPasteEditKind("");
  static readonly Text = new DocumentDropOrPasteEditKind("text");
  static readonly TextUpdateImports = new DocumentDropOrPasteEditKind("text.updateImports");
  constructor(readonly value: string) {}
  append(...parts: string[]) {
    return new DocumentDropOrPasteEditKind((this.value ? [this.value, ...parts] : parts).join(DocumentDropOrPasteEditKind.sep));
  }
  intersects(other: DocumentDropOrPasteEditKind) {
    return this.contains(other) || other.contains(this);
  }
  contains(other: DocumentDropOrPasteEditKind) {
    return this.value === other.value || this.value === "" || other.value.startsWith(this.value + DocumentDropOrPasteEditKind.sep);
  }
}

export enum DocumentPasteTriggerKind {
  Automatic = 0,
  PasteAs = 1,
}

export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();
  get(mimeType: string) {
    return this.items.get(mimeType.toLowerCase());
  }
  set(mimeType: string, value: DataTransferItem) {
    this.items.set(mimeType.toLowerCase(), value);
  }
  forEach(callback: (item: DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void) {
    this.items.forEach((item, mime) => callback(item, mime, this));
  }
  [Symbol.iterator]() {
    return this.items.entries();
  }
}

export class DocumentDropEdit {
  additionalEdit?: WorkspaceEdit;
  yieldTo?: DocumentDropOrPasteEditKind[];
  constructor(
    public insertText: string | SnippetString,
    public title?: string,
    public kind?: DocumentDropOrPasteEditKind,
  ) {}
}

export class DocumentPasteEdit {
  additionalEdit?: WorkspaceEdit;
  yieldTo?: DocumentDropOrPasteEditKind[];
  constructor(
    public insertText: string | SnippetString,
    public title: string,
    public kind: DocumentDropOrPasteEditKind,
  ) {}
}

export class TaskGroup {
  static readonly Clean = new TaskGroup("clean", "Clean");
  static readonly Build = new TaskGroup("build", "Build");
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild");
  static readonly Test = new TaskGroup("test", "Test");
  isDefault?: boolean;
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}
}

export enum ShellQuoting {
  Escape = 1, Strong = 2, Weak = 3,
}

export interface ShellQuotedString {
  value: string;
  quoting: ShellQuoting;
}

type ExecutionOptions = { cwd?: string; env?: Record<string, string>; executable?: string; shellArgs?: string[] };

/** `new ShellExecution(commandLine, options?)` or `new ShellExecution(command, args, options?)`. */
export class ShellExecution {
  commandLine?: string;
  command?: string | ShellQuotedString;
  args: (string | ShellQuotedString)[] = [];
  options?: ExecutionOptions;
  constructor(commandOrLine: string | ShellQuotedString, argsOrOptions?: (string | ShellQuotedString)[] | ExecutionOptions, options?: ExecutionOptions) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions;
      this.options = options;
    } else {
      this.commandLine = typeof commandOrLine === "string" ? commandOrLine : commandOrLine.value;
      this.options = argsOrOptions;
    }
  }
}

/** `new ProcessExecution(process, options?)` or `new ProcessExecution(process, args, options?)`. */
export class ProcessExecution {
  args: string[] = [];
  options?: ExecutionOptions;
  constructor(
    public process: string,
    argsOrOptions?: string[] | ExecutionOptions,
    options?: ExecutionOptions,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.args = argsOrOptions;
      this.options = options;
    } else {
      this.options = argsOrOptions;
    }
  }
}

export class CustomExecution {
  constructor(readonly callback: (resolvedDefinition: unknown) => PromiseLike<unknown>) {}
}

/** `new Task(definition, scope, name, source, execution?, problemMatchers?)`, or the older form without `scope`. */
export class Task {
  group?: TaskGroup;
  presentationOptions: Record<string, unknown> = {};
  runOptions: Record<string, unknown> = {};
  isBackground = false;
  detail?: string;
  problemMatchers: string[];
  scope: unknown;
  name: string;
  source: string;
  execution?: ShellExecution | ProcessExecution | CustomExecution;
  constructor(public definition: { type: string; [key: string]: unknown }, ...rest: any[]) {
    // The deprecated form has no scope: (definition, name, source, execution?, problemMatchers?).
    if (typeof rest[0] === "string") rest.unshift(TaskScope.Workspace);
    const [scope, name, source, execution, problemMatchers] = rest;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.problemMatchers = typeof problemMatchers === "string" ? [problemMatchers] : (problemMatchers ?? []);
  }
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export class TabInputTextDiff {
  constructor(
    readonly original: Uri,
    readonly modified: Uri,
  ) {}
}

export class TabInputCustom {
  constructor(
    readonly uri: Uri,
    readonly viewType: string,
  ) {}
}

export class TabInputWebview {
  constructor(readonly viewType: string) {}
}

export class TabInputNotebook {
  constructor(
    readonly uri: Uri,
    readonly notebookType: string,
  ) {}
}

export class TabInputTerminal {}

export class TestTag {
  constructor(readonly id: string) {}
}

export class TestMessage {
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  static diff(message: string | MarkdownString, expected: string, actual: string) {
    const result = new TestMessage(message);
    result.expectedOutput = expected;
    result.actualOutput = actual;
    return result;
  }
  constructor(public message: string | MarkdownString) {}
}

export class TestRunRequest {
  constructor(
    readonly include: readonly unknown[] | undefined = undefined,
    readonly exclude: readonly unknown[] | undefined = undefined,
    readonly profile: unknown = undefined,
    readonly continuous = false,
    readonly preserveFocus = true,
  ) {}
}

export class TerminalLink {
  constructor(
    public startIndex: number,
    public length: number,
    public tooltip?: string,
  ) {}
}

export class TerminalProfile {
  constructor(public options: unknown) {}
}

// ---- Language models and chat ----------------------------------------------------------

export enum LanguageModelChatMessageRole {
  User = 1, Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1, Required = 2,
}

export enum ChatResultFeedbackKind {
  Unhelpful = 0, Helpful = 1,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
  static image(data: Uint8Array, mimeType: string) {
    return new LanguageModelDataPart(data, mimeType);
  }
  static json(value: unknown, mimeType = "text/x-json") {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
  }
  static text(value: string, mimeType = "text/plain") {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType);
  }
}

export class LanguageModelPromptTsxPart {
  constructor(public value: unknown) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
}

type MessageContent = string | (LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart)[];

export class LanguageModelChatMessage {
  content: (LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart)[];
  static User(content: MessageContent, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: MessageContent, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
  constructor(
    public role: LanguageModelChatMessageRole,
    content: MessageContent,
    public name?: string,
  ) {
    this.content = typeof content === "string" ? [new LanguageModelTextPart(content)] : content;
  }
}

export class LanguageModelError extends Error {
  static NoPermissions = (message?: string) => new LanguageModelError(message ?? "No permissions", "NoPermissions");
  static Blocked = (message?: string) => new LanguageModelError(message ?? "Blocked", "Blocked");
  static NotFound = (message?: string) => new LanguageModelError(message ?? "Not found", "NotFound");
  constructor(
    message?: string,
    readonly code = "Unknown",
  ) {
    super(message);
  }
}

export class ChatResponseMarkdownPart {
  value: MarkdownString;
  constructor(value: string | MarkdownString) {
    this.value = typeof value === "string" ? new MarkdownString(value) : value;
  }
}

export class ChatResponseAnchorPart {
  constructor(
    public value: unknown,
    public title?: string,
  ) {}
}

export class ChatResponseFileTreePart {
  constructor(
    public value: unknown[],
    public baseUri: Uri,
  ) {}
}

export class ChatResponseProgressPart {
  constructor(public value: string) {}
}

export class ChatResponseReferencePart {
  constructor(
    public value: unknown,
    public iconPath?: unknown,
  ) {}
}

export class ChatResponseCommandButtonPart {
  constructor(public value: Command) {}
}

export class ChatRequestTurn {
  constructor(
    readonly prompt: string,
    readonly command: string | undefined,
    readonly references: readonly unknown[],
    readonly participant: string,
    readonly toolReferences: readonly unknown[] = [],
  ) {}
}

export class ChatResponseTurn {
  constructor(
    readonly response: readonly unknown[],
    readonly result: object,
    readonly participant: string,
    readonly command?: string,
  ) {}
}

export class McpStdioServerDefinition {
  constructor(
    public label: string,
    public command: string,
    public args: string[] = [],
    public env: Record<string, string | number | null> = {},
    public version?: string,
  ) {}
  cwd?: Uri;
}

export class McpHttpServerDefinition {
  constructor(
    public label: string,
    public uri: Uri,
    public headers: Record<string, string> = {},
    public version?: string,
  ) {}
}
