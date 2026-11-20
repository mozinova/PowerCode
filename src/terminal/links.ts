//! Links in the terminal, as in VS Code's: URLs and file paths (with an optional
//! `:line:column` or `(line,column)`) are underlined under the mouse and open on
//! Ctrl+Click (Cmd+Click on macOS): URLs in the browser, files in the editor at
//! their line. A path counts only if it exists, resolved from the terminal's folder
//! (or the open project), on the terminal's machine for SSH and WSL.

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { openEditor } from "../actions";
import { fsApi } from "../lib/ipc";
import { remoteOf } from "../lib/remote";
import { findLinks, resolveCandidates } from "./linkMatching";
import { useWorkspace } from "../state/workspace";

const IS_MAC = navigator.userAgent.includes("Mac");
const IS_WINDOWS = navigator.userAgent.includes("Windows");

const EXISTS_TTL_MS = 10_000;

/** Whether a path exists, by full path, remembered a little while. */
const existsCache = new Map<string, { exists: boolean; at: number }>();

async function existing(paths: string[]): Promise<Set<string>> {
  const now = Date.now();
  const unknown = [...new Set(paths)].filter((p) => {
    const cached = existsCache.get(p);
    return !cached || now - cached.at > EXISTS_TTL_MS;
  });
  if (unknown.length) {
    const signatures = await fsApi.signatures(unknown).catch(() => unknown.map(() => null));
    unknown.forEach((p, i) => existsCache.set(p, { exists: signatures[i] !== null, at: now }));
  }
  return new Set(paths.filter((p) => existsCache.get(p)?.exists));
}

/** The logical line (wrapped rows joined) around buffer row `y` (0-based), with its first row. */
function logicalLine(term: Terminal, y: number): { text: string; first: number } | null {
  const buffer = term.buffer.active;
  let first = y;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = "";
  for (let row = first; row <= last; row++) {
    const line: IBufferLine | undefined = buffer.getLine(row);
    if (!line) return null;
    // Wrapped rows are full: keep their width so offsets map back to cells.
    text += line.translateToString(row !== last);
  }
  return { text, first };
}

function activateWithModifier(event: MouseEvent) {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

async function openPath(path: string, line?: number, column?: number) {
  // A folder lists; a file does not. Folders show in the system's file manager.
  const isFolder = await fsApi.listDir(path).then(() => true, () => false);
  if (isFolder) {
    if (!remoteOf(path)) void revealItemInDir(path).catch(() => {});
    return;
  }
  if (line) useWorkspace.getState().openFileAt(path, line, column ?? 1, column ?? 1);
  else openEditor(path);
}

export function openTerminalUrl(url: string) {
  if (/^file:\/\//i.test(url)) {
    const path = decodeURIComponent(url.replace(/^file:\/\/\/?/i, IS_WINDOWS ? "" : "/"));
    void openPath(IS_WINDOWS ? path.replace(/\//g, "\\") : path);
  } else {
    void openUrl(url).catch(() => {});
  }
}

const HOVER = IS_MAC ? "Follow link (cmd + click)" : "Follow link (ctrl + click)";

/** Underlines and opens the links of `term`, whose shell started in `cwd`. */
export function linkProvider(term: Terminal, cwd: () => string | null): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = logicalLine(term, y - 1);
      if (!line) return callback(undefined);
      const found = findLinks(line.text);
      if (!found.length) return callback(undefined);
      const cols = term.cols;
      const root = useWorkspace.getState().root;
      const candidates = new Map(found.map((f) => [f, f.kind === "path" ? resolveCandidates(f.target, cwd(), root) : []]));
      void existing([...candidates.values()].flat()).then((exists) => {
        const links: ILink[] = [];
        for (const f of found) {
          const path = candidates.get(f)!.find((p) => exists.has(p));
          if (f.kind === "path" && !path) continue;
          const startRow = line.first + Math.floor(f.start / cols);
          const end = f.start + f.length - 1;
          const range = {
            start: { x: (f.start % cols) + 1, y: startRow + 1 },
            end: { x: (end % cols) + 1, y: line.first + Math.floor(end / cols) + 1 },
          };
          // Only links on the hovered row: xterm asks for each row it shows.
          if (range.start.y > y || range.end.y < y) continue;
          links.push({
            range,
            text: line.text.slice(f.start, f.start + f.length),
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              if (!activateWithModifier(event)) return;
              if (f.kind === "url") openTerminalUrl(f.target);
              else void openPath(path!, f.line, f.column);
            },
            hover: (event) => {
              (event.target as HTMLElement | null)?.setAttribute?.("title", HOVER);
            },
            leave: (event) => {
              (event.target as HTMLElement | null)?.removeAttribute?.("title");
            },
          });
        }
        callback(links.length ? links : undefined);
      });
    },
  };
}
