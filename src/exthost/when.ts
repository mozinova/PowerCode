//! VS Code `when` clauses (`view == npm && viewItem =~ /^script/`) and the
//! context keys they read: those set with `setContext` plus a few PowerCode
//! provides itself.

import { create } from "zustand";

export const useContextKeys = create<{ keys: Record<string, unknown> }>(() => ({ keys: {} }));

export function setContextKey(key: string, value: unknown) {
  useContextKeys.setState(({ keys }) => ({ keys: { ...keys, [key]: value } }));
}

export function resetContextKeys() {
  useContextKeys.setState({ keys: {} });
}

type Token =
  | { kind: "op"; value: string }
  | { kind: "word"; value: string }
  | { kind: "string"; value: string }
  | { kind: "regex"; value: RegExp };

const OPERATORS = ["===", "!==", "==", "!=", "=~", "&&", "||", "<=", ">=", "<", ">", "!", "(", ")"];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", value: op });
      i += op.length;
      // `=~` is followed by a regex literal.
      if (op === "=~") {
        while (/\s/.test(text[i] ?? "")) i++;
        if (text[i] === "/") {
          let j = i + 1;
          while (j < text.length && text[j] !== "/") j += text[j] === "\\" ? 2 : 1;
          const source = text.slice(i + 1, j);
          let k = j + 1;
          while (/[a-z]/i.test(text[k] ?? "")) k++;
          let regex: RegExp;
          try {
            regex = new RegExp(source, text.slice(j + 1, k));
          } catch {
            regex = /$^/;
          }
          tokens.push({ kind: "regex", value: regex });
          i = k;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      const stop = end < 0 ? text.length : end;
      tokens.push({ kind: "string", value: text.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j]) && !OPERATORS.some((o) => text.startsWith(o, j)) && text[j] !== "'" && text[j] !== '"') j++;
    if (j === i) j++;
    tokens.push({ kind: "word", value: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

/** A literal on the right of a comparison: words are strings, except numbers and booleans. */
function literal(token: Token | undefined): unknown {
  if (!token) return undefined;
  if (token.kind === "string") return token.value;
  if (token.kind === "regex") return token.value;
  if (token.value === "true") return true;
  if (token.value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(token.value)) return Number(token.value);
  return token.value;
}

/**
 * Evaluates `expression` against `context`. Unknown keys are undefined (falsy),
 * so a clause about something PowerCode does not track hides the item.
 */
export function evaluateWhen(expression: string | undefined, context: Record<string, unknown>): boolean {
  if (!expression?.trim()) return true;
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === "op" && peek()!.value === value;

  const value = (token: Token | undefined): unknown => {
    if (!token) return undefined;
    if (token.kind !== "word") return literal(token);
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    return context[token.value];
  };

  function primary(): boolean {
    if (isOp("!")) {
      pos++;
      return !primary();
    }
    if (isOp("(")) {
      pos++;
      const result = or();
      if (isOp(")")) pos++;
      return result;
    }
    const left = tokens[pos++];
    const next = peek();
    if (next?.kind === "op" && ["==", "===", "!=", "!==", "=~", "<", ">", "<=", ">="].includes(next.value)) {
      pos++;
      const leftValue = value(left);
      const right = literal(tokens[pos++]);
      switch (next.value) {
        case "==":
        case "===":
          return String(leftValue) === String(right);
        case "!=":
        case "!==":
          return String(leftValue) !== String(right);
        case "=~":
          return right instanceof RegExp && typeof leftValue === "string" && right.test(leftValue);
        case "<":
          return Number(leftValue) < Number(right);
        case ">":
          return Number(leftValue) > Number(right);
        case "<=":
          return Number(leftValue) <= Number(right);
        case ">=":
          return Number(leftValue) >= Number(right);
      }
    }
    // `key in otherKey` / `key not in otherKey`.
    if (next?.kind === "word" && (next.value === "in" || (next.value === "not" && tokens[pos + 1]?.value === "in"))) {
      const negate = next.value === "not";
      pos += negate ? 2 : 1;
      const container = context[(tokens[pos++] as { value: string })?.value];
      const key = value(left);
      const found = Array.isArray(container)
        ? container.includes(key)
        : container !== null && typeof container === "object" && String(key) in container;
      return negate ? !found : found;
    }
    return Boolean(value(left));
  }

  function and(): boolean {
    let result = primary();
    while (isOp("&&")) {
      pos++;
      const right = primary();
      result = result && right;
    }
    return result;
  }

  function or(): boolean {
    let result = and();
    while (isOp("||")) {
      pos++;
      const right = and();
      result = result || right;
    }
    return result;
  }

  try {
    return or();
  } catch {
    return false;
  }
}
