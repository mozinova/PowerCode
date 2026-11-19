import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Copy,
  ExternalLink,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Minus,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createEntry, deleteEntry, openEditor, openFolder, openTerminalAt, renameEntry } from "../actions";
import { errorMessage, fsApi, type DirEntry } from "../lib/ipc";
import { basename, isWithin, joinPath, movedPath, parentDir } from "../lib/paths";
import { REVEAL_LABEL } from "../lib/platform";
import { isSshPath } from "../lib/remote";
import { GIT_COLORS, gitStateOf, useGit } from "../git/store";
import { useWorkspace } from "../state/workspace";
import { savedExplorer, saveExplorer } from "../state/session";
import { watchFolders } from "../editor/externalChanges";
import { FileIcon } from "./FileIcon";
import { ContextMenu, type MenuEntry } from "./Menu";
import { IconButton, ToolWindowHeader } from "./ui";
import { tooltipProps } from "./Tooltip";

interface Row {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
}

const ROW_HEIGHT = 28;
const INDENT = 16;

const INVALID_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** `allowNested` accepts `a/b/c` to create intermediate folders. */
function validateName(value: string, allowNested: boolean): string | null {
  if (!value) return "Name cannot be empty.";
  if (INVALID_NAME_CHARS.test(value)) return 'Name cannot contain < > : " | ? *';
  const parts = value.split(/[\\/]/);
  if (!allowNested && parts.length > 1) return "Name cannot contain / or \\.";
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "Invalid name.";
  return null;
}

function sameEntries(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  return !!a && a.length === b.length && a.every((e, i) => e.path === b[i].path && e.name === b[i].name && e.isDir === b[i].isDir);
}

function useTree(root: string) {
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root]));

  const load = useCallback(async (path: string) => {
    try {
      const entries = await fsApi.listDir(path);
      setChildren((prev) => {
        // Listed again with nothing new (outside changes, Reload from Disk): no re-render.
        if (sameEntries(prev.get(path), entries)) return prev;
        return new Map(prev).set(path, entries);
      });
    } catch {
      // A folder shown already keeps its entries when listing it again fails (a busy
      // remote, a file being written): emptying it would make the tree flash.
      setChildren((prev) => (prev.has(path) ? prev : new Map(prev).set(path, [])));
    }
  }, []);

  // The folders expanded last time come back expanded (see state/session.ts).
  useEffect(() => {
    const saved = savedExplorer(root).expanded.filter((p) => isWithin(p, root));
    setChildren(new Map());
    setExpanded(new Set([root, ...saved]));
    for (const path of [root, ...saved]) void load(path);
  }, [root, load]);

  // Skips the first run per folder: that is the restore above, not a change.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current !== root) {
      restoredFor.current = root;
      return;
    }
    saveExplorer(root, { expanded: [...expanded].filter((p) => p !== root) });
  }, [root, expanded]);

  const toggle = useCallback(
    (path: string, open?: boolean) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        const shouldOpen = open ?? !prev.has(path);
        if (shouldOpen) next.add(path);
        else next.delete(path);
        return next;
      });
      if (open !== false) void load(path);
    },
    [load],
  );

  const refresh = useCallback(() => {
    for (const path of expanded) void load(path);
  }, [expanded, load]);

  const collapseAll = useCallback(() => setExpanded(new Set([root])), [root]);

  /** Keeps expanded folders expanded after `from` was renamed to `to`. */
  const afterRename = useCallback(
    (from: string, to: string) => {
      const next = new Set([...expanded].map((p) => movedPath(p, from, to)));
      setExpanded(next);
      for (const path of next) if (isWithin(path, to)) void load(path);
      void load(parentDir(from));
    },
    [expanded, load],
  );

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (entry: DirEntry, depth: number) => {
      const isOpen = entry.isDir && expanded.has(entry.path);
      result.push({ entry, depth, expanded: isOpen });
      if (isOpen) for (const child of children.get(entry.path) ?? []) visit(child, depth + 1);
    };
    visit({ name: basename(root), path: root, isDir: true }, 0);
    return result;
  }, [root, children, expanded]);

  /** Every expanded folder's entries are loaded: the tree has its full height. */
  const ready = useMemo(() => [...expanded].every((p) => children.has(p)), [expanded, children]);

  // Files added, removed or renamed outside the app (an AI agent, `git`) show up: the
  // folders on screen are checked with the open files (see editor/externalChanges.ts).
  const shownFolders = useRef<string[]>([]);
  shownFolders.current = rows.filter((r) => r.expanded).map((r) => r.entry.path);
  useEffect(
    () =>
      watchFolders(
        () => shownFolders.current,
        (folders) => folders.forEach((folder) => void load(folder)),
      ),
    [load],
  );

  return { rows, ready, load, toggle, refresh, collapseAll, afterRename };
}

/**
 * A tree row with an inline name field, as in VS Code: Enter commits, Escape
 * cancels, and leaving the field commits a valid name or cancels otherwise.
 */
function InlineNameRow({
  depth,
  isDir,
  chevron,
  initialName = "",
  validate,
  onSubmit,
  onCancel,
}: {
  depth: number;
  isDir: boolean;
  chevron?: ReactNode;
  initialName?: string;
  validate: (name: string) => string | null;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set once the edit is submitted or cancelled, so a trailing blur is ignored. */
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.scrollIntoView({ block: "nearest" });
    // Preselect the name without its extension.
    const dot = isDir ? -1 : initialName.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initialName.length);
    // Runs once, when the field appears.
  }, []);

  const commit = async (fromBlur: boolean) => {
    if (settled.current) return;
    const name = value.trim();
    if (!name || name === initialName) {
      settled.current = true;
      return onCancel();
    }
    const problem = validate(name);
    if (problem) {
      if (fromBlur) {
        settled.current = true;
        onCancel();
      } else {
        setError(problem);
      }
      return;
    }
    settled.current = true;
    try {
      await onSubmit(name);
    } catch (e) {
      settled.current = false;
      setError(errorMessage(e));
      if (!fromBlur) inputRef.current?.focus();
    }
  };

  return (
    <div
      style={{ height: ROW_HEIGHT, paddingLeft: 2 + depth * INDENT }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="mx-1 flex items-center gap-1.5 pr-2 text-[14px]"
    >
      <span className="flex w-4 shrink-0 justify-center text-fg-muted">{chevron}</span>
      <FileIcon name={value} isDir={isDir} size={19} />
      <div className="relative ml-0.5 min-w-0 flex-1">
        <input
          ref={inputRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={isDir ? "Folder name" : "File name"}
          aria-invalid={error !== null}
          onChange={(e) => {
            setValue(e.target.value);
            const name = e.target.value.trim();
            setError(name ? validate(name) : null);
          }}
          onKeyDown={(e) => {
            // Keep arrows, Enter and Delete away from the tree's own shortcuts.
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void commit(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              settled.current = true;
              onCancel();
            }
          }}
          onBlur={() => void commit(true)}
          className={`h-6 w-full rounded-sm border bg-input px-1 text-fg outline-none ${
            error ? "border-danger" : "border-accent"
          }`}
        />
        {error && (
          <div className="absolute top-full right-0 left-0 z-10 border border-t-0 border-danger bg-[#5a1d1d] px-1.5 py-1 text-xs">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

type Editing =
  | { kind: "file" | "folder"; dir: string }
  | { kind: "rename"; path: string };

function Tree({ root }: { root: string }) {
  const { rows, ready, load, toggle, refresh, collapseAll, afterRename } = useTree(root);
  const git = useGit();

  // Git operations (checkout, pull, rollback) can add and remove files.
  const fsVersion = useWorkspace((s) => s.fsVersion);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const seenFsVersion = useRef(fsVersion);
  useEffect(() => {
    if (fsVersion === seenFsVersion.current) return;
    seenFsVersion.current = fsVersion;
    refreshRef.current();
  }, [fsVersion]);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row | null } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // The scroll position of last time, applied once the restored folders are loaded
  // (before that the tree is too short to scroll that far). Moving it yourself first wins.
  // The tree is keyed by its folder, so this is read once per folder.
  const [savedScroll] = useState(() => savedExplorer(root).scrollTop);
  const pendingScroll = useRef<number | null>(savedScroll > 0 ? savedScroll : null);
  useLayoutEffect(() => {
    if (!ready || pendingScroll.current === null || !listRef.current) return;
    listRef.current.scrollTop = pendingScroll.current;
    pendingScroll.current = null;
  }, [ready, rows]);
  const cancelPendingScroll = () => {
    pendingScroll.current = null;
  };

  const startCreate = (dir: string, kind: "file" | "folder") => {
    toggle(dir, true);
    setEditing({ kind, dir });
  };

  const finishEditing = () => {
    setEditing(null);
    listRef.current?.focus();
  };

  const create = async (dir: string, kind: "file" | "folder", name: string) => {
    const path = joinPath(dir, name);
    await createEntry(path, kind);
    // Expand every folder down to the new entry so it is visible.
    for (let folder = parentDir(path); isWithin(folder, dir); folder = parentDir(folder)) {
      toggle(folder, true);
      if (folder === dir) break;
    }
    setSelected(path);
    finishEditing();
  };

  const rename = async (entry: DirEntry, name: string) => {
    const to = joinPath(parentDir(entry.path), name);
    await renameEntry(entry.path, to);
    afterRename(entry.path, to);
    setSelected(to);
    finishEditing();
  };

  const activate = (row: Row) => {
    if (row.entry.isDir) toggle(row.entry.path);
    else openEditor(row.entry.path);
  };

  const scrollIntoView = (index: number) => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  /** Folder that header actions create into: the selected folder, or the selected file's folder. */
  const selectedDir = () => {
    const row = rows.find((r) => r.entry.path === selected);
    if (!row) return root;
    return row.entry.isDir ? row.entry.path : parentDir(row.entry.path);
  };

  const remove = async (entry: DirEntry) => {
    if (await deleteEntry(entry.path, entry.isDir)) {
      void load(parentDir(entry.path));
      setSelected(parentDir(entry.path));
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const index = rows.findIndex((r) => r.entry.path === selected);
    const row = rows[index];
    const select = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!target) return;
      setSelected(target.entry.path);
      scrollIntoView(rows.indexOf(target));
    };
    switch (e.key) {
      case "ArrowDown":
        select(index + 1);
        break;
      case "ArrowUp":
        select(index < 0 ? 0 : index - 1);
        break;
      case "ArrowRight":
        if (row?.entry.isDir && !row.expanded) toggle(row.entry.path, true);
        else select(index + 1);
        break;
      case "ArrowLeft":
        if (row?.entry.isDir && row.expanded) toggle(row.entry.path, false);
        else if (row) {
          // Jump to the parent directory.
          for (let i = index - 1; i >= 0; i--) {
            if (rows[i].depth < row.depth) return select(i);
          }
        }
        break;
      case "Enter":
        if (row) activate(row);
        break;
      case "Delete":
        if (row && row.depth > 0) void remove(row.entry);
        break;
      case "F2":
      case "F6":
        if (row && row.depth > 0 && (e.key === "F2" || e.shiftKey)) {
          setEditing({ kind: "rename", path: row.entry.path });
        }
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const menuItems = (row: Row | null): MenuEntry[] => {
    const entry = row?.entry ?? { name: basename(root), path: root, isDir: true };
    const dir = entry.isDir ? entry.path : parentDir(entry.path);
    const isRoot = entry.path === root;
    const items: MenuEntry[] = [
      { label: "New File", icon: FilePlus, action: () => startCreate(dir, "file") },
      { label: "New Folder", icon: FolderPlus, action: () => startCreate(dir, "folder") },
    ];
    if (!isRoot) {
      items.push(
        "separator",
        {
          label: "Rename",
          icon: Pencil,
          shortcut: "Shift+F6",
          action: () => setEditing({ kind: "rename", path: entry.path }),
        },
        { label: "Delete", icon: Trash2, shortcut: "Delete", action: () => void remove(entry) },
      );
    }
    items.push("separator", {
      label: "Copy Path",
      icon: Copy,
      action: () => void navigator.clipboard.writeText(entry.path),
    });
    if (!isRoot) {
      items.push({
        label: "Copy Relative Path",
        action: () => void navigator.clipboard.writeText(entry.path.slice(root.length + 1)),
      });
    }
    items.push("separator");
    // SSH files are not on this machine, so the file manager cannot show them.
    if (!isSshPath(entry.path)) {
      items.push({ label: REVEAL_LABEL, icon: ExternalLink, action: () => void revealItemInDir(entry.path) });
    }
    items.push(
      { label: "Open in Terminal", icon: SquareTerminal, action: () => openTerminalAt(dir) },
      "separator",
      { label: "Reload from Disk", icon: RefreshCw, action: refresh },
    );
    return items;
  };

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Project">
        <IconButton
          icon={FilePlus}
          title="New File"
          onClick={() => startCreate(selectedDir(), "file")}
          className="size-7"
        />
        <IconButton
          icon={FolderPlus}
          title="New Folder"
          onClick={() => startCreate(selectedDir(), "folder")}
          className="size-7"
        />
        <IconButton icon={RefreshCw} title="Reload from Disk" onClick={refresh} className="size-7" size={14} />
        <IconButton icon={ChevronsDownUp} title="Collapse All" onClick={collapseAll} className="size-7" />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("project")} className="size-7" />
      </ToolWindowHeader>
      <div
        ref={listRef}
        role="tree"
        tabIndex={0}
        onScroll={(e) => {
          // Not while the restored position is still to be applied (the tree is loading).
          if (pendingScroll.current === null) saveExplorer(root, { scrollTop: e.currentTarget.scrollTop });
        }}
        onWheel={cancelPendingScroll}
        onPointerDown={cancelPendingScroll}
        onKeyDown={(e) => {
          cancelPendingScroll();
          onKeyDown(e);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onContextMenu={(e) => {
          // Rows set their own target; this handles the empty area below them.
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, row: null });
        }}
        className="min-h-0 flex-1 overflow-auto pb-2 outline-none"
      >
        {rows.map((row, index) => {
          const isSelected = row.entry.path === selected;
          const gitState = gitStateOf(git, row.entry.path, row.entry.isDir);
          const chevron =
            row.entry.isDir &&
            (row.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />);

          if (editing?.kind === "rename" && editing.path === row.entry.path) {
            return (
              <InlineNameRow
                key={row.entry.path}
                depth={row.depth}
                isDir={row.entry.isDir}
                chevron={chevron}
                initialName={row.entry.name}
                validate={(name) => validateName(name, false)}
                onSubmit={(name) => rename(row.entry, name)}
                onCancel={finishEditing}
              />
            );
          }

          // New entries are typed in at the top of their (expanded) folder.
          const creating =
            editing && editing.kind !== "rename" && editing.dir === row.entry.path && row.expanded
              ? editing
              : null;
          return (
            <Fragment key={row.entry.path}>
              <div
                data-index={index}
                role="treeitem"
                aria-expanded={row.entry.isDir ? row.expanded : undefined}
                aria-selected={isSelected}
                {...tooltipProps(row.entry.path)}
                onClick={() => {
                  setSelected(row.entry.path);
                  if (row.entry.isDir) toggle(row.entry.path);
                }}
                onDoubleClick={() => !row.entry.isDir && openEditor(row.entry.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelected(row.entry.path);
                  setMenu({ x: e.clientX, y: e.clientY, row });
                }}
                style={{ height: ROW_HEIGHT, paddingLeft: 2 + row.depth * INDENT }}
                className={`mx-1 flex cursor-default items-center gap-1.5 rounded pr-2 text-[14px] whitespace-nowrap ${
                  isSelected
                    ? focused || menu
                      ? "bg-selected"
                      : "bg-selected-inactive"
                    : "hover:bg-hover/50"
                }`}
              >
                <span className="flex w-4 shrink-0 justify-center text-fg-muted">{chevron}</span>
                <FileIcon
                  name={row.entry.name}
                  isDir={row.entry.isDir}
                  expanded={row.expanded}
                  root={row.depth === 0}
                  size={19}
                />
                <span className="ml-0.5" style={gitState ? { color: GIT_COLORS[gitState] } : undefined}>
                  {row.entry.name}
                </span>
                {row.depth === 0 && <span className="ml-2 truncate text-fg-subtle">{row.entry.path}</span>}
              </div>
              {creating && (
                <InlineNameRow
                  depth={row.depth + 1}
                  isDir={creating.kind === "folder"}
                  validate={(name) => validateName(name, true)}
                  onSubmit={(name) => create(creating.dir, creating.kind, name)}
                  onCancel={finishEditing}
                />
              )}
            </Fragment>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={closeMenu} />}
    </div>
  );
}

export function ProjectView() {
  const root = useWorkspace((s) => s.root);
  const toggleTool = useWorkspace((s) => s.toggleTool);

  if (!root) {
    return (
      <div className="flex h-full flex-col">
        <ToolWindowHeader title="Project">
          <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("project")} className="size-7" />
        </ToolWindowHeader>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-fg-muted">
          <p>No folder is open.</p>
          <button
            type="button"
            onClick={() => void openFolder()}
            className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover"
          >
            <FolderOpen size={15} />
            Open Folder…
          </button>
        </div>
      </div>
    );
  }
  return <Tree key={root} root={root} />;
}
