//! Conversions between `vscode` API objects and the plain JSON sent to the UI.
//! Positions are 0-based here, as in the API; the UI converts to Monaco's 1-based.

import {
  CompletionItem,
  CompletionList,
  DocumentSymbol,
  Hover,
  Location,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  SymbolInformation,
  TextEdit,
  Uri,
  WorkspaceEdit,
  type Command,
} from "./types";

export interface PositionDto {
  line: number;
  character: number;
}
export interface RangeDto {
  start: PositionDto;
  end: PositionDto;
}

export const position = (p: Position): PositionDto => ({ line: p.line, character: p.character });
export const range = (r: Range): RangeDto => ({ start: position(r.start), end: position(r.end) });
export const toPosition = (p: PositionDto) => new Position(p.line, p.character);
export const toRange = (r: RangeDto) => new Range(toPosition(r.start), toPosition(r.end));

/** Markdown (or plain text, escaped as markdown is not needed) for hovers and docs. */
export function markdown(value: string | MarkdownString | { language: string; value: string } | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof MarkdownString || "value" in value) {
    if ("language" in value && value.language) return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
    return value.value;
  }
  return undefined;
}

export function textEdit(edit: TextEdit) {
  return { range: range(edit.range), newText: edit.newText };
}

export function command(cmd: Command | undefined) {
  return cmd ? { title: cmd.title, command: cmd.command, arguments: cmd.arguments } : undefined;
}

export function workspaceEdit(edit: WorkspaceEdit) {
  return {
    edits: edit.entries().map(([uri, edits]) => ({ uri: uri.toString(), edits: edits.map(textEdit) })),
    operations: edit.operations.map((op) => ({
      kind: op.kind,
      uri: op.uri?.toString(),
      from: op.from?.toString(),
      to: op.to?.toString(),
    })),
  };
}

export function completionItems(result: CompletionItem[] | CompletionList | null | undefined) {
  if (!result) return { items: [], incomplete: false };
  const list = Array.isArray(result) ? new CompletionList(result) : result;
  return {
    incomplete: list.isIncomplete,
    items: list.items.map((item, id) => {
      const label = typeof item.label === "string" ? item.label : item.label.label;
      const insert = item.insertText ?? label;
      let itemRange: unknown;
      if (item.range instanceof Range) itemRange = range(item.range);
      else if (item.range) itemRange = { insert: range(item.range.inserting), replace: range(item.range.replacing) };
      return {
        id,
        label,
        labelDetail: typeof item.label === "string" ? undefined : item.label.detail,
        labelDescription: typeof item.label === "string" ? undefined : item.label.description,
        kind: item.kind,
        detail: item.detail,
        documentation: markdown(item.documentation),
        insertText: insert instanceof SnippetString ? insert.value : insert,
        isSnippet: insert instanceof SnippetString,
        range: itemRange,
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
        commitCharacters: item.commitCharacters,
        additionalTextEdits: item.additionalTextEdits?.map(textEdit),
        command: command(item.command),
        tags: item.tags,
      };
    }),
  };
}

export function hover(result: Hover | null | undefined) {
  if (!result) return null;
  return {
    contents: result.contents.map((c) => markdown(c as MarkdownString | string)).filter((c) => c !== undefined),
    range: result.range ? range(result.range) : undefined,
  };
}

/** Location, Location[], LocationLink[] -> uniform links. */
export function locations(result: unknown) {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((item: any) => {
    if (item instanceof Location || ("uri" in item && "range" in item)) {
      return { uri: item.uri.toString(), range: range(item.range) };
    }
    return {
      uri: item.targetUri.toString(),
      range: range(item.targetSelectionRange ?? item.targetRange),
      targetRange: range(item.targetRange),
      originSelectionRange: item.originSelectionRange ? range(item.originSelectionRange) : undefined,
    };
  });
}

interface SymbolDto {
  name: string;
  detail: string;
  kind: number;
  range: RangeDto;
  selectionRange: RangeDto;
  children: SymbolDto[];
}

export function documentSymbols(result: (DocumentSymbol | SymbolInformation)[] | null | undefined): SymbolDto[] {
  if (!result) return [];
  const convert = (s: DocumentSymbol | SymbolInformation): SymbolDto =>
    s instanceof SymbolInformation || "location" in s
      ? {
          name: s.name,
          detail: (s as SymbolInformation).containerName ?? "",
          kind: s.kind,
          range: range((s as SymbolInformation).location.range),
          selectionRange: range((s as SymbolInformation).location.range),
          children: [],
        }
      : {
          name: s.name,
          detail: s.detail,
          kind: s.kind,
          range: range(s.range),
          selectionRange: range(s.selectionRange),
          children: (s.children ?? []).map(convert),
        };
  return result.map(convert);
}

export function uriOf(value: string) {
  return Uri.parse(value);
}
