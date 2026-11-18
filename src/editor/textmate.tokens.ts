//! Incremental TextMate tokenization of a document and its encoding as Monaco
//! semantic tokens. Pure, so it can be tested outside the worker.

import { INITIAL, type IGrammar, type StateStack } from "vscode-textmate";
import { MAX_COLORS } from "./textmate.protocol";

/** Lines longer than this are left uncoloured, as VS Code does, to bound the work. */
const MAX_LINE_LENGTH = 20_000;
/** Per-line time budget; a line that takes longer is cut short. */
const LINE_TIME_LIMIT_MS = 500;

// Bit layout of vscode-textmate's EncodedTokenAttributes.
const FONT_STYLE_MASK = 0x00007800;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0x00ff8000;
const FOREGROUND_OFFSET = 15;
/** Colour id 1 is the theme's default foreground: tokens in it need no semantic token. */
const DEFAULT_FOREGROUND = 1;

export interface Document {
  scope: string;
  lines: string[];
  /** State at the end of each line. */
  states: StateStack[];
  /** `[startIndex, metadata, ...]` per line, from `tokenizeLine2`. */
  tokens: Uint32Array[];
}

export function emptyDocument(scope: string): Document {
  return { scope, lines: [], states: [], tokens: [] };
}

/** Re-tokenizes `text`, reusing the previous result up to the first changed line. */
export function update(doc: Document, grammar: IGrammar, text: string) {
  const lines = text.split(/\r\n|\r|\n/);
  // The unchanged prefix and suffix; edits (possibly several) lie between them.
  let start = 0;
  while (start < lines.length && start < doc.lines.length && lines[start] === doc.lines[start]) start++;
  let suffix = 0;
  while (
    suffix < lines.length - start &&
    suffix < doc.lines.length - start &&
    lines[lines.length - 1 - suffix] === doc.lines[doc.lines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const shift = doc.lines.length - lines.length;

  const states = doc.states.slice(0, start);
  const tokens = doc.tokens.slice(0, start);
  let state = start > 0 ? states[start - 1] : INITIAL;
  for (let i = start; i < lines.length; i++) {
    // Inside the unchanged suffix, a line starting in the same state as before
    // tokenizes as before, and so does everything after it.
    const old = i + shift;
    if (i > start && i >= lines.length - suffix && old > 0 && doc.states[old - 1]?.equals(state)) {
      states.push(...doc.states.slice(old));
      tokens.push(...doc.tokens.slice(old));
      break;
    }
    if (lines[i].length > MAX_LINE_LENGTH) {
      states.push(state);
      tokens.push(new Uint32Array(0));
      continue;
    }
    const result = grammar.tokenizeLine2(lines[i], state, LINE_TIME_LIMIT_MS);
    state = result.ruleStack;
    states.push(state);
    tokens.push(result.tokens);
  }
  doc.lines = lines;
  doc.states = states;
  doc.tokens = tokens;
}

/** Encodes the document's coloured tokens as Monaco semantic token data. */
export function encode(doc: Document): Uint32Array {
  const data: number[] = [];
  let lastLine = 0;
  let lastStart = 0;
  doc.tokens.forEach((line, lineIndex) => {
    const length = doc.lines[lineIndex].length;
    for (let i = 0; i < line.length; i += 2) {
      const start = line[i];
      const end = i + 2 < line.length ? line[i + 2] : length;
      const meta = line[i + 1];
      const foreground = (meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
      const fontStyle = (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
      if (end <= start || foreground >= MAX_COLORS || (foreground === DEFAULT_FOREGROUND && fontStyle === 0)) continue;
      data.push(
        lineIndex - lastLine,
        lineIndex === lastLine ? start - lastStart : start,
        end - start,
        foreground,
        // One modifier per font style combination (`s1`..`s15`), so the theme rule `tm<c>.s<n>` matches.
        fontStyle ? 1 << (fontStyle - 1) : 0,
      );
      lastLine = lineIndex;
      lastStart = start;
    }
  });
  return Uint32Array.from(data);
}
