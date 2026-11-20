import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { openEditor } from "../actions";
import { allCommands, recentCommands, runCommand, type Command } from "../commands";
import { fsApi } from "../lib/ipc";
import { track } from "../state/activity";
import { basename, isWithin, joinPath } from "../lib/paths";
import { hasWorkspaceSymbolProviders, searchWorkspaceSymbols, type WorkspaceSymbol } from "../exthost/languages";

/** `path` relative to the project folder, when inside it. */
const relativePath = (path: string, root: string) => (isWithin(path, root) && path !== root ? path.slice(root.length + 1) : path);
import { useWorkspace } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { fuzzyMatch, searchFiles, type FileMatch } from "../search/fileMatch";

const INPUT_ID = "file-search";
const MAX_RESULTS = 50;

/** Focuses the title bar file search (Ctrl+Shift+N, like IntelliJ's "Go to File"). */
export function focusFileSearch() {
  document.getElementById(INPUT_ID)?.focus();
}

let showWithPrefix: ((prefix: string) => void) | null = null;

/** Opens the command palette: the file search with a `>` prefix (Ctrl+Shift+P). */
export function focusCommandPalette() {
  showWithPrefix?.(">");
}

/** Go to Symbol in Workspace: the file search with a `#` prefix (Ctrl+T). */
export function focusSymbolSearch() {
  showWithPrefix?.("#");
}

/** `vscode.SymbolKind` names, by value. */
const SYMBOL_KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum",
  "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key",
  "null", "enum member", "struct", "event", "operator", "type parameter",
];

const SYMBOL_DELAY_MS = 200;

interface CommandMatch {
  command: Command;
  /** Matched positions in `Category: Label`. */
  indices: number[];
  recent: boolean;
}

const commandTitle = (c: Command) => `${c.category}: ${c.label}`;

/** Commands that apply now: recently used first when nothing is typed, otherwise by match. */
function searchCommands(query: string): CommandMatch[] {
  const available = allCommands().filter((c) => c.when?.() ?? true);
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

/** The file index is rebuilt on focus when older than this (or after file changes). */
const INDEX_MAX_AGE_MS = 30_000;

export function FileSearch() {
  const root = useWorkspace((s) => s.root);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fsVersion = useWorkspace((s) => s.fsVersion);
  /** When the shown index was built, and for which folder and file system version. */
  const indexed = useRef<{ root: string; fsVersion: number; at: number } | null>(null);

  // On focus the index is reused while fresh: building it walks the whole project,
  // which takes seconds in WSL and SSH folders. It is rebuilt in the background
  // (the previous list stays usable) when stale or after files were created,
  // renamed or deleted (`fsVersion`).
  const index = () => {
    if (!root) return;
    const last = indexed.current;
    const fresh = last && last.root === root && last.fsVersion === fsVersion && Date.now() - last.at < INDEX_MAX_AGE_MS;
    if (fresh) return;
    indexed.current = { root, fsVersion, at: Date.now() };
    const label = files === null ? "Indexing files…" : "Updating file index…";
    void track(label, () => fsApi.listProjectFiles(root)).then(
      (list) => useWorkspace.getState().root === root && setFiles(list),
      () => {
        if (useWorkspace.getState().root !== root) return;
        indexed.current = null;
        setFiles((current) => current ?? []);
      },
    );
  };

  useEffect(() => {
    setFiles(null);
    setQuery("");
    indexed.current = null;
  }, [root]);

  useEffect(() => {
    showWithPrefix = (prefix) => {
      setQuery(prefix);
      setOpen(true);
      inputRef.current?.focus();
    };
    return () => {
      showWithPrefix = null;
    };
  }, []);

  /** A leading `>` turns the file search into the command palette, as in VS Code. */
  const commandMode = query.startsWith(">");
  /** A leading `#` searches symbols in the workspace (from extensions' language servers). */
  const symbolMode = query.startsWith("#");
  const commands = useMemo(
    () => (commandMode ? searchCommands(query.slice(1).trim()) : []),
    // Recomputed when opened, as availability depends on the app's state.
    [commandMode, query, open],
  );

  // Symbols come from the extension host, so they are fetched (debounced) rather than computed.
  const [symbols, setSymbols] = useState<WorkspaceSymbol[] | null>([]);
  useEffect(() => {
    const term = query.slice(1).trim();
    if (!symbolMode || !term) {
      setSymbols([]);
      return;
    }
    setSymbols(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchWorkspaceSymbols(term).then((list) => !cancelled && setSymbols(list.slice(0, MAX_RESULTS)));
    }, SYMBOL_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [symbolMode, query]);

  const results = useMemo(
    () => (!commandMode && !symbolMode && files && query.trim() ? searchFiles(files, query.trim()) : []),
    [commandMode, symbolMode, files, query],
  );
  const count = commandMode ? commands.length : symbolMode ? (symbols?.length ?? 0) : results.length;

  useEffect(() => setSelected(0), [results, commands, symbols]);

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

  const choose = (match: FileMatch | undefined) => {
    if (!match || !root) return;
    openEditor(joinPath(root, match.relative));
    dismiss();
  };

  const chooseSymbol = (symbol: WorkspaceSymbol | undefined) => {
    if (!symbol) return;
    const { openFile, openFileAt } = useWorkspace.getState();
    const r = symbol.range;
    if (r) openFileAt(symbol.path, r.start.line + 1, r.start.character + 1, r.start.character + 1);
    else openFile(symbol.path);
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
        else if (symbolMode) chooseSymbol(symbols?.[selected]);
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
              ? `Search files by name at ${basename(root)}  (> commands, # symbols)`
              : "Type > for commands, or open a folder to search files"
          }
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
        />
        {open && query && !commandMode && root && (symbolMode ? symbols === null : files === null) ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />
        ) : (
          <span className="shrink-0 text-xs text-fg-subtle">{commandMode ? "Ctrl+Shift+P" : symbolMode ? "Ctrl+T" : "Ctrl+Shift+N"}</span>
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

      {open && symbolMode && root && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Symbols"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-[420px] overflow-y-auto rounded-lg border border-line-soft bg-panel p-1 shadow-xl shadow-black/40"
        >
          {!query.slice(1).trim() && (
            <div className="px-2.5 py-1.5 text-fg-muted">
              {hasWorkspaceSymbolProviders()
                ? "Type a symbol name (class, function, …)"
                : "No extension provides workspace symbols for this project yet."}
            </div>
          )}
          {query.slice(1).trim() && symbols?.length === 0 && <div className="px-2.5 py-1.5 text-fg-muted">No matching symbols</div>}
          {(symbols ?? []).map((symbol, i) => {
            const term = query.slice(1).trim();
            const indices = new Set(fuzzyMatch(term, symbol.name)?.indices ?? []);
            const where = relativePath(symbol.path, root);
            return (
              <div
                key={`${symbol.path}:${symbol.range?.start.line ?? 0}:${symbol.name}:${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => setSelected(i)}
                onClick={() => chooseSymbol(symbol)}
                className={`flex h-7 cursor-default items-center gap-2 rounded px-2.5 whitespace-nowrap ${
                  i === selected ? "bg-selected" : ""
                }`}
              >
                <span className="w-16 shrink-0 truncate text-xs text-fg-subtle">{SYMBOL_KINDS[symbol.kind] ?? "symbol"}</span>
                <span className="shrink-0">
                  <Highlighted text={symbol.name} indices={indices} />
                </span>
                {symbol.containerName && <span className="shrink-0 text-fg-muted">{symbol.containerName}</span>}
                <span className="min-w-0 truncate text-fg-subtle">{where}</span>
              </div>
            );
          })}
        </div>
      )}

      {open && !commandMode && query.trim() && !root && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border border-line-soft bg-panel px-3 py-2 text-fg-muted shadow-xl shadow-black/40">
          Open a folder to search files, or type <span className="font-code text-fg">&gt;</span> for commands.
        </div>
      )}

      {open && !commandMode && !symbolMode && query.trim() && files !== null && (
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
