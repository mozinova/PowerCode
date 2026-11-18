import { ArrowUp, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { openFolder, openLocalFolder } from "../actions";
import { errorMessage, fsApi, type DirEntry } from "../lib/ipc";
import { linuxParent, linuxPath, remoteLabel, workspacePath, type RemoteTarget } from "../lib/remote";
import { closeFolderPicker, useFolderPicker } from "../state/folderPicker";
import { FileIcon } from "./FileIcon";

const close = closeFolderPicker;
const LOAD_DELAY_MS = 120;

/**
 * VS Code's remote "Open Folder": browses folders on the WSL distribution or
 * SSH host, since the native dialog only shows this machine's folders.
 */
export function RemoteFolderPicker() {
  const request = useFolderPicker((s) => s.request);
  return request ? <Picker key={request.start} target={request.target} start={request.start} /> : null;
}

/** Splits a typed path into the folder being listed and the partial name after it. */
function splitInput(input: string): { dir: string; partial: string } {
  if (input.endsWith("/")) return { dir: input.length > 1 ? input.slice(0, -1) : "/", partial: "" };
  const slash = input.lastIndexOf("/");
  return { dir: slash <= 0 ? "/" : input.slice(0, slash), partial: input.slice(slash + 1) };
}

const joinLinux = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

function Picker({ target, start }: { target: RemoteTarget; start: string }) {
  const startDir = linuxPath(target, start);
  const [input, setInput] = useState(startDir === "/" ? "/" : `${startDir}/`);
  /** Listings by Linux folder; a string is the error listing it gave. */
  const [listings, setListings] = useState<Map<string, DirEntry[] | string>>(new Map());
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const { dir, partial } = splitInput(input);
  const listing = listings.get(dir);

  // List the folder being typed in, once typing pauses; listings are cached.
  useEffect(() => {
    if (listings.has(dir)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fsApi.listDir(workspacePath(target, dir)).then(
        (entries) => !cancelled && setListings((m) => new Map(m).set(dir, entries)),
        (e) => !cancelled && setListings((m) => new Map(m).set(dir, errorMessage(e))),
      );
    }, LOAD_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [target, dir, listings]);

  /** Entries matching the partial name: folders first, then files (shown, not selectable). */
  const items = useMemo(() => {
    if (!Array.isArray(listing)) return [];
    const prefix = partial.toLowerCase();
    return listing.filter((e) => e.name.toLowerCase().startsWith(prefix));
  }, [listing, partial]);
  const folders = items.filter((e) => e.isDir);

  useEffect(() => setHighlight(-1), [dir, partial]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const enter = (folder: DirEntry) => {
    setInput(`${joinLinux(dir, folder.name)}/`);
    setError(null);
  };

  /** The folder the Open button would open: the typed path, without a trailing slash. */
  const typedFolder = input.length > 1 ? input.replace(/\/+$/, "") : "/";

  const openTyped = async () => {
    if (!typedFolder.startsWith("/")) return setError("Enter an absolute path, starting with /.");
    setOpening(true);
    try {
      const path = workspacePath(target, typedFolder);
      // Fails with a clear message if it is not a folder.
      await fsApi.listDir(path);
      await openFolder(path);
      close();
    } catch (e) {
      setError(errorMessage(e));
      setOpening(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        setHighlight((i) => Math.min(folders.length - 1, i + 1));
        break;
      case "ArrowUp":
        setHighlight((i) => Math.max(-1, i - 1));
        break;
      case "Tab": {
        // Complete to the highlighted folder, or the only one that matches.
        const completion = folders[highlight] ?? (folders.length === 1 ? folders[0] : undefined);
        if (!completion) return e.preventDefault();
        enter(completion);
        break;
      }
      case "Enter":
        if (folders[highlight]) enter(folders[highlight]);
        else void openTyped();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-label={`Open Folder on ${remoteLabel(target)}`}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="flex h-fit w-[520px] flex-col gap-2 rounded-lg border border-line-soft bg-panel p-3 shadow-2xl shadow-black/50"
      >
        <div className="font-semibold">Open Folder on {remoteLabel(target)}</div>
        <div className="flex gap-1.5">
          <button
            type="button"
            aria-label="Parent Folder"
            disabled={typedFolder === "/"}
            onClick={() => {
              const parent = linuxParent(typedFolder);
              setInput(parent === "/" ? "/" : `${parent}/`);
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-input-border text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <ArrowUp size={15} />
          </button>
          <input
            autoFocus
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="remote-folder-items"
            aria-autocomplete="list"
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded-md border border-input-border bg-input px-2 font-code text-[12px] text-fg outline-none focus:border-accent"
          />
        </div>

        <div
          ref={listRef}
          id="remote-folder-items"
          role="listbox"
          aria-label={`Items in ${dir}`}
          className="h-72 overflow-y-auto rounded-md border border-line-soft bg-editor py-1"
        >
          {listing === undefined && <Loader2 size={15} className="m-2 animate-spin text-fg-muted" />}
          {typeof listing === "string" && <p className="px-2.5 py-1.5 text-xs text-danger">{listing}</p>}
          {Array.isArray(listing) && items.length === 0 && (
            <p className="px-2.5 py-1.5 text-xs text-fg-muted">
              {partial ? `Nothing in ${dir} starts with "${partial}".` : "This folder is empty."}
            </p>
          )}
          {items.map((item) => {
            const index = folders.indexOf(item);
            const selected = item.isDir && index === highlight;
            return (
              <div
                key={item.path}
                data-index={item.isDir ? index : undefined}
                role="option"
                aria-selected={selected}
                aria-disabled={!item.isDir}
                onClick={() => item.isDir && enter(item)}
                onMouseMove={() => item.isDir && setHighlight(index)}
                className={`mx-1 flex h-7 cursor-default items-center gap-2 rounded px-2 ${
                  item.isDir ? (selected ? "bg-selected" : "hover:bg-hover/60") : "opacity-50"
                }`}
              >
                <FileIcon name={item.name} isDir={item.isDir} size={15} />
                <span className="truncate">
                  {/* The typed prefix is highlighted, as in an autocomplete list. */}
                  <span className="font-semibold text-accent-hover">{item.name.slice(0, partial.length)}</span>
                  {item.name.slice(partial.length)}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-xs text-fg-subtle">
          <span>Tab to complete · Enter to open a folder</span>
          {error && <span className="min-w-0 flex-1 truncate text-danger">{error}</span>}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              close();
              void openLocalFolder();
            }}
            className="h-7 rounded-md px-2 text-[#548af7] hover:underline"
          >
            Show Local…
          </button>
          <div className="flex-1" />
          <button type="button" onClick={close} className="h-7 rounded-md border border-input-border px-3 hover:bg-hover">
            Cancel
          </button>
          <button
            type="button"
            disabled={opening}
            onClick={() => void openTyped()}
            className="h-7 rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
