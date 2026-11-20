// Extensions' semantic tokens drawn over the grammar's tokens (src/editor/tokenMerge.ts):
// where they overlap, the semantic token wins and the grammar token is cut around it.
// Run with `bun test`.

import { describe, expect, test } from "bun:test";
import { decode, encodeTokens, mergeTokens, type OverlayToken } from "../../src/editor/tokenMerge";

const token = (line: number, start: number, length: number, color: number, modifiers = 0): OverlayToken => ({ line, start, length, color, modifiers });

/** Tokens as `line:start-end=color` strings, easy to compare. */
const show = (data: Uint32Array) => decode(data).map((t) => `${t.line}:${t.start}-${t.start + t.length}=${t.color}${t.modifiers ? `.${t.modifiers}` : ""}`);

describe("merging semantic tokens into grammar tokens", () => {
  test("encoding round-trips, with starts relative on the same line only", () => {
    const tokens = [token(0, 0, 3, 1), token(0, 4, 2, 2, 8), token(2, 5, 1, 3)];
    const data = encodeTokens(tokens);
    expect([...data.slice(5, 10)]).toEqual([0, 4, 2, 2, 8]);
    expect([...data.slice(10, 15)]).toEqual([2, 5, 1, 3, 0]);
    expect(decode(data)).toEqual(tokens);
  });

  test("no overlay keeps the grammar's tokens as they are", () => {
    const base = encodeTokens([token(0, 0, 5, 1)]);
    expect(mergeTokens(base, [])).toBe(base);
  });

  test("a semantic token inside a grammar token splits it", () => {
    // `let foo = bar;` coloured as one grammar token; `foo` is a readonly variable.
    const base = encodeTokens([token(0, 0, 14, 1)]);
    expect(show(mergeTokens(base, [token(0, 4, 3, 9, 2)]))).toEqual(["0:0-4=1", "0:4-7=9.2", "0:7-14=1"]);
  });

  test("a semantic token across several grammar tokens replaces the parts it covers", () => {
    const base = encodeTokens([token(0, 0, 4, 1), token(0, 4, 4, 2), token(0, 8, 4, 3)]);
    expect(show(mergeTokens(base, [token(0, 2, 8, 9)]))).toEqual(["0:0-2=1", "0:2-10=9", "0:10-12=3"]);
  });

  test("semantic tokens where the grammar has none, and on other lines, are kept in order", () => {
    const base = encodeTokens([token(1, 0, 3, 1), token(1, 6, 2, 2)]);
    const merged = mergeTokens(base, [token(0, 1, 2, 7), token(1, 3, 2, 8), token(1, 6, 2, 9), token(3, 0, 1, 7)]);
    expect(show(merged)).toEqual(["0:1-3=7", "1:0-3=1", "1:3-5=8", "1:6-8=9", "3:0-1=7"]);
  });

  test("without grammar tokens (a language without a grammar) the semantic tokens are all there is", () => {
    expect(show(mergeTokens(null, [token(0, 1, 2, 7), token(4, 0, 3, 8)]))).toEqual(["0:1-3=7", "4:0-3=8"]);
  });

  test("an exactly covered grammar token disappears", () => {
    const base = encodeTokens([token(0, 0, 3, 1), token(0, 3, 3, 2), token(0, 6, 3, 3)]);
    expect(show(mergeTokens(base, [token(0, 3, 3, 9)]))).toEqual(["0:0-3=1", "0:3-6=9", "0:6-9=3"]);
  });
});
