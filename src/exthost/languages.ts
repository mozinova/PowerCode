//! Bridges language features of extensions (providers registered in the
//! extension host) to Monaco, and their diagnostics to editor markers.

import { monaco } from "../editor/monaco";
import {
  dataTransferOf,
  hierarchicalKind,
  registerDropEditProvider,
  registerPasteEditProvider,
  valueItem,
  type DataTransfer,
  type DropOrPasteEdit,
} from "../editor/monacoInternals";
import { extensionServes, extensionStopsServing } from "../editor/builtinLanguages";
import { loadModel } from "../editor/models";
import { uriToPath } from "../editor/uris";
import * as rpc from "./rpc";

type L = typeof monaco.languages;

interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const toRange = (r: RangeDto) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const fromRange = (r: monaco.IRange): RangeDto => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const markdown = (value?: string) => (value ? { value, supportThemeIcons: true } : undefined);

/** The workspace path of a file URI (local, WSL or SSH). */
export function pathFromUri(uri: string): string {
  return uriToPath(uri);
}

// `vscode.CompletionItemKind` names, by their values in the extension API.
const API_COMPLETION_KINDS = [
  "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property",
  "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant",
  "Struct", "Event", "Operator", "TypeParameter", "User", "Issue",
] as const;

function completionKind(kind: number | undefined) {
  const name = API_COMPLETION_KINDS[kind ?? 0] ?? "Text";
  return monaco.languages.CompletionItemKind[name as keyof typeof monaco.languages.CompletionItemKind] as monaco.languages.CompletionItemKind;
}

const FOLDING_KINDS = [undefined, monaco.languages.FoldingRangeKind.Comment, monaco.languages.FoldingRangeKind.Imports, monaco.languages.FoldingRangeKind.Region];

// ---- Commands -----------------------------------------------------------------

const monacoCommands = new Set<string>();

/**
 * Commands referenced by code actions or code lenses run through Monaco's
 * command service, which only knows commands registered with it.
 */
function ensureMonacoCommand(id: string) {
  if (monacoCommands.has(id)) return;
  monacoCommands.add(id);
  monaco.editor.registerCommand(id, (_accessor, ...args: unknown[]) => {
    void rpc.request("commands/execute", { command: id, args });
  });
}

function command(c?: { command: string; title: string; arguments?: unknown[] }): monaco.languages.Command | undefined {
  if (!c) return undefined;
  ensureMonacoCommand(c.command);
  return { id: c.command, title: c.title, arguments: c.arguments };
}

// ---- Workspace edits ------------------------------------------------------------

interface WorkspaceEditDto {
  edits: { uri: string; edits: { range: RangeDto; newText: string }[] }[];
}

function workspaceEdit(edit: WorkspaceEditDto | null): monaco.languages.WorkspaceEdit {
  return {
    edits: (edit?.edits ?? []).flatMap((file) =>
      file.edits.map((e) => ({
        resource: monaco.Uri.parse(file.uri),
        textEdit: { range: toRange(e.range), text: e.newText },
        versionId: undefined,
      })),
    ),
  };
}

/** Peek and go-to-definition need models for the target files; load them (bounded). */
async function withModels<T extends { uri: monaco.Uri }>(locations: T[]): Promise<T[]> {
  const uris = [...new Set(locations.map((l) => l.uri.toString()))].slice(0, 50);
  await Promise.all(
    uris.map((uri) => (monaco.editor.getModel(monaco.Uri.parse(uri)) ? null : loadModel(pathFromUri(uri)).catch(() => null))),
  );
  return locations;
}

function locations(result: any[] | null): monaco.languages.Location[] {
  return (result ?? []).map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
}

// ---- Provider registration --------------------------------------------------------

const registrations = new Map<number, monaco.IDisposable[]>();

interface Registration {
  handle: number;
  kind: string;
  languages: string[];
  metadata?: any;
  /** The extension that registered it. */
  extension?: string;
}

let flushDocument: (uri: string) => void = () => {};

/** Sets how pending document changes are sent before a provider runs, so it sees the latest text. */
export function setDocumentFlusher(flush: (uri: string) => void) {
  flushDocument = flush;
}

function provide<T = any>(handle: number, method: string, model: monaco.editor.ITextModel, extra: object = {}) {
  flushDocument(model.uri.toString());
  return rpc.request<T>("providers/provide", { handle, method, uri: model.uri.toString(), ...extra });
}

function createProvider(r: Registration, language: string): monaco.IDisposable | null {
  const { handle } = r;
  const l: L = monaco.languages;
  switch (r.kind) {
    case "completion":
      return l.registerCompletionItemProvider(language, {
        triggerCharacters: r.metadata?.triggerCharacters ?? [],
        async provideCompletionItems(model, position, context) {
          const result = await provide(handle, "completion", model, {
            position: toPosition(position),
            triggerCharacter: context.triggerCharacter,
          });
          // The host answers null when the document is outside the provider's selector.
          if (!result) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
          return {
            incomplete: result.incomplete,
            suggestions: result.items.map((item: any) => ({
              label: item.labelDetail || item.labelDescription
                ? { label: item.label, detail: item.labelDetail, description: item.labelDescription }
                : item.label,
              kind: completionKind(item.kind),
              detail: item.detail,
              documentation: markdown(item.documentation),
              insertText: item.insertText,
              insertTextRules: item.isSnippet ? l.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: item.range
                ? "insert" in item.range
                  ? { insert: toRange(item.range.insert), replace: toRange(item.range.replace) }
                  : toRange(item.range)
                : fallback,
              sortText: item.sortText,
              filterText: item.filterText,
              preselect: item.preselect,
              commitCharacters: item.commitCharacters,
              additionalTextEdits: item.additionalTextEdits?.map((e: any) => ({ range: toRange(e.range), text: e.newText })),
              command: command(item.command),
              tags: item.tags,
              // Where the item came from, for `resolveCompletionItem`.
              _pcId: item.id,
              _pcUri: model.uri.toString(),
            })),
          };
        },
        async resolveCompletionItem(item) {
          const { _pcId: id, _pcUri: uri } = item as any;
          if (id === undefined) return item;
          const resolved = await rpc.request<any>("providers/provide", { handle, method: "resolveCompletion", id, uri }).catch(() => null);
          if (!resolved) return item;
          return { ...item, detail: resolved.detail ?? item.detail, documentation: markdown(resolved.documentation) ?? item.documentation };
        },
      });
    case "hover":
      return l.registerHoverProvider(language, {
        async provideHover(model, position) {
          const result = await provide(handle, "hover", model, { position: toPosition(position) });
          if (!result?.contents?.length) return null;
          return {
            contents: result.contents.map((c: string) => ({ value: c, supportThemeIcons: true })),
            range: result.range ? toRange(result.range) : undefined,
          };
        },
      });
    case "definition":
    case "declaration":
    case "typeDefinition":
    case "implementation": {
      const method = r.kind;
      const provider = {
        provideDefinition: async (model: monaco.editor.ITextModel, position: monaco.Position) =>
          withModels(locations(await provide(handle, method, model, { position: toPosition(position) }))),
      };
      if (method === "definition") return l.registerDefinitionProvider(language, provider);
      if (method === "declaration") return l.registerDeclarationProvider(language, { provideDeclaration: provider.provideDefinition });
      if (method === "typeDefinition") return l.registerTypeDefinitionProvider(language, { provideTypeDefinition: provider.provideDefinition });
      return l.registerImplementationProvider(language, { provideImplementation: provider.provideDefinition });
    }
    case "references":
      return l.registerReferenceProvider(language, {
        async provideReferences(model, position, context) {
          return withModels(
            locations(await provide(handle, "references", model, { position: toPosition(position), includeDeclaration: context.includeDeclaration })),
          );
        },
      });
    case "documentHighlight":
      return l.registerDocumentHighlightProvider(language, {
        async provideDocumentHighlights(model, position) {
          const result = await provide<any[]>(handle, "documentHighlight", model, { position: toPosition(position) });
          return (result ?? []).map((h) => ({ range: toRange(h.range), kind: h.kind }));
        },
      });
    case "documentSymbol":
      return l.registerDocumentSymbolProvider(language, {
        async provideDocumentSymbols(model) {
          const convert = (s: any): monaco.languages.DocumentSymbol => ({
            name: s.name,
            detail: s.detail ?? "",
            kind: s.kind,
            tags: [],
            range: toRange(s.range),
            selectionRange: toRange(s.selectionRange),
            children: (s.children ?? []).map(convert),
          });
          return ((await provide<any[]>(handle, "documentSymbol", model)) ?? []).map(convert);
        },
      });
    case "formatting":
      return l.registerDocumentFormattingEditProvider(language, {
        async provideDocumentFormattingEdits(model, options) {
          const edits = await provide<any[]>(handle, "formatting", model, { options });
          return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
        },
      });
    case "rangeFormatting":
      return l.registerDocumentRangeFormattingEditProvider(language, {
        async provideDocumentRangeFormattingEdits(model, range, options) {
          const edits = await provide<any[]>(handle, "rangeFormatting", model, { range: fromRange(range), options });
          return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
        },
      });
    case "onTypeFormatting":
      return l.registerOnTypeFormattingEditProvider(language, {
        autoFormatTriggerCharacters: r.metadata?.triggerCharacters ?? [],
        async provideOnTypeFormattingEdits(model, position, ch, options) {
          const edits = await provide<any[]>(handle, "onTypeFormatting", model, { position: toPosition(position), ch, options });
          return (edits ?? []).map((e) => ({ range: toRange(e.range), text: e.newText }));
        },
      });
    case "codeActions":
      return l.registerCodeActionProvider(
        language,
        {
          async provideCodeActions(model, range, context) {
            const actions = await provide<any[]>(handle, "codeActions", model, {
              range: fromRange(range),
              only: context.only,
              diagnostics: context.markers.map((m) => ({
                range: fromRange(m),
                message: m.message,
                severity: { 8: 0, 4: 1, 2: 2, 1: 3 }[m.severity] ?? 0,
                source: m.source,
                code: typeof m.code === "object" ? m.code?.value : m.code,
              })),
            });
            return {
              actions: (actions ?? []).map((a) => ({
                title: a.title,
                kind: a.kind,
                isPreferred: a.isPreferred,
                disabled: a.disabled,
                edit: a.edit ? workspaceEdit(a.edit) : undefined,
                command: command(a.command),
              })),
              dispose() {},
            };
          },
        },
        { providedCodeActionKinds: r.metadata?.kinds },
      );
    case "codeLens":
      return l.registerCodeLensProvider(language, {
        async provideCodeLenses(model) {
          const lenses = await provide<any[]>(handle, "codeLens", model);
          return { lenses: (lenses ?? []).map((c) => ({ range: toRange(c.range), command: command(c.command) })), dispose() {} };
        },
      });
    case "signatureHelp":
      return l.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: r.metadata?.triggerCharacters ?? [],
        signatureHelpRetriggerCharacters: r.metadata?.retriggerCharacters ?? [],
        async provideSignatureHelp(model, position, _token, context) {
          const help = await provide<any>(handle, "signatureHelp", model, {
            position: toPosition(position),
            triggerCharacter: context.triggerCharacter,
            isRetrigger: context.isRetrigger,
          });
          if (!help) return null;
          return {
            value: {
              activeSignature: help.activeSignature ?? 0,
              activeParameter: help.activeParameter ?? 0,
              signatures: help.signatures.map((s: any) => ({
                label: s.label,
                documentation: markdown(s.documentation),
                activeParameter: s.activeParameter,
                parameters: s.parameters.map((p: any) => ({ label: p.label, documentation: markdown(p.documentation) })),
              })),
            },
            dispose() {},
          };
        },
      });
    case "rename":
      return l.registerRenameProvider(language, {
        async provideRenameEdits(model, position, newName) {
          return workspaceEdit(await provide(handle, "rename", model, { position: toPosition(position), newName }));
        },
        async resolveRenameLocation(model, position) {
          const result = await provide<any>(handle, "prepareRename", model, { position: toPosition(position) });
          if (!result) {
            const word = model.getWordAtPosition(position);
            return word
              ? { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word }
              : { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "Nothing to rename here." };
          }
          const range = toRange(result.range);
          return { range, text: result.placeholder ?? model.getValueInRange(range) };
        },
      });
    case "foldingRanges":
      return l.registerFoldingRangeProvider(language, {
        async provideFoldingRanges(model) {
          const ranges = await provide<any[]>(handle, "foldingRanges", model);
          return (ranges ?? []).map((f) => ({ start: f.start + 1, end: f.end + 1, kind: FOLDING_KINDS[f.kind ?? 0] }));
        },
      });
    case "documentLinks":
      return l.registerLinkProvider(language, {
        async provideLinks(model) {
          const links = await provide<any[]>(handle, "documentLinks", model);
          return { links: (links ?? []).map((k) => ({ range: toRange(k.range), url: k.target, tooltip: k.tooltip })) };
        },
      });
    case "inlayHints":
      return l.registerInlayHintsProvider(language, {
        async provideInlayHints(model, range) {
          const hints = await provide<any[]>(handle, "inlayHints", model, { range: fromRange(range) });
          return {
            hints: (hints ?? []).map((h) => ({
              position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
              label: h.label,
              kind: h.kind,
              paddingLeft: h.paddingLeft,
              paddingRight: h.paddingRight,
              tooltip: h.tooltip,
            })),
            dispose() {},
          };
        },
      });
    case "inlineCompletions":
      return l.registerInlineCompletionsProvider(language, {
        async provideInlineCompletions(model, position, context, token) {
          const selected = context.selectedSuggestionInfo;
          const items = await provide<any[]>(handle, "inlineCompletions", model, {
            position: toPosition(position),
            explicit: context.triggerKind === l.InlineCompletionTriggerKind.Explicit,
            selected: selected ? { range: fromRange(selected.range), text: selected.text } : undefined,
          });
          // Typing on made the answer stale.
          if (token.isCancellationRequested) return { items: [] };
          return {
            items: (items ?? []).map((item) => ({
              insertText: item.snippet !== undefined ? { snippet: item.snippet } : item.insertText,
              filterText: item.filterText,
              range: item.range ? toRange(item.range) : undefined,
              command: command(item.command),
            })),
          };
        },
        disposeInlineCompletions() {},
      });
    case "selectionRanges":
      return l.registerSelectionRangeProvider(language, {
        async provideSelectionRanges(model, positions) {
          const chains = await provide<RangeDto[][]>(handle, "selectionRanges", model, { positions: positions.map(toPosition) });
          return (chains ?? []).map((chain) => chain.map((range) => ({ range: toRange(range) })));
        },
      });
    case "linkedEditing":
      return l.registerLinkedEditingRangeProvider(language, {
        async provideLinkedEditingRanges(model, position) {
          const result = await provide<any>(handle, "linkedEditing", model, { position: toPosition(position) });
          if (!result) return null;
          const pattern = result.wordPattern;
          return { ranges: result.ranges.map(toRange), wordPattern: pattern ? revive(pattern) : undefined };
        },
      });
    case "colors":
      return l.registerColorProvider(language, {
        async provideDocumentColors(model) {
          const colors = await provide<any[]>(handle, "colors", model);
          return (colors ?? []).map((c) => ({ range: toRange(c.range), color: c.color }));
        },
        async provideColorPresentations(model, info) {
          const presentations = await provide<any[]>(handle, "colorPresentations", model, { range: fromRange(info.range), color: info.color });
          return (presentations ?? []).map((p) => ({
            label: p.label,
            textEdit: p.textEdit ? { range: toRange(p.textEdit.range), text: p.textEdit.newText } : undefined,
            additionalTextEdits: p.additionalTextEdits?.map((e: any) => ({ range: toRange(e.range), text: e.newText })),
          }));
        },
      });
    case "drop":
      return dropProvider(r, language);
    case "paste":
      return pasteProvider(r, language);
    default:
      return null;
  }
}

// ---- Drop and paste -------------------------------------------------------------------

/** Files larger than this reach providers without their bytes (`data()` is empty). */
const MAX_TRANSFER_FILE_BYTES = 20 * 1024 * 1024;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Clipboard or drop contents for the host (files with their bytes, as `$pcBytes`). */
async function dataTransferDto(transfer: DataTransfer) {
  const entries: { mime: string; value?: unknown; file?: { name: string; uri?: string; data?: unknown } }[] = [];
  for (const [mime, item] of transfer) {
    const file = item.asFile();
    if (file) {
      const data = await file.data().catch(() => null);
      entries.push({
        mime,
        file: {
          name: file.name,
          uri: file.uri?.toString(),
          data: data && data.byteLength <= MAX_TRANSFER_FILE_BYTES ? { $pcBytes: base64(data), kind: "Uint8Array" } : undefined,
        },
      });
    } else {
      entries.push({ mime, value: item.value !== undefined ? item.value : await item.asString() });
    }
  }
  return entries;
}

function dropOrPasteEdits(list: any[] | null, mimeTypes: string[]): DropOrPasteEdit[] {
  return (list ?? []).map((e) => ({
    title: e.title ?? "",
    kind: e.kind !== undefined ? hierarchicalKind(e.kind) : undefined,
    insertText: e.snippet !== undefined ? { snippet: e.snippet } : (e.insertText ?? ""),
    additionalEdit: e.additionalEdit ? workspaceEdit(e.additionalEdit) : undefined,
    yieldTo: e.yieldTo?.map((y: any) => (y.mimeType ? { mimeType: y.mimeType } : { kind: hierarchicalKind(y.kind) })),
    handledMimeType: mimeTypes.length === 1 ? mimeTypes[0] : undefined,
  }));
}

function dropProvider(r: Registration, language: string): monaco.IDisposable {
  const { handle } = r;
  const mimeTypes: string[] = r.metadata?.mimeTypes ?? ["*/*"];
  return registerDropEditProvider(language, {
    id: `exthost.${handle}`,
    dropMimeTypes: mimeTypes,
    providedDropEditKinds: (r.metadata?.kinds ?? []).map(hierarchicalKind),
    async provideDocumentDropEdits(model, position, dataTransfer) {
      const edits = await provide<any[]>(handle, "drop", model, {
        position: toPosition(position),
        dataTransfer: await dataTransferDto(dataTransfer),
      });
      return { edits: dropOrPasteEdits(edits, mimeTypes), dispose() {} };
    },
  });
}

function pasteProvider(r: Registration, language: string): monaco.IDisposable {
  const { handle } = r;
  const mimeTypes: string[] = r.metadata?.mimeTypes ?? [];
  return registerPasteEditProvider(language, {
    id: `exthost.${handle}`,
    copyMimeTypes: r.metadata?.copyMimeTypes ?? [],
    pasteMimeTypes: mimeTypes,
    providedPasteEditKinds: (r.metadata?.kinds ?? []).map(hierarchicalKind),
    prepareDocumentPaste: r.metadata?.prepare
      ? async (model, ranges, dataTransfer) => {
          const entries = await provide<{ mime: string; value: unknown }[] | null>(handle, "preparePaste", model, {
            ranges: ranges.map(fromRange),
            dataTransfer: await dataTransferDto(dataTransfer),
          });
          return entries ? dataTransferOf(entries.map((e) => [e.mime, valueItem(e.value)])) : undefined;
        }
      : undefined,
    async provideDocumentPasteEdits(model, ranges, dataTransfer, context) {
      const edits = await provide<any[]>(handle, "paste", model, {
        ranges: ranges.map(fromRange),
        dataTransfer: await dataTransferDto(dataTransfer),
        only: context.only?.value,
        triggerKind: context.triggerKind,
      });
      return { edits: dropOrPasteEdits(edits, mimeTypes), dispose() {} };
    },
  });
}

// ---- Features PowerCode calls itself ----------------------------------------------------

/**
 * Providers with no Monaco registry behind them: semantic tokens (merged with the
 * TextMate colouring), call and type hierarchies (the Hierarchy view) and the
 * debugger's hover expressions and inline values.
 */
const FEATURE_KINDS = new Set(["semanticTokens", "rangeSemanticTokens", "callHierarchy", "typeHierarchy", "evaluatableExpression", "inlineValues"]);

export interface FeatureProvider {
  handle: number;
  kind: string;
  languages: string[];
  metadata?: any;
}

const features = new Map<number, FeatureProvider>();
const featureListeners = new Set<(kind: string, handle: number) => void>();

/** The providers of `kind` for a language, in registration order. */
export function featureProviders(kind: string, languageId: string): FeatureProvider[] {
  return [...features.values()].filter((f) => f.kind === kind && (f.languages.includes(languageId) || f.languages.includes("*")));
}

/** Called when a feature provider comes, goes or says its results changed. */
export function onFeatureChange(listener: (kind: string, handle: number) => void): () => void {
  featureListeners.add(listener);
  return () => featureListeners.delete(listener);
}

function featureChanged(feature: FeatureProvider) {
  for (const listener of featureListeners) listener(feature.kind, feature.handle);
}

/** A provider's results changed (`onDidChangeSemanticTokens`, `onDidChangeInlineValues`). */
export function providerChanged(handle: number) {
  const feature = features.get(handle);
  if (feature) featureChanged(feature);
}

/** Asks a feature provider about `model` (it sees the model's latest text). */
export function provideFeature<T>(handle: number, method: string, model: monaco.editor.ITextModel, extra: object = {}) {
  return provide<T>(handle, method, model, extra);
}

/** Asks a hierarchy provider about an item it gave before. */
export function provideForItem<T>(handle: number, method: string, item: number) {
  return rpc.request<T>("providers/provide", { handle, method, item });
}

function revive(pattern: { source: string; flags?: string }) {
  try {
    return new RegExp(pattern.source, pattern.flags);
  } catch {
    return undefined;
  }
}

// ---- Workspace symbols ---------------------------------------------------------------

/** Workspace symbol providers: not tied to a language, so not registered with Monaco. */
const workspaceSymbolProviders = new Set<number>();

export interface WorkspaceSymbol {
  name: string;
  /** `vscode.SymbolKind`. */
  kind: number;
  containerName?: string;
  path: string;
  range?: RangeDto;
}

export const hasWorkspaceSymbolProviders = () => workspaceSymbolProviders.size > 0;

/** Go to Symbol in Workspace: every provider's symbols for `query` (files only). */
export async function searchWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
  const results = await Promise.all(
    [...workspaceSymbolProviders].map((handle) =>
      rpc.request<any[]>("providers/provide", { handle, method: "workspaceSymbols", query }).catch(() => null),
    ),
  );
  return results
    .flatMap((list) => list ?? [])
    .filter((s) => typeof s.uri === "string" && /^(file|ssh):/.test(s.uri))
    .map((s) => ({ name: s.name, kind: s.kind, containerName: s.containerName, path: pathFromUri(s.uri), range: s.range }));
}

export function registerProvider(r: Registration) {
  // Monaco's own TypeScript, JSON, CSS or HTML service gives way to the extension's.
  extensionServes(r.handle, r.kind, r.languages, r.extension ?? "");
  if (r.kind === "workspaceSymbols") {
    workspaceSymbolProviders.add(r.handle);
    registrations.set(r.handle, [{ dispose: () => workspaceSymbolProviders.delete(r.handle) }]);
    return;
  }
  if (FEATURE_KINDS.has(r.kind)) {
    const feature: FeatureProvider = { handle: r.handle, kind: r.kind, languages: r.languages, metadata: r.metadata };
    features.set(r.handle, feature);
    registrations.set(r.handle, [
      {
        dispose: () => {
          features.delete(r.handle);
          featureChanged(feature);
        },
      },
    ]);
    featureChanged(feature);
    return;
  }
  // `*` applies to every language: Monaco's selector accepts it too.
  const disposables = r.languages
    .map((language) => createProvider(r, language))
    .filter((d): d is monaco.IDisposable => d !== null);
  registrations.set(r.handle, disposables);
}

export function unregisterProvider(handle: number) {
  extensionStopsServing(handle);
  registrations.get(handle)?.forEach((d) => d.dispose());
  registrations.delete(handle);
}

// ---- Diagnostics ------------------------------------------------------------------

/** Diagnostics by owner and URI, applied to models when they exist (or once they are created). */
const diagnostics = new Map<string, Map<string, monaco.editor.IMarkerData[]>>();
const SEVERITIES = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

export function setDiagnostics(owner: string, uri: string, list: any[]) {
  const markers: monaco.editor.IMarkerData[] = list.map((d) => ({
    ...toRange(d.range),
    message: d.message,
    severity: SEVERITIES[d.severity ?? 0] ?? monaco.MarkerSeverity.Error,
    source: d.source,
    code: d.code,
    tags: d.tags,
  }));
  let byUri = diagnostics.get(owner);
  if (!byUri) {
    byUri = new Map();
    diagnostics.set(owner, byUri);
  }
  byUri.set(uri, markers);
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) monaco.editor.setModelMarkers(model, `exthost:${owner}`, markers);
}

monaco.editor.onDidCreateModel((model) => {
  const uri = model.uri.toString();
  for (const [owner, byUri] of diagnostics) {
    const markers = byUri.get(uri);
    if (markers) monaco.editor.setModelMarkers(model, `exthost:${owner}`, markers);
  }
});

/** Forgets everything the previous host registered (it exited or restarts). */
export function resetLanguageFeatures() {
  for (const handle of [...registrations.keys()]) unregisterProvider(handle);
  for (const [owner, byUri] of diagnostics) {
    for (const uri of byUri.keys()) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) monaco.editor.setModelMarkers(model, `exthost:${owner}`, []);
    }
  }
  diagnostics.clear();
}
