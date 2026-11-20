//! Extensions' semantic tokens merged into the grammar's (see textmate.ts and
//! semanticTokens.ts). No imports, so tests can run it outside the app.

/** A token from an extension's semantic tokens provider, already in this file's encoding. */
export interface OverlayToken {
  line: number;
  start: number;
  length: number;
  /** Colour-map index (`tm<color>`). */
  color: number;
  /** Modifier bits (`s<font style>`). */
  modifiers: number;
}

/** Relative-encoded tokens (Monaco's format) as absolute ones, by line. */
export function decode(data: Uint32Array | number[]): OverlayToken[] {
  const tokens: OverlayToken[] = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    if (data[i] > 0) start = 0;
    line += data[i];
    start += data[i + 1];
    tokens.push({ line, start, length: data[i + 2], color: data[i + 3], modifiers: data[i + 4] });
  }
  return tokens;
}

export function encodeTokens(tokens: OverlayToken[]): Uint32Array {
  const data = new Uint32Array(tokens.length * 5);
  let line = 0;
  let start = 0;
  tokens.forEach((t, i) => {
    data[i * 5] = t.line - line;
    data[i * 5 + 1] = t.line === line ? t.start - start : t.start;
    data[i * 5 + 2] = t.length;
    data[i * 5 + 3] = t.color;
    data[i * 5 + 4] = t.modifiers;
    line = t.line;
    start = t.start;
  });
  return data;
}

/**
 * The grammar's tokens with `overlay` drawn over them, as VS Code draws semantic
 * tokens over TextMate ones: where they overlap, the grammar token is cut.
 * `overlay` is sorted and does not overlap itself.
 */
export function mergeTokens(base: Uint32Array | null, overlay: OverlayToken[]): Uint32Array {
  if (overlay.length === 0) return base ?? new Uint32Array();
  const result: OverlayToken[] = [];
  // Where the last overlay token pushed ends: it may cover the start of the next grammar token.
  let coverLine = -1;
  let coverEnd = 0;
  const pushCover = (cover: OverlayToken) => {
    result.push(cover);
    coverLine = cover.line;
    coverEnd = cover.start + cover.length;
  };
  let o = 0;
  for (const token of base ? decode(base) : []) {
    // Overlay tokens on earlier lines or before this token come first.
    while (o < overlay.length && (overlay[o].line < token.line || (overlay[o].line === token.line && overlay[o].start < token.start))) {
      pushCover(overlay[o++]);
    }
    // The parts of `token` the overlay tokens on its line leave uncovered.
    const end = token.start + token.length;
    let from = coverLine === token.line ? Math.max(token.start, coverEnd) : token.start;
    while (o < overlay.length && overlay[o].line === token.line && overlay[o].start < end) {
      const cover = overlay[o++];
      if (cover.start > from) result.push({ ...token, start: from, length: cover.start - from });
      from = Math.max(from, cover.start + cover.length);
      pushCover(cover);
    }
    if (from < end) result.push({ ...token, start: from, length: end - from });
  }
  while (o < overlay.length) result.push(overlay[o++]);
  return encodeTokens(result);
}
