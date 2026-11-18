import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ListFilter,
  Loader2,
  Minus,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  WholeWord,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, searchApi, type FileMatches, type LineMatch, type SearchOptions } from "../lib/ipc";
import { basename, parentDir } from "../lib/paths";
import { ask } from "@tauri-apps/plugin-dialog";
import { refreshGit } from "../git/store";
import { replaceInFile, replaceMatch, replacedText } from "../search/replace";
import { track } from "../state/activity";
import { notify, withProgress } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";

const INPUT_ID = "find-in-files";
const DEBOUNCE_MS = 300;
/** Matches listed per file before "N more"; the rest are reachable from the file. */
const MATCHES_SHOWN = 100;

/** Opens Find in Files and focuses its query (Ctrl+Shift+F). */
export function focusFindInFiles() {
  useWorkspace.getState().setLeftTool("search");
  requestAnimationFrame(() => {
    const input = document.getElementById(INPUT_ID) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  });
}

function Toggle({
  icon: Icon,
  title,
  active,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex size-6 shrink-0 items-center justify-center rounded ${
        active ? "bg-accent/30 text-fg ring-1 ring-accent" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      <Icon size={15} />
    </button>
  );
}

/** A small action shown on hover at the end of a result row. */
function RowButton({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="hidden size-5 shrink-0 items-center justify-center rounded font-ui text-fg-muted group-hover:flex hover:bg-hover hover:text-fg"
    >
      <Icon size={13} />
    </button>
  );
}

/** The replace text and how to apply it, when the replace field is open. */
interface ReplaceMode {
  text: string;
  options: Pick<SearchOptions, "query" | "caseSensitive" | "wholeWord" | "regex">;
  replaceFile: (file: FileMatches) => void;
  replaceMatch: (file: FileMatches, match: LineMatch) => void;
}

function Preview({ match, replace }: { match: LineMatch; replace: ReplaceMode | null }) {
  const parts: ReactNode[] = [];
  let at = 0;
  match.ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(match.preview.slice(at, start));
    const found = match.preview.slice(start, end);
    if (replace) {
      // As in VS Code: the match struck through, followed by what replaces it.
      parts.push(
        <del key={i} className="rounded-sm bg-[#6b2e2e] text-fg">
          {found}
        </del>,
        <ins key={`${i}+`} className="rounded-sm bg-[#2f5a35] text-fg no-underline">
          {replacedText(replace.options, found, replace.text)}
        </ins>,
      );
    } else {
      parts.push(
        <mark key={i} className="rounded-sm bg-[#6d5a2b] text-fg">
          {found}
        </mark>,
      );
    }
    at = end;
  });
  parts.push(match.preview.slice(at));
  return <span className="min-w-0 flex-1 truncate">{parts}</span>;
}

function FileResult({
  file,
  collapsed,
  onToggle,
  replace,
}: {
  file: FileMatches;
  collapsed: boolean;
  onToggle: () => void;
  replace: ReplaceMode | null;
}) {
  const openFileAt = useWorkspace((s) => s.openFileAt);
  const name = basename(file.path);
  const dir = parentDir(file.relative);
  const shown = file.matches.slice(0, MATCHES_SHOWN);
  return (
    <div role="group">
      <div
        onClick={onToggle}
        {...tooltipProps(file.path)}
        className="group mx-1 flex h-7 cursor-default items-center gap-1.5 rounded pr-2 pl-1 hover:bg-hover/50"
      >
        {collapsed ? <ChevronRight size={15} className="shrink-0 text-fg-muted" /> : <ChevronDown size={15} className="shrink-0 text-fg-muted" />}
        <FileIcon name={name} size={16} />
        <span className="shrink-0">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{dir !== file.relative ? dir : ""}</span>
        {replace && (
          <RowButton icon={ReplaceAll} title="Replace All in File" onClick={() => replace.replaceFile(file)} />
        )}
        <span className="shrink-0 rounded-full bg-hover px-1.5 text-xs text-fg-muted">{file.matches.length}</span>
      </div>
      {!collapsed &&
        shown.map((match) => (
          <div
            key={match.line}
            onClick={() => openFileAt(file.path, match.line, match.column, match.endColumn)}
            className="group mx-1 flex h-6 cursor-default items-center gap-2 rounded pr-2 pl-8 font-code text-[12px] whitespace-pre hover:bg-hover/50"
          >
            <span className="w-8 shrink-0 text-right text-fg-subtle">{match.line}</span>
            <Preview match={match} replace={replace} />
            {replace && <RowButton icon={Replace} title="Replace" onClick={() => replace.replaceMatch(file, match)} />}
          </div>
        ))}
      {!collapsed && file.matches.length > shown.length && (
        <div className="pl-[4.5rem] text-xs text-fg-subtle">{file.matches.length - shown.length} more…</div>
      )}
    </div>
  );
}

export function SearchView() {
  const root = useWorkspace((s) => s.root);
  const toggleLeftTool = useWorkspace((s) => s.toggleLeftTool);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [results, setResults] = useState<FileMatches[]>([]);
  const [summary, setSummary] = useState<{ files: number; matches: number; truncated: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  /** Bumped after replacing, to search again with the files' new content. */
  const [rerun, setRerun] = useState(0);
  const searchId = useRef(0);

  const afterReplace = (count: number, files: number) => {
    notify("success", `Replaced ${count} ${count === 1 ? "occurrence" : "occurrences"}`, files > 1 ? `in ${files} files` : undefined);
    setRerun((n) => n + 1);
    void refreshGit();
  };
  const replaceOptions = { query, caseSensitive, wholeWord, regex };
  const replace: ReplaceMode | null = showReplace
    ? {
        text: replacement,
        options: replaceOptions,
        replaceFile: (file) =>
          void withProgress("Replace", () => replaceInFile(file.path, replaceOptions, replacement)).then(
            (count) => count !== undefined && afterReplace(count, 1),
          ),
        replaceMatch: (file, match) =>
          void withProgress("Replace", () =>
            replaceMatch(file.path, match.line, match.column, replaceOptions, replacement),
          ).then((done) => done !== undefined && afterReplace(1, 1)),
      }
    : null;

  const replaceAll = async () => {
    if (!summary || summary.matches === 0) return;
    const ok = await ask(
      `Replace ${summary.matches} ${summary.matches === 1 ? "occurrence" : "occurrences"} across ${summary.files} ${summary.files === 1 ? "file" : "files"} with "${replacement}"?`,
      { title: "Replace All", kind: "warning", okLabel: "Replace", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    const counts = await withProgress("Replace all", () =>
      Promise.all(results.map((file) => replaceInFile(file.path, replaceOptions, replacement))),
    );
    if (counts) afterReplace(counts.reduce((a, b) => a + b, 0), counts.filter((c) => c > 0).length);
  };

  useEffect(() => {
    const id = ++searchId.current;
    setResults([]);
    setSummary(null);
    setError(null);
    setCollapsed(new Set());
    if (!root || !query) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const options: SearchOptions = { query, caseSensitive, wholeWord, regex, include, exclude };
    const timer = window.setTimeout(() => {
      track("Searching in files…", () =>
        searchApi.search(root, options, (event) => {
          // Events of a superseded search may still arrive; drop them.
          if (id !== searchId.current) return;
          if (event.event === "file") {
            setResults((previous) => [...previous, event.data].sort((a, b) => a.relative.localeCompare(b.relative)));
          } else {
            setSummary(event.data);
            setSearching(false);
          }
        }),
      ).catch((e) => {
          if (id !== searchId.current) return;
          setError(errorMessage(e));
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [root, query, caseSensitive, wholeWord, regex, include, exclude, rerun]);

  const toggleFile = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Find in Files">
        <IconButton
          icon={ChevronsDownUp}
          title="Collapse All"
          onClick={() => setCollapsed(new Set(results.map((r) => r.path)))}
          className="size-7"
        />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleLeftTool("search")} className="size-7" />
      </ToolWindowHeader>

      <div className="flex gap-1 pr-3 pl-1 pb-2">
        {/* As in VS Code, the chevron beside the fields shows the replace field. */}
        <button
          type="button"
          {...tooltipProps(showReplace ? "Hide Replace" : "Show Replace")}
          aria-label="Toggle Replace"
          aria-expanded={showReplace}
          onClick={() => setShowReplace(!showReplace)}
          className="flex w-5 shrink-0 items-start justify-center rounded pt-1.5 text-fg-muted hover:bg-hover hover:text-fg"
        >
          {showReplace ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div
            className={`flex items-center gap-1 rounded-md border bg-input pr-1 pl-2 ${
              error ? "border-danger" : "border-input-border focus-within:border-accent"
            }`}
          >
            <Search size={14} className="shrink-0 text-fg-muted" />
            <input
              id={INPUT_ID}
              value={query}
              disabled={!root}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={root ? "Search in files" : "Open a folder to search"}
              spellCheck={false}
              autoComplete="off"
              className="h-7 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
            />
            <Toggle icon={CaseSensitive} title="Match Case" active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} />
            <Toggle icon={WholeWord} title="Words" active={wholeWord} onClick={() => setWholeWord(!wholeWord)} />
            <Toggle icon={Regex} title="Regex" active={regex} onClick={() => setRegex(!regex)} />
            <Toggle icon={ListFilter} title="File Filters" active={showFilters} onClick={() => setShowFilters(!showFilters)} />
          </div>
          {showReplace && (
            <div className="flex items-center gap-1 rounded-md border border-input-border bg-input pr-1 pl-2 focus-within:border-accent">
              <Replace size={14} className="shrink-0 text-fg-muted" />
              <input
                value={replacement}
                disabled={!root}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void replaceAll();
                }}
                placeholder={regex ? "Replace ($1 for groups)" : "Replace"}
                spellCheck={false}
                autoComplete="off"
                className="h-7 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
              />
              <button
                type="button"
                {...tooltipProps("Replace All", "Ctrl+Enter")}
                aria-label="Replace All"
                disabled={!summary || summary.matches === 0}
                onClick={() => void replaceAll()}
                className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ReplaceAll size={15} />
              </button>
            </div>
          )}
          {showFilters && (
            <>
              <input
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder="Files to include, e.g. *.ts, src/"
                spellCheck={false}
                className="h-7 rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
              />
              <input
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder="Files to exclude, e.g. *.min.js, dist/"
                spellCheck={false}
                className="h-7 rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
              />
            </>
          )}
          <div className="flex h-4 items-center gap-1.5 text-xs text-fg-subtle">
            {searching && <Loader2 size={12} className="animate-spin" />}
            {error ? (
              <span className="text-danger">{error}</span>
            ) : summary ? (
              <span>
                {summary.matches === 0
                  ? "No results"
                  : `${summary.matches} ${summary.matches === 1 ? "result" : "results"} in ${summary.files} ${summary.files === 1 ? "file" : "files"}`}
                {summary.truncated && " (limit reached, refine the search)"}
              </span>
            ) : searching ? (
              <span>Searching…</span>
            ) : null}
          </div>
        </div>
      </div>

      <div role="tree" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {results.map((file) => (
          <FileResult
            key={file.path}
            file={file}
            collapsed={collapsed.has(file.path)}
            onToggle={() => toggleFile(file.path)}
            replace={replace}
          />
        ))}
      </div>
    </div>
  );
}
