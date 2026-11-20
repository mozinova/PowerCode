//! Window chrome in the IntelliJ New UI style: main toolbar and status bar
//! (the tool window stripes are in ToolStripes.tsx).

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  ChevronDown,
  Copy,
  Folder,
  FolderOpen,
  Loader2,
  Menu,
  Minus,
  Server,
  ShieldAlert,
  Square,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { closeActiveTab, closeFolder, closeRemoteConnection, openFolder, openRecentProject, openSettings, saveActive } from "../actions";
import { basename } from "../lib/paths";
import { pathKey } from "../lib/platform";
import { useRecentProjects } from "../state/recentProjects";
import { openNewWindow } from "../cli";
import { remoteLabel, remoteOf } from "../lib/remote";
import * as hostRpc from "../exthost/rpc";
import { useExtensionHost, type StatusItem as ExtensionStatusItem } from "../exthost/state";
import { CodiconText } from "./ExtIcon";
import { showTrustDialog, useTrust } from "../state/trust";
import { useActivity } from "../state/activity";
import { notify } from "../state/notifications";
import { setAutoSave, useSettings } from "../state/settings";
import { useWorkspace } from "../state/workspace";
import { BranchWidget } from "./BranchWidget";
import { FileSearch } from "./FileSearch";
import { DropdownMenu, type MenuEntry } from "./Menu";
import { IconButton } from "./ui";
import { tooltipProps } from "./Tooltip";
import packageJson from "../../package.json";

const APP_VERSION = packageJson.version;

function MainMenu() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasActive = useWorkspace((s) => s.activePath !== null);
  const hasRoot = useWorkspace((s) => s.root !== null);
  const autoSave = useSettings((s) => s.autoSave);
  const { toggleTool, toggleBottomTool } = useWorkspace.getState();
  const close = useCallback(() => setOpen(false), []);

  const items: MenuEntry[] = [
    { label: "New Window", action: () => void openNewWindow() },
    "separator",
    { label: "Open Folder…", shortcut: "Ctrl+O", action: () => void openFolder() },
    { label: "Close Folder", action: () => void closeFolder(), disabled: !hasRoot },
    "separator",
    { label: "Save", shortcut: "Ctrl+S", action: () => void saveActive(), disabled: !hasActive },
    { label: "Auto Save", checked: autoSave, action: () => setAutoSave(!autoSave) },
    { label: "Close Tab", shortcut: "Ctrl+F4", action: closeActiveTab, disabled: !hasActive },
    "separator",
    { label: "Project", shortcut: "Alt+1", action: () => toggleTool("project") },
    { label: "Commit", shortcut: "Alt+0", action: () => toggleTool("commit") },
    { label: "Find in Files", shortcut: "Ctrl+Shift+F", action: () => toggleTool("search") },
    { label: "Extensions", shortcut: "Alt+2", action: () => toggleTool("extensions") },
    { label: "Terminal", shortcut: "Alt+F12", action: () => toggleBottomTool("terminal") },
    { label: "Output", action: () => toggleBottomTool("output") },
    "separator",
    { label: "Settings…", shortcut: "Ctrl+,", action: () => openSettings() },
    "separator",
    // The installed version, for bug reports (the release build takes it from the tag).
    { label: `PowerCode ${APP_VERSION}`, disabled: true, action: () => {} },
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

/** Where a recent folder lives, shown next to its name: its path, or the remote's name. */
function projectDetail(path: string) {
  const remote = remoteOf(path);
  if (!remote) return path;
  // The path on the remote, as it is spelled there.
  const inside = path.replace(/^ssh:\/\/[^/]+|^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i, "").replace(/\\/g, "/");
  return `${remoteLabel(remote)} · ${inside || "/"}`;
}

/** The project name in the toolbar: the last folders opened, then "Browse…" for another. */
function ProjectSelector() {
  const root = useWorkspace((s) => s.root);
  const recent = useRecentProjects((s) => s.projects);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const name = root ? basename(root) : "No Project";

  const items: MenuEntry[] = [
    ...recent.map((path) => ({
      label: basename(path),
      detail: projectDetail(path),
      icon: remoteOf(path) ? Server : Folder,
      checked: root !== null && pathKey(path) === pathKey(root),
      action: () => {
        if (root === null || pathKey(path) !== pathKey(root)) void openRecentProject(path);
      },
    })),
    ...(recent.length > 0 ? ["separator" as const] : []),
    { label: "Browse…", icon: FolderOpen, shortcut: "Ctrl+O", action: () => void openFolder() },
    { label: "New Window", icon: AppWindow, action: () => void openNewWindow() },
  ];

  return (
    <div ref={anchorRef} className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        {...tooltipProps(root ?? "Open Folder")}
        className={`flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-hover ${open ? "bg-hover" : ""}`}
      >
        <span className="truncate font-semibold">{name}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-muted" />
      </button>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
    </div>
  );
}

export function MainToolbar() {
  return (
    // Only elements carrying `data-tauri-drag-region` themselves drag the window.
    // The side columns share the free width equally so the search stays centred.
    <header data-tauri-drag-region className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 relative">
      <div data-tauri-drag-region className="flex h-full min-w-0 items-center gap-2 pl-2">
        <MainMenu />
        <ProjectSelector />
        <BranchWidget />
      </div>
      <FileSearch />
      <div data-tauri-drag-region className="flex h-full justify-end">
        <WindowControls />
      </div>
    </header>
  );
}

function StatusItem({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span {...tooltipProps(title)} className="flex h-full items-center rounded px-1.5 hover:bg-hover">
      {children}
    </span>
  );
}

/** Items extensions put in the status bar; a higher priority sits further left, as in VS Code. */
function ExtensionStatusItems({ alignment }: { alignment: 1 | 2 }) {
  const items = useExtensionHost((s) => s.statusItems);
  const message = useExtensionHost((s) => s.statusMessage);
  const shown = items
    .filter((i) => (i.alignment === 2 ? 2 : 1) === alignment && i.text.trim())
    .sort((a, b) => b.priority - a.priority);
  const run = (item: ExtensionStatusItem) => {
    if (!item.command) return;
    hostRpc
      .request("commands/execute", { command: item.command.command, args: item.command.arguments ?? [] })
      .catch((e) => notify("error", "Command failed", e instanceof Error ? e.message : String(e)));
  };
  return (
    <>
      {alignment === 1 && message && (
        <span className="mx-1.5 truncate">
          <CodiconText text={message} />
        </span>
      )}
      {shown.map((item) => (
        <span
          key={item.id}
          {...tooltipProps(item.tooltip)}
          onClick={() => run(item)}
          className={`flex h-full max-w-60 items-center truncate rounded px-1.5 hover:bg-hover ${item.command ? "cursor-pointer" : ""}`}
        >
          <CodiconText text={item.text} />
        </span>
      ))}
    </>
  );
}

/** Shown while the open folder is in Restricted Mode; opens the trust dialog. */
function RestrictedModeIndicator() {
  const root = useWorkspace((s) => s.root);
  const state = useTrust((s) => s.state);
  if (!root || state === "trusted") return null;
  return (
    <button
      type="button"
      {...tooltipProps("Restricted Mode: extensions, Git and debugging are limited until you trust this folder")}
      onClick={() => showTrustDialog(root)}
      className="mr-2 flex h-full items-center gap-1.5 bg-[#e0b84c] px-2.5 font-medium text-[#1e1f22] hover:bg-[#ecc65a]"
    >
      <ShieldAlert size={13} />
      Restricted Mode
    </button>
  );
}

/** VS Code's remote indicator: where the open folder lives, at the far left of the status bar. */
function RemoteIndicator() {
  const root = useWorkspace((s) => s.root);
  const showTool = useWorkspace((s) => s.showTool);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const remote = remoteOf(root);
  if (!remote) return null;

  const items: MenuEntry[] = [
    { label: "Close Remote Connection", icon: Unplug, action: () => void closeRemoteConnection() },
    { label: "Remote Hosts", icon: Server, action: () => showTool("remote") },
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
        <RestrictedModeIndicator />
        <ActivityIndicator />
        {crumbs.map((crumb, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className="px-1 text-fg-subtle">›</span>}
            <span className={i === crumbs.length - 1 ? "text-fg" : ""}>{crumb}</span>
          </span>
        ))}
        <span className="w-2 shrink-0" />
        <ExtensionStatusItems alignment={1} />
      </div>
      <div className="flex h-full shrink-0 items-center py-0.5">
        <ExtensionStatusItems alignment={2} />
        {activePath && cursor && status && (
          <>
            <StatusItem title="Line:Column">
              {cursor.line}:{cursor.column}
              {cursor.selected > 0 && ` (${cursor.selected} chars)`}
            </StatusItem>
            <StatusItem title="Line Separator">{status.eol}</StatusItem>
            <StatusItem title="File Encoding">UTF-8</StatusItem>
            <StatusItem title="Indentation">{status.indent}</StatusItem>
            <StatusItem title="Language">{status.language}</StatusItem>
          </>
        )}
      </div>
    </footer>
  );
}
