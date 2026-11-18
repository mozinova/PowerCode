//! Text documents open in PowerCode, mirrored here as `vscode.TextDocument`s.

import * as rpc from "./rpc";
import { EndOfLine, EventEmitter, Position, Range, Uri } from "./types";

export class TextDocumentImpl {
  private lines: string[] = [];
  private lineStarts: number[] = [];
  isDirty = false;
  isClosed = false;
  readonly isUntitled = false;
  readonly notebook = undefined;

  constructor(
    readonly uri: Uri,
    public languageId: string,
    public version: number,
    private text: string,
  ) {
    this.setText(text, version);
  }

  get fileName() {
    return this.uri.fsPath;
  }
  get lineCount() {
    return this.lines.length;
  }
  get eol() {
    return this.text.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF;
  }

  setText(text: string, version: number) {
    this.text = text;
    this.version = version;
    this.lines = text.split(/\r\n|\r|\n/);
    this.lineStarts = [0];
    const re = /\r\n|\r|\n/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) this.lineStarts.push(match.index + match[0].length);
  }

  getText(range?: Range) {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  lineAt(lineOrPosition: number | Position) {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    if (line < 0 || line >= this.lines.length) throw new Error(`Illegal line ${line}`);
    const text = this.lines[line];
    const firstNonWhitespace = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak:
        line < this.lines.length - 1 ? new Range(line, 0, line + 1, 0) : new Range(line, 0, line, text.length),
      firstNonWhitespaceCharacterIndex: firstNonWhitespace < 0 ? text.length : firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace < 0,
    };
  }

  offsetAt(position: Position) {
    const p = this.validatePosition(position);
    return this.lineStarts[p.line] + p.character;
  }

  positionAt(offset: number) {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return new Position(low, Math.min(clamped - this.lineStarts[low], this.lines[low].length));
  }

  validatePosition(position: Position) {
    const line = Math.max(0, Math.min(position.line, this.lines.length - 1));
    const character = Math.max(0, Math.min(position.character, this.lines[line].length));
    return line === position.line && character === position.character ? position : new Position(line, character);
  }

  validateRange(range: Range) {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  getWordRangeAtPosition(position: Position, regex = /[\w$]+/g) {
    const p = this.validatePosition(position);
    const line = this.lines[p.line];
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = re.exec(line))) {
      const start = match.index;
      const end = start + match[0].length;
      if (start <= p.character && p.character <= end && end > start) return new Range(p.line, start, p.line, end);
      if (match[0].length === 0) re.lastIndex++;
    }
    return undefined;
  }

  save() {
    return saveDocument(this.uri);
  }
}

/** Saves an open document through the editor (which runs save participants and writes it). */
export function saveDocument(uri: Uri): Promise<boolean> {
  return rpc.request<boolean>("documents/saveDocument", { uri: uri.toString() }).catch(() => false);
}

export const documents = new Map<string, TextDocumentImpl>();

export const onDidOpen = new EventEmitter<TextDocumentImpl>();
export const onDidClose = new EventEmitter<TextDocumentImpl>();
export const onDidSave = new EventEmitter<TextDocumentImpl>();
export const onDidChange = new EventEmitter<{
  document: TextDocumentImpl;
  contentChanges: { range: Range; rangeOffset: number; rangeLength: number; text: string }[];
  reason: undefined;
}>();

export function documentFor(uri: Uri | string) {
  return documents.get(typeof uri === "string" ? uri : uri.toString());
}
