//! Language feature providers registered by extensions, and the requests the
//! UI makes to them (completion, hover, definition, ...).

import { documentFor } from "./documents";
import * as dto from "./dto";
import * as rpc from "./rpc";
import {
  CancellationTokenSource,
  CodeActionKind,
  CodeActionTriggerKind,
  CompletionItem,
  CompletionTriggerKind,
  Diagnostic,
  Disposable,
  Range,
  SignatureHelpTriggerKind,
} from "./types";

export type DocumentSelector =
  | string
  | { language?: string; scheme?: string; pattern?: unknown; notebookType?: string }
  | (string | { language?: string; scheme?: string; pattern?: unknown; notebookType?: string })[];

interface Registration {
  kind: string;
  provider: any;
  extension: string;
  /** Completion items of the last result, for `resolveCompletionItem`. */
  lastItems?: CompletionItem[];
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

export function match(selector: DocumentSelector, document: { languageId: string }): number {
  const languages = selectorLanguages(selector);
  if (languages.includes(document.languageId)) return 10;
  return languages.includes("*") ? 5 : 0;
}

export function register(kind: string, extension: string, selector: DocumentSelector, provider: any, metadata?: unknown) {
  const handle = nextHandle++;
  registrations.set(handle, { kind, provider, extension });
  rpc.notify("providers/register", { handle, kind, languages: selectorLanguages(selector), metadata, extension });
  return new Disposable(() => {
    registrations.delete(handle);
    rpc.notify("providers/unregister", { handle });
  });
}

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
  const document = documentFor(params.uri);
  if (!document) return null;
  const token = new CancellationTokenSource().token;
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
    default:
      throw new Error(`Unsupported provider method ${params.method}`);
  }
}

export function listen() {
  rpc.onRequest("providers/provide", provide);
}
