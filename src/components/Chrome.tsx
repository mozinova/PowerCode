//! Window chrome in the IntelliJ New UI style: main toolbar, tool window
//! stripe and status bar.

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Blocks,
  ChevronDown,
  Copy,
  Folder,
  GitCommitHorizontal,
  Loader2,
  Menu,
  Minus,
  Search,
  Server,
  Square,
  SquareTerminal,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { closeActiveTab, closeFolder, closeRemoteConnection, openFolder, saveActive } from "../actions";
import { basename } from "../lib/paths";
import { useGit } from "../git/store";
import { remoteLabel, remoteOf } from "../lib/remote";
import { useActivity } from "../state/activity";
import { setAutoSave, useSettings } from "../state/settings";
import { useWorkspace } from "../state/workspace";
import { BranchWidget } from "./BranchWidget";
import { FileSearch } from "./FileSearch";
import { DropdownMenu, type MenuEntry } from "./Menu";
import { IconButton } from "./ui";
import { tooltipProps } from "./Tooltip";

function MainMenu() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasActive = useWorkspace((s) => s.activePath !== null);
  const hasRoot = useWorkspace((s) => s.root !== null);
  const autoSave = useSettings((s) => s.autoSave);
  const { toggleLeftTool, toggleBottomTool } = useWorkspace.getState();
  const close = useCallback(() => setOpen(false), []);

  const items: MenuEntry[] = [
    { label: "Open Folder…", shortcut: "Ctrl+O", action: () => void openFolder() },
    { label: "Close Folder", action: () => void closeFolder(), disabled: !hasRoot },
    "separator",
    { label: "Save", shortcut: "Ctrl+S", action: () => void saveActive(), disabled: !hasActive },
    { label: "Auto Save", checked: autoSave, action: () => setAutoSave(!autoSave) },
    { label: "Close Tab", shortcut: "Ctrl+F4", action: closeActiveTab, disabled: !hasActive },
    "separator",
    { label: "Project", shortcut: "Alt+1", action: () => toggleLeftTool("project") },
    { label: "Commit", shortcut: "Alt+0", action: () => toggleLeftTool("commit") },
    { label: "Find in Files", shortcut: "Ctrl+Shift+F", action: () => toggleLeftTool("search") },
    { label: "Extensions", shortcut: "Alt+2", action: () => toggleLeftTool("extensions") },
    { label: "Terminal", shortcut: "Alt+F12", action: () => toggleBottomTool("terminal") },
  ];

  return (
    <div className="relative">
      <div ref={anchorRef}>
        <IconButton icon={Menu} title="Main Menu" onClick={() => setOpen(!open)} active={open} className="size-7" />
      </div>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
    </div>
  );
}

function WindowButton({
  icon: Icon,
  title,
  onClick,
  danger = false,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      onClick={onClick}
      className={`flex h-full w-[46px] items-center justify-center text-fg-muted hover:text-white ${
        danger ? "hover:bg-[#c42b1c]" : "hover:bg-hover"
      }`}
    >
      <Icon size={15} strokeWidth={1.5} />
    </button>
  );
}

/** Minimize, maximize/restore and close; the native title bar is disabled. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const sync = () => void appWindow.isMaximized().then(setMaximized);
    sync();
    const unlisten = appWindow.onResized(sync);
    return () => void unlisten.then((fn) => fn());
  }, []);

  const appWindow = getCurrentWindow();
  return (
    <div className="flex h-full self-stretch">
      <WindowButton icon={Minus} title="Minimize" onClick={() => void appWindow.minimize()} />
      <WindowButton
        icon={maximized ? Copy : Square}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void appWindow.toggleMaximize()}
      />
      <WindowButton icon={X} title="Close" onClick={() => void appWindow.close()} danger />
    </div>
  );
}

export function MainToolbar() {
  const root = useWorkspace((s) => s.root);
  const name = root ? basename(root) : "No Project";
  return (
    // Only elements carrying `data-tauri-drag-region` themselves drag the window.
    // The side columns share the free width equally so the search stays centred.
    <header data-tauri-drag-region className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 relative">
      <div data-tauri-drag-region className="flex h-full min-w-0 items-center gap-2 pl-2">
        <MainMenu />
        <button
          type="button"
          onClick={() => void openFolder()}
          {...tooltipProps(root ?? "Open Folder")}
          className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-hover"
        >
          <span className="truncate font-semibold">{name}</span>
          <ChevronDown size={14} className="shrink-0 text-fg-muted" />
        </button>
        <BranchWidget />
      </div>
      <FileSearch />
      <div data-tauri-drag-region className="flex h-full justify-end">
        <WindowControls />
      </div>
    </header>
  );
}

export function ToolStripe() {
  // Changed files to commit, as VS Code's Source Control badge counts them.
  const changeCount = useGit((s) => s.status?.files.filter((f) => !f.ignored).length ?? 0);
  const leftTool = useWorkspace((s) => s.leftTool);
  const bottomTool = useWorkspace((s) => s.bottomTool);
  const toggleLeftTool = useWorkspace((s) => s.toggleLeftTool);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  return (
    <nav aria-label="Tool windows" className="flex w-12 shrink-0 flex-col items-center gap-1.5 py-1">
      <IconButton
        icon={Folder}
        title="Project"
        shortcut="Alt+1"
        tooltipSide="right"
        active={leftTool === "project"}
        onClick={() => toggleLeftTool("project")}
        className="size-9"
        size={22}
      />
      <IconButton
        icon={GitCommitHorizontal}
        title="Commit"
        shortcut="Alt+0"
        tooltipSide="right"
        active={leftTool === "commit"}
        badge={changeCount}
        onClick={() => toggleLeftTool("commit")}
        className="size-9"
        size={22}
      />
      <IconButton
        icon={Search}
        title="Find in Files"
        shortcut="Ctrl+Shift+F"
        tooltipSide="right"
        active={leftTool === "search"}
        onClick={() => toggleLeftTool("search")}
        className="size-9"
        size={22}
      />
      <IconButton
        icon={Server}
        title="Remote Hosts"
        tooltipSide="right"
        active={leftTool === "remote"}
        onClick={() => toggleLeftTool("remote")}
        className="size-9"
        size={22}
      />
      <IconButton
        icon={Blocks}
        title="Extensions"
        shortcut="Alt+2"
        tooltipSide="right"
        active={leftTool === "extensions"}
        onClick={() => toggleLeftTool("extensions")}
        className="size-9"
        size={22}
      />
      <div className="flex-1" />
      <IconButton
        icon={SquareTerminal}
        title="Terminal"
        shortcut="Alt+F12"
        tooltipSide="right"
        active={bottomTool === "terminal"}
        onClick={() => toggleBottomTool("terminal")}
        className="size-9"
        size={22}
      />
    </nav>
  );
}

function StatusItem({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span {...tooltipProps(title)} className="flex h-full items-center rounded px-1.5 hover:bg-hover">
      {children}
    </span>
  );
}

/** VS Code's remote indicator: where the open folder lives, at the far left of the status bar. */
function RemoteIndicator() {
  const root = useWorkspace((s) => s.root);
  const setLeftTool = useWorkspace((s) => s.setLeftTool);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const remote = remoteOf(root);
  if (!remote) return null;

  const items: MenuEntry[] = [
    { label: "Close Remote Connection", icon: Unplug, action: () => void closeRemoteConnection() },
    { label: "Remote Hosts", icon: Server, action: () => setLeftTool("remote") },
  ];
  return (
    // Kept clear of the window's bottom-left corner, which Windows 11 rounds and would clip.
    <div ref={anchorRef} className="mr-3 h-full shrink-0">
      <button
        type="button"
        {...tooltipProps(`Remote: ${remoteLabel(remote)}`)}
        onClick={() => setOpen(!open)}
        className="flex h-full items-center gap-1.5 rounded-none bg-accent px-2.5 text-white hover:bg-accent-hover"
      >
        <Server size={12} />
        {remoteLabel(remote)}
      </button>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
    </div>
  );
}

/** Spinner and label of the background work in progress, at the left of the status bar. */
function ActivityIndicator() {
  const tasks = useActivity((s) => s.tasks);
  if (tasks.length === 0) return null;
  const latest = tasks[tasks.length - 1];
  return (
    <span
      role="status"
      {...tooltipProps(tasks.map((t) => t.label).join("\n"))}
      className="mr-3 flex shrink-0 items-center gap-1.5 text-fg-muted"
    >
      <Loader2 size={12} className="animate-spin" />
      <span>{latest.label}</span>
      {tasks.length > 1 && <span className="text-fg-subtle">(+{tasks.length - 1})</span>}
    </span>
  );
}

export function StatusBar() {
  const root = useWorkspace((s) => s.root);
  const activePath = useWorkspace((s) => s.activePath);
  const cursor = useWorkspace((s) => s.cursor);
  const status = useWorkspace((s) => s.status);

  let crumbs: string[] = [];
  if (root) {
    crumbs = [basename(root)];
    if (activePath?.startsWith(root)) {
      crumbs.push(...activePath.slice(root.length).split(/[\\/]/).filter(Boolean));
    }
  }

  return (
    <footer className="relative flex h-6 shrink-0 items-center justify-between gap-4 px-2 text-xs text-fg-muted">
      <div className="flex h-full min-w-0 items-center truncate">
        <RemoteIndicator />
        <ActivityIndicator />
        {crumbs.map((crumb, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className="px-1 text-fg-subtle">›</span>}
            <span className={i === crumbs.length - 1 ? "text-fg" : ""}>{crumb}</span>
          </span>
        ))}
      </div>
      {activePath && cursor && status && (
        <div className="flex h-full shrink-0 items-center py-0.5">
          <StatusItem title="Line:Column">
            {cursor.line}:{cursor.column}
            {cursor.selected > 0 && ` (${cursor.selected} chars)`}
          </StatusItem>
          <StatusItem title="Line Separator">{status.eol}</StatusItem>
          <StatusItem title="File Encoding">UTF-8</StatusItem>
          <StatusItem title="Indentation">{status.indent}</StatusItem>
          <StatusItem title="Language">{status.language}</StatusItem>
        </div>
      )}
    </footer>
  );
}
