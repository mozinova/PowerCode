//! Finding links in terminal text: URLs and path-looking words with an optional
//! position, and the full paths a written path may mean. No I/O: ./links checks
//! which paths exist.

import { joinPath } from "../lib/paths";
import { linuxPath, remoteOf, workspacePath } from "../lib/remote";

const IS_WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** Candidates checked per line, so a wall of text does not become a wall of lookups. */
const MAX_CANDIDATES = 30;

export interface Found {
  /** Offset in the logical line and length of the underlined text. */
  start: number;
  length: number;
  kind: "url" | "path";
  /** The URL, or the path as written. */
  target: string;
  line?: number;
  column?: number;
}

const URL_PATTERN = /\b(?:https?|file):\/\/[^\s"'`<>]+/g;
/**
 * Absolute (`C:\a\b`, `/a/b`), relative (`./a`, `src/a.ts`) or bare (`a.ts`) paths, then
 * an optional position: `:12`, `:12:3`, `(12,3)`.
 */
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w.@~+-]+(?:[\\/][\w.@~+-]+)*(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;
/** Python's traceback: `File "path", line 12`. */
const PYTHON_PATTERN = /File "([^"]+)", line (\d+)/g;

/** Trailing punctuation that ends a sentence rather than the URL; a `)` stays if it closes a `(` in the URL. */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?'\"]}>".includes(ch)) end--;
    else if (ch === ")" && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--;
    else break;
  }
  return url.slice(0, end);
}

function overlaps(found: Found[], start: number, end: number) {
  return found.some((f) => start < f.start + f.length && f.start < end);
}

/** URLs and path-looking words of `text`. */
export function findLinks(text: string): Found[] {
  const found: Found[] = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(m[0]);
    if (url.length > "https://".length) found.push({ start: m.index!, length: url.length, kind: "url", target: url });
  }
  for (const m of text.matchAll(PYTHON_PATTERN)) {
    const start = m.index! + m[0].indexOf('"') + 1;
    if (!overlaps(found, start, start + m[1].length)) {
      found.push({ start, length: m[1].length, kind: "path", target: m[1], line: Number(m[2]) });
    }
  }
  let candidates = 0;
  for (const m of text.matchAll(PATH_PATTERN)) {
    const whole = m[0];
    const position = whole.search(/(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/);
    const path = (position >= 0 ? whole.slice(0, position) : whole).replace(/[.:]+$/, "");
    // A word without a separator or an extension (`hello`, `v1`) is not a path.
    if (!/[\\/]/.test(path) && !/\.[A-Za-z][\w-]*$/.test(path)) continue;
    if (/^\d+(\.\d+)*$/.test(path) || overlaps(found, m.index!, m.index! + whole.length)) continue;
    if (++candidates > MAX_CANDIDATES) break;
    // With a position the link covers it; without, not the sentence's final `.`.
    const length = position >= 0 ? whole.length : path.length;
    found.push({
      start: m.index!,
      length,
      kind: "path",
      target: path,
      line: Number(m[1] ?? m[3]) || undefined,
      column: Number(m[2] ?? m[4]) || undefined,
    });
  }
  return found;
}

/** Full paths `written` may mean, in the order tried; `cwd` is the terminal's folder. */
export function resolveCandidates(written: string, cwd: string | null, root: string | null, windows = IS_WINDOWS): string[] {
  const remote = remoteOf(cwd ?? root);
  if (remote) {
    if (written.startsWith("/")) return [workspacePath(remote, written)];
    const folders = [...new Set([cwd, root])].filter((d): d is string => !!d && !!remoteOf(d));
    return folders.map((d) => workspacePath(remote, `${linuxPath(remote, d).replace(/\/+$/, "")}/${written.replace(/^\.\//, "")}`));
  }
  if (/^[A-Za-z]:[\\/]/.test(written) || written.startsWith("\\\\")) return [written];
  if (written.startsWith("/")) {
    // Git Bash on Windows writes `/c/Users/...`.
    const msys = /^\/([A-Za-z])(\/.*)?$/.exec(written);
    if (windows) return msys ? [`${msys[1].toUpperCase()}:${msys[2] ?? "/"}`] : [];
    return [written];
  }
  const relative = written.replace(/^\.[\\/]/, "");
  return [...new Set([cwd, root].filter((d): d is string => !!d))].map((d) => joinPath(d, relative));
}
