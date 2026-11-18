import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { COMMANDS, recentCommands, runCommand, type Command } from "../commands";
import { fsApi } from "../lib/ipc";
import { track } from "../state/activity";
import { basename, joinPath } from "../lib/paths";
import { useWorkspace } from "../state/workspace";
import { FileIcon } from "./FileIcon";

const INPUT_ID = "file-search";
const MAX_RESULTS = 50;

/** Focuses the title bar file search (Ctrl+Shift+N, like IntelliJ's "Go to File"). */
export function focusFileSearch() {
  document.getElementById(INPUT_ID)?.focus();
}

let showCommands: (() => void) | null = null;

/** Opens the command palette: the file search with a `>` prefix (Ctrl+Shift+P). */
export function focusCommandPalette() {
  showCommands?.();
}

interface CommandMatch {
  command: Command;
  /** Matched positions in `Category: Label`. */
  indices: number[];
  recent: boolean;
}

const commandTitle = (c: Command) => `${c.category}: ${c.label}`;

/** Commands that apply now: recently used first when nothing is typed, otherwise by match. */
function searchCommands(query: string): CommandMatch[] {
  const available = COMMANDS.filter((c) => c.when?.() ?? true);
  const recent = recentCommands();
  if (!query) {
    const rank = (c: Command) => (recent.includes(c.id) ? recent.indexOf(c.id) : recent.length);
    return [...available]
      .sort((a, b) => rank(a) - rank(b))
      .map((command) => ({ command, indices: [], recent: recent.includes(command.id) }));
  }
  return available
    .flatMap((command) => {
      const match = fuzzyMatch(query, commandTitle(command));
      return match ? [{ command, indices: match.indices, recent: recent.includes(command.id), score: match.score }] : [];
    })
    .sort((a, b) => b.score - a.score);
}

interface Match {
  relative: string;
  name: string;
  dir: string;
  score: number;
  /** Matched character positions within `name`, or within `relative` for path queries. */
  indices: number[];
}

/** Case-insensitive fuzzy match favouring substrings, prefixes and word starts. */
function fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const substring = t.indexOf(q);
  if (substring >= 0) {
    return {
      score: 100 + (substring === 0 ? 50 : 0) - t.length * 0.1,
      indices: Array.from({ length: q.length }, (_, i) => substring + i),
    };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\\/._\-\s]/.test(t[i - 1]) || target[i] !== t[i];
    const consecutive = indices.length > 0 && i === indices[indices.length - 1] + 1;
    score += (consecutive ? 5 : 1) + (wordStart ? 3 : 0);
    indices.push(i);
    from = i + 1;
  }
  return { score: score - t.length * 0.1, indices };
}

function search(files: string[], query: string): Match[] {
  const byPath = /[\\/]/.test(query);
  const matches: Match[] = [];
  for (const relative of files) {
    const name = basename(relative);
    const match = fuzzyMatch(query, byPath ? relative : name);
    if (!match) continue;
    matches.push({
      relative,
      name,
      dir: relative.slice(0, relative.length - name.length).replace(/[\\/]$/, ""),
      ...match,
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.relative.length - b.relative.length)
    .slice(0, MAX_RESULTS);
}

function Highlighted({ text, indices, offset = 0 }: { text: string; indices: Set<number>; offset?: number }) {
  return (
    <>
      {[...text].map((ch, i) =>
        indices.has(i + offset) ? (
          <span key={i} className="font-semibold text-accent-hover">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

export function FileSearch() {
  const root = useWorkspace((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-index on every focus so new files show up; the list is cheap to build.
  const index = () => {
    if (!root) return;
    void track("Indexing files…", () => fsApi.listProjectFiles(root)).then(setFiles, () => setFiles([]));
  };

  useEffect(() => {
    setFiles(null);
    setQuery("");
  }, [root]);

  useEffect(() => {
    showCommands = () => {
      setQuery(">");
      setOpen(true);
      inputRef.current?.focus();
    };
    return () => {
      showCommands = null;
    };
  }, []);

  /** A leading `>` turns the file search into the command palette, as in VS Code. */
  const commandMode = query.startsWith(">");
  const commands = useMemo(
    () => (commandMode ? searchCommands(query.slice(1).trim()) : []),
    // Recomputed when opened, as availability depends on the app's state.
    [commandMode, query, open],
  );

  const results = useMemo(
    () => (!commandMode && files && query.trim() ? search(files, query.trim()) : []),
    [commandMode, files, query],
  );
  const count = commandMode ? commands.length : results.length;

  useEffect(() => setSelected(0), [results, commands]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const dismiss = () => {
    setOpen(false);
    setQuery("");
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const choose = (match: Match | undefined) => {
    if (!match || !root) return;
    openFile(joinPath(root, match.relative));
    dismiss();
  };

  /** Runs a command once the palette is closed, so commands that move focus keep it. */
  const execute = (match: CommandMatch | undefined) => {
    if (!match) return;
    dismiss();
    void runCommand(match.command);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        setSelected((i) => Math.min(count - 1, i + 1));
        break;
      case "ArrowUp":
        setSelected((i) => Math.max(0, i - 1));
        break;
      case "Enter":
        if (commandMode) execute(commands[selected]);
        else choose(results[selected]);
        break;
      case "Escape":
        setOpen(false);
        e.currentTarget.blur();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const byPath = /[\\/]/.test(query);

  return (
    <div className="relative w-[min(480px,40vw)]">
      <div className="flex h-7 items-center gap-2 rounded-md border border-input-border bg-input px-2 focus-within:border-accent">
        <Search size={14} className="shrink-0 text-fg-muted" />
        <input
          ref={inputRef}
          id={INPUT_ID}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            index();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={
            root
              ? `Search files by name at ${basename(root)}  (> for commands)`
              : "Type > for commands, or open a folder to search files"
          }
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
        />
        {open && query && !commandMode && root && files === null ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />
        ) : (
          <span className="shrink-0 text-xs text-fg-subtle">{commandMode ? "Ctrl+Shift+P" : "Ctrl+Shift+N"}</span>
        )}
      </div>

      {open && commandMode && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[420px] overflow-y-auto rounded-lg border border-line-soft bg-panel p-1 shadow-xl shadow-black/40"
        >
          {commands.length === 0 && <div className="px-2.5 py-1.5 text-fg-muted">No matching commands</div>}
          {commands.map((match, i) => (
            <div
              key={match.command.id}
              data-index={i}
              role="option"
              aria-selected={i === selected}
              onMouseMove={() => setSelected(i)}
              onClick={() => execute(match)}
              className={`flex h-7 cursor-default items-center gap-2 rounded px-2.5 whitespace-nowrap ${
                i === selected ? "bg-selected" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate">
                <Highlighted text={commandTitle(match.command)} indices={new Set(match.indices)} />
              </span>
              {match.recent && <span className="shrink-0 text-xs text-fg-subtle">recently used</span>}
              {match.command.shortcut && (
                <span className="shrink-0 text-xs text-fg-muted">{match.command.shortcut}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {open && !commandMode && query.trim() && !root && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border border-line-soft bg-panel px-3 py-2 text-fg-muted shadow-xl shadow-black/40">
          Open a folder to search files, or type <span className="font-code text-fg">&gt;</span> for commands.
        </div>
      )}

      {open && !commandMode && query.trim() && files !== null && (
        <div
          ref={listRef}
          role="listbox"
          // Keep focus in the input while clicking a result.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[420px] overflow-y-auto rounded-lg border border-line-soft bg-panel p-1 shadow-xl shadow-black/40"
        >
          {results.length === 0 && <div className="px-2.5 py-1.5 text-fg-muted">No matching files</div>}
          {results.map((match, i) => {
            const indices = new Set(match.indices);
            const nameOffset = byPath ? match.relative.length - match.name.length : 0;
            return (
              <div
                key={match.relative}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => setSelected(i)}
                onClick={() => choose(match)}
                className={`flex h-7 cursor-default items-center gap-2 rounded px-2.5 whitespace-nowrap ${
                  i === selected ? "bg-selected" : ""
                }`}
              >
                <FileIcon name={match.name} />
                <span className="shrink-0">
                  <Highlighted text={match.name} indices={indices} offset={nameOffset} />
                </span>
                <span className="min-w-0 truncate text-fg-subtle">
                  {byPath ? <Highlighted text={match.dir} indices={indices} /> : match.dir}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
