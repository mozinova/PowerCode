//! Language feature providers registered by extensions, and the requests the
//! UI makes to them (completion, hover, definition, ...).

import { decodeBinary } from "./binary";
import { globToRegExp } from "./glob";
import { documentFor } from "./documents";
import * as dto from "./dto";
import * as rpc from "./rpc";
import {
  CancellationTokenSource,
  CodeActionKind,
  CodeActionTriggerKind,
  Color,
  CompletionItem,
  CompletionTriggerKind,
  DataTransfer,
  DataTransferItem,
  Diagnostic,
  Disposable,
  DocumentDropOrPasteEditKind,
  InlineCompletionTriggerKind,
  Range,
  SignatureHelpTriggerKind,
  SnippetString,
  Uri,
} from "./types";

export type DocumentSelector =
  | string
  | { language?: string; scheme?: string; pattern?: unknown; notebookType?: string }
  | (string | { language?: string; scheme?: string; pattern?: unknown; notebookType?: string })[];

interface Registration {
  kind: string;
  provider: any;
  extension: string;
  /** The UI registers by language only; scheme and pattern are checked here before asking. */
  selector: DocumentSelector;
  /** Completion items of the last result, for `resolveCompletionItem`. */
  lastItems?: CompletionItem[];
  /** Call or type hierarchy items the UI shows, by id: expanding one asks the provider with it. */
  items?: Map<number, unknown>;
  nextItem?: number;
}

const registrations = new Map<number, Registration>();
let nextHandle = 1;

/** Language ids a selector applies to (`*` for any); schemes other than files are not distinguished. */
function selectorLanguages(selector: DocumentSelector): string[] {
  const list = Array.isArray(selector) ? selector : [selector];
  const languages = new Set<string>();
  for (const entry of list) {
    if (typeof entry === "string") languages.add(entry);
    else if (entry.language) languages.add(entry.language);
    else if (entry.notebookType === undefined) languages.add("*");
  }
  return [...languages];
}

type SelectorDocument = { languageId: string; uri?: { scheme: string; fsPath: string; path: string } };

/** Whether `pattern` (a glob, or a `RelativePattern`) matches the document's path, as VS Code does. */
function matchesPattern(pattern: unknown, uri: SelectorDocument["uri"]): boolean {
  if (!uri) return false;
  const path = (uri.scheme === "file" ? uri.fsPath : uri.path).replace(/\\/g, "/");
  if (typeof pattern === "string") return globToRegExp(pattern.replace(/\\/g, "/")).test(path);
  if (pattern && typeof pattern === "object" && typeof (pattern as any).pattern === "string") {
    const { baseUri, base, pattern: glob } = pattern as { baseUri?: { fsPath: string; path: string; scheme: string }; base?: string; pattern: string };
    const basePath = (baseUri ? (baseUri.scheme === "file" ? baseUri.fsPath : baseUri.path) : (base ?? "")).replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${basePath}/`;
    const same = process.platform === "win32" ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
    return same && globToRegExp(glob.replace(/\\/g, "/")).test(path.slice(prefix.length));
  }
  return false;
}

/**
 * VS Code's `languages.match` score: 10 for an exact match, 5 for a `*` match, 0 when
 * the selector does not apply. A filter's language, scheme and pattern must all match;
 * a filter with none of them (or for notebooks only) matches nothing.
 */
export function match(selector: DocumentSelector, document: SelectorDocument): number {
  if (Array.isArray(selector)) return Math.max(0, ...selector.map((s) => match(s, document)));
  if (typeof selector === "string") return selector === document.languageId ? 10 : selector === "*" ? 5 : 0;
  if (!selector) return 0;
  const { language, scheme, pattern, notebookType } = selector;
  if (!language && !scheme && !pattern && !notebookType) return 0;
  // Documents here are never notebook cells.
  if (notebookType) return 0;
  let score = 0;
  if (scheme) {
    if (scheme === document.uri?.scheme) score = 10;
    else if (scheme === "*") score = 5;
    else return 0;
  }
  if (language) {
    if (language === document.languageId) score = 10;
    else if (language === "*") score = Math.max(score, 5);
    else return 0;
  }
  if (pattern) {
    if (matchesPattern(pattern, document.uri)) score = 10;
    else return 0;
  }
  return score;
}

export function register(kind: string, extension: string, selector: DocumentSelector, provider: any, metadata?: unknown) {
  const handle = nextHandle++;
  registrations.set(handle, { kind, provider, extension, selector });
  rpc.notify("providers/register", { handle, kind, languages: selectorLanguages(selector), metadata, extension });
  // Semantic tokens and inline values say when they should be asked again.
  const event = provider?.onDidChangeSemanticTokens ?? provider?.onDidChangeInlineValues;
  const subscription = typeof event === "function" ? event(() => rpc.notify("providers/changed", { handle })) : undefined;
  return new Disposable(() => {
    subscription?.dispose?.();
    registrations.delete(handle);
    rpc.notify("providers/unregister", { handle });
  });
}

/** A call or type hierarchy item for the UI; the item itself stays here, under its id. */
function hierarchyItem(registration: Registration, item: any) {
  const id = (registration.nextItem = (registration.nextItem ?? 0) + 1);
  (registration.items ??= new Map()).set(id, item);
  return {
    id,
    name: item.name,
    kind: item.kind,
    detail: item.detail || undefined,
    uri: item.uri.toString(),
    range: dto.range(item.range),
    selectionRange: dto.range(item.selectionRange),
    deprecated: item.tags?.includes(1) || undefined,
  };
}

interface DataTransferEntryDto {
  mime: string;
  value?: unknown;
  file?: { name: string; uri?: string; data?: unknown };
}

/** The UI's clipboard or drop contents as a `vscode.DataTransfer`. */
function dataTransfer(entries: DataTransferEntryDto[] | undefined): DataTransfer {
  const transfer = new DataTransfer();
  for (const entry of entries ?? []) {
    const file = entry.file;
    transfer.set(
      entry.mime,
      new DataTransferItem(
        entry.value ?? "",
        file && {
          name: file.name,
          uri: file.uri ? Uri.parse(file.uri) : undefined,
          data: async () => (decodeBinary(file.data) as Uint8Array | undefined) ?? new Uint8Array(),
        },
      ),
    );
  }
  return transfer;
}

/** Drop or paste edits for the UI, resolved first (the UI applies them as they are). */
async function dropOrPasteEdits(result: any, resolve: ((edit: any) => any) | undefined) {
  const list: any[] = Array.isArray(result) ? result : result ? [result] : [];
  const resolved = await Promise.all(list.map(async (edit) => (resolve ? ((await resolve(edit)) ?? edit) : edit)));
  return resolved.map((edit) => ({
    title: edit.title,
    kind: edit.kind?.value,
    insertText: typeof edit.insertText === "string" ? edit.insertText : undefined,
    snippet: edit.insertText instanceof SnippetString ? edit.insertText.value : undefined,
    additionalEdit: edit.additionalEdit ? dto.workspaceEdit(edit.additionalEdit) : undefined,
    // Kinds now; older extensions give `{ mimeType }`.
    yieldTo: edit.yieldTo?.map((y: any) => (y instanceof DocumentDropOrPasteEditKind ? { kind: y.value } : y?.mimeType ? { mimeType: y.mimeType } : { kind: String(y?.value ?? y) })),
  }));
}

/** Methods about hierarchy items the UI got before (expanding a node): no document involved. */
async function provideForItem(registration: Registration, params: any) {
  const { provider } = registration;
  const token = new CancellationTokenSource().token;
  const item = registration.items?.get(params.item);
  if (!item) return [];
  const related = (list: any[] | null | undefined, pick: (entry: any) => { item: unknown; ranges?: Range[] }) =>
    (list ?? []).map((entry) => {
      const { item: other, ranges } = pick(entry);
      return { item: hierarchyItem(registration, other), ranges: (ranges ?? []).map(dto.range) };
    });
  switch (params.method) {
    case "incomingCalls":
      return related(await provider.provideCallHierarchyIncomingCalls(item, token), (c) => ({ item: c.from, ranges: c.fromRanges }));
    case "outgoingCalls":
      return related(await provider.provideCallHierarchyOutgoingCalls(item, token), (c) => ({ item: c.to, ranges: c.fromRanges }));
    case "supertypes":
      return related(await provider.provideTypeHierarchySupertypes(item, token), (t) => ({ item: t }));
    case "subtypes":
      return related(await provider.provideTypeHierarchySubtypes(item, token), (t) => ({ item: t }));
    default:
      throw new Error(`Unsupported provider method ${params.method}`);
  }
}

const ITEM_METHODS = new Set(["incomingCalls", "outgoingCalls", "supertypes", "subtypes"]);

/** Turns a diagnostic sent back by the UI (in a code action context) into a `vscode.Diagnostic`. */
function toDiagnostic(d: any) {
  const diagnostic = new Diagnostic(dto.toRange(d.range), d.message, d.severity);
  diagnostic.source = d.source;
  diagnostic.code = d.code;
  return diagnostic;
}

const options = (o: any) => ({ tabSize: o?.tabSize ?? 4, insertSpaces: o?.insertSpaces ?? true });

/** Runs one provider method for the UI and converts its result to JSON. */
async function provide(params: any) {
  const registration = registrations.get(params.handle);
  if (!registration) return null;
  const { provider } = registration;
  const token = new CancellationTokenSource().token;
  if (params.method === "workspaceSymbols") {
    const symbols = (await provider.provideWorkspaceSymbols(params.query ?? "", token)) ?? [];
    return symbols.map((s: any) => ({
      name: s.name,
      kind: s.kind,
      containerName: s.containerName || undefined,
      uri: s.location?.uri?.toString(),
      // Symbols may come without a range (to resolve later): the file's start then.
      range: s.location?.range ? dto.range(s.location.range) : undefined,
    }));
  }
  if (ITEM_METHODS.has(params.method)) return provideForItem(registration, params);
  const document = documentFor(params.uri);
  if (!document) return null;
  // e.g. `{ pattern: "**/.github/workflows/*.yml" }`: registered for every language in the UI.
  if (match(registration.selector, document) === 0) return null;
  const position = params.position ? dto.toPosition(params.position) : undefined;
  const range = params.range ? dto.toRange(params.range) : undefined;

  switch (params.method) {
    case "completion": {
      const result = await provider.provideCompletionItems(document, position, token, {
        triggerKind: params.triggerCharacter ? CompletionTriggerKind.TriggerCharacter : CompletionTriggerKind.Invoke,
        triggerCharacter: params.triggerCharacter,
      });
      registration.lastItems = Array.isArray(result) ? result : result?.items;
      return dto.completionItems(result);
    }
    case "resolveCompletion": {
      const item = registration.lastItems?.[params.id];
      if (!item || !provider.resolveCompletionItem) return null;
      const resolved = (await provider.resolveCompletionItem(item, token)) ?? item;
      return dto.completionItems([resolved]).items[0];
    }
    case "hover":
      return dto.hover(await provider.provideHover(document, position, token));
    case "definition":
      return dto.locations(await provider.provideDefinition(document, position, token));
    case "declaration":
      return dto.locations(await provider.provideDeclaration(document, position, token));
    case "typeDefinition":
      return dto.locations(await provider.provideTypeDefinition(document, position, token));
    case "implementation":
      return dto.locations(await provider.provideImplementation(document, position, token));
    case "references":
      return dto.locations(
        await provider.provideReferences(document, position, { includeDeclaration: params.includeDeclaration ?? true }, token),
      );
    case "documentHighlight": {
      const highlights = (await provider.provideDocumentHighlights(document, position, token)) ?? [];
      return highlights.map((h: any) => ({ range: dto.range(h.range), kind: h.kind }));
    }
    case "documentSymbol":
      return dto.documentSymbols(await provider.provideDocumentSymbols(document, token));
    case "formatting":
      return ((await provider.provideDocumentFormattingEdits(document, options(params.options), token)) ?? []).map(dto.textEdit);
    case "rangeFormatting":
      return ((await provider.provideDocumentRangeFormattingEdits(document, range, options(params.options), token)) ?? []).map(dto.textEdit);
    case "onTypeFormatting":
      return ((await provider.provideOnTypeFormattingEdits(document, position, params.ch, options(params.options), token)) ?? []).map(dto.textEdit);
    case "codeActions": {
      const only = params.only ? new CodeActionKind(params.only) : undefined;
      const actions =
        (await provider.provideCodeActions(
          document,
          range,
          { diagnostics: (params.diagnostics ?? []).map(toDiagnostic), only, triggerKind: CodeActionTriggerKind.Invoke },
          token,
        )) ?? [];
      return actions.map((action: any) =>
        "command" in action && typeof action.command === "string"
          ? { title: action.title, command: dto.command(action) }
          : {
              title: action.title,
              kind: action.kind?.value,
              isPreferred: action.isPreferred,
              disabled: action.disabled?.reason,
              edit: action.edit ? dto.workspaceEdit(action.edit) : undefined,
              command: dto.command(action.command),
            },
      );
    }
    case "codeLens": {
      const lenses = (await provider.provideCodeLenses(document, token)) ?? [];
      const resolved = await Promise.all(
        lenses.map(async (lens: any) => (lens.command || !provider.resolveCodeLens ? lens : await provider.resolveCodeLens(lens, token))),
      );
      return resolved.filter((l: any) => l?.command).map((l: any) => ({ range: dto.range(l.range), command: dto.command(l.command) }));
    }
    case "signatureHelp": {
      const help = await provider.provideSignatureHelp(document, position, token, {
        triggerKind: params.triggerCharacter ? SignatureHelpTriggerKind.TriggerCharacter : SignatureHelpTriggerKind.Invoke,
        triggerCharacter: params.triggerCharacter,
        isRetrigger: params.isRetrigger ?? false,
        activeSignatureHelp: undefined,
      });
      if (!help) return null;
      return {
        activeSignature: help.activeSignature,
        activeParameter: help.activeParameter,
        signatures: help.signatures.map((s: any) => ({
          label: s.label,
          documentation: dto.markdown(s.documentation),
          activeParameter: s.activeParameter,
          parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: dto.markdown(p.documentation) })),
        })),
      };
    }
    case "prepareRename": {
      if (!provider.prepareRename) return null;
      const result = await provider.prepareRename(document, position, token);
      if (!result) return null;
      return result instanceof Range ? { range: dto.range(result) } : { range: dto.range(result.range), placeholder: result.placeholder };
    }
    case "rename": {
      const edit = await provider.provideRenameEdits(document, position, params.newName, token);
      return edit ? dto.workspaceEdit(edit) : null;
    }
    case "foldingRanges":
      return ((await provider.provideFoldingRanges(document, {}, token)) ?? []).map((f: any) => ({
        start: f.start,
        end: f.end,
        kind: f.kind,
      }));
    case "documentLinks": {
      const links = (await provider.provideDocumentLinks(document, token)) ?? [];
      return links.map((l: any) => ({ range: dto.range(l.range), target: l.target?.toString(), tooltip: l.tooltip }));
    }
    case "inlayHints": {
      const hints = (await provider.provideInlayHints(document, range, token)) ?? [];
      return hints.map((h: any) => ({
        position: dto.position(h.position),
        label: typeof h.label === "string" ? h.label : h.label.map((p: any) => p.value).join(""),
        kind: h.kind,
        paddingLeft: h.paddingLeft,
        paddingRight: h.paddingRight,
        tooltip: dto.markdown(h.tooltip),
      }));
    }
    case "inlineCompletions": {
      const result = await provider.provideInlineCompletionItems(document, position, {
        // Monaco: Automatic = 0, Explicit = 1; the API: Invoke = 0, Automatic = 1.
        triggerKind: params.explicit ? InlineCompletionTriggerKind.Invoke : InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: params.selected
          ? { range: dto.toRange(params.selected.range), text: params.selected.text }
          : undefined,
      }, token);
      const items = (Array.isArray(result) ? result : result?.items) ?? [];
      return items.map((item: any) => ({
        insertText: item.insertText instanceof SnippetString ? undefined : String(item.insertText ?? ""),
        snippet: item.insertText instanceof SnippetString ? item.insertText.value : undefined,
        filterText: item.filterText,
        range: item.range ? dto.range(item.range) : undefined,
        command: dto.command(item.command),
      }));
    }
    case "selectionRanges": {
      const positions = (params.positions ?? []).map(dto.toPosition);
      const ranges = (await provider.provideSelectionRanges(document, positions, token)) ?? [];
      // Each position's chain, innermost first.
      return ranges.map((r: any) => {
        const chain: dto.RangeDto[] = [];
        for (let current = r; current; current = current.parent) chain.push(dto.range(current.range));
        return chain;
      });
    }
    case "linkedEditing": {
      const result = await provider.provideLinkedEditingRanges(document, position, token);
      if (!result) return null;
      const pattern = result.wordPattern as RegExp | undefined;
      return { ranges: result.ranges.map(dto.range), wordPattern: pattern ? { source: pattern.source, flags: pattern.flags } : undefined };
    }
    case "colors": {
      const colors = (await provider.provideDocumentColors(document, token)) ?? [];
      return colors.map((c: any) => ({
        range: dto.range(c.range),
        color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha },
      }));
    }
    case "colorPresentations": {
      const c = params.color;
      const presentations =
        (await provider.provideColorPresentations(new Color(c.red, c.green, c.blue, c.alpha), { document, range }, token)) ?? [];
      return presentations.map((p: any) => ({
        label: p.label,
        textEdit: p.textEdit ? dto.textEdit(p.textEdit) : undefined,
        additionalTextEdits: p.additionalTextEdits?.map(dto.textEdit),
      }));
    }
    case "semanticTokens": {
      // A range provider alone answers for the whole document: the UI colours whole documents.
      const result = provider.provideDocumentSemanticTokens
        ? await provider.provideDocumentSemanticTokens(document, token)
        : await provider.provideDocumentRangeSemanticTokens(document, new Range(0, 0, document.lineCount, 0), token);
      const data = result?.data;
      return data ? { data: Array.from(data as ArrayLike<number>) } : null;
    }
    case "prepareCallHierarchy":
    case "prepareTypeHierarchy": {
      // A new hierarchy: the items of the previous one are no longer shown.
      registration.items = new Map();
      const result =
        params.method === "prepareCallHierarchy"
          ? await provider.prepareCallHierarchy(document, position, token)
          : await provider.prepareTypeHierarchy(document, position, token);
      const list = Array.isArray(result) ? result : result ? [result] : [];
      return list.map((item: any) => hierarchyItem(registration, item));
    }
    case "evaluatableExpression": {
      const result = await provider.provideEvaluatableExpression(document, position, token);
      return result ? { range: dto.range(result.range), expression: result.expression } : null;
    }
    case "inlineValues": {
      const context = { frameId: params.frameId, stoppedLocation: dto.toRange(params.stoppedLocation) };
      const values = (await provider.provideInlineValues(document, range, context, token)) ?? [];
      return values.map((v: any) => {
        const at = dto.range(v.range);
        if (typeof v.text === "string") return { kind: "text", range: at, text: v.text };
        if ("caseSensitiveLookup" in v) return { kind: "variable", range: at, variableName: v.variableName, caseSensitive: v.caseSensitiveLookup };
        return { kind: "expression", range: at, expression: v.expression };
      });
    }
    case "drop": {
      const result = await provider.provideDocumentDropEdits(document, position, dataTransfer(params.dataTransfer), token);
      return dropOrPasteEdits(result, provider.resolveDocumentDropEdit && ((e: any) => provider.resolveDocumentDropEdit(e, token)));
    }
    case "paste": {
      const ranges = (params.ranges ?? []).map(dto.toRange);
      const only = params.only ? new DocumentDropOrPasteEditKind(params.only) : undefined;
      const result = await provider.provideDocumentPasteEdits(
        document,
        ranges,
        dataTransfer(params.dataTransfer),
        { only, triggerKind: params.triggerKind ?? 0 },
        token,
      );
      return dropOrPasteEdits(result, provider.resolveDocumentPasteEdit && ((e: any) => provider.resolveDocumentPasteEdit(e, token)));
    }
    case "preparePaste": {
      // On copy: the provider adds its own data (e.g. the imports the copied code needs),
      // which comes back with the paste.
      if (!provider.prepareDocumentPaste) return null;
      const transfer = dataTransfer(params.dataTransfer);
      await provider.prepareDocumentPaste(document, (params.ranges ?? []).map(dto.toRange), transfer, token);
      const entries: DataTransferEntryDto[] = [];
      for (const [mime, item] of transfer) if (!item.asFile()) entries.push({ mime, value: item.value });
      return entries;
    }
    default:
      throw new Error(`Unsupported provider method ${params.method}`);
  }
}

export function listen() {
  rpc.onRequest("providers/provide", provide);
}
