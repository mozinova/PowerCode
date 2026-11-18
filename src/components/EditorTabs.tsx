import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Blocks, Copy, ExternalLink, EllipsisVertical, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { closeTab, closeTabs } from "../actions";
import { basename, isWithin, parentDir } from "../lib/paths";
import { REVEAL_LABEL } from "../lib/platform";
import { isSshPath } from "../lib/remote";
import { isVirtualTab, parseCommitDiffTab, parseDiffTab, parseExtensionTab } from "../lib/virtualTabs";
import { GIT_COLORS, gitStateOf, useGit } from "../git/store";
import { useWorkspace, type EditorTab } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { ContextMenu, DropdownMenu, type MenuEntry } from "./Menu";
import { tooltipProps } from "./Tooltip";
import { IconButton } from "./ui";

function relativePath(path: string, root: string | null) {
  return root && isWithin(path, root) && path !== root ? path.slice(root.length + 1) : path;
}

const pathsOf = (tabs: EditorTab[]) => tabs.map((t) => t.path);

/** "Close …" actions shared by the tab context menu and the tab bar menu. */
function closeActions(tabs: EditorTab[], target: EditorTab | null): MenuEntry[] {
  const index = target ? tabs.indexOf(target) : -1;
  const others = tabs.filter((t) => t !== target);
  const right = index < 0 ? [] : tabs.slice(index + 1);
  const left = index < 0 ? [] : tabs.slice(0, index);
  const saved = tabs.filter((t) => !t.dirty);
  const items: MenuEntry[] = [];
  if (target) {
    items.push(
      { label: "Close", shortcut: "Ctrl+F4", icon: X, action: () => void closeTab(target.path) },
      { label: "Close Other Tabs", disabled: others.length === 0, action: () => void closeTabs(pathsOf(others)) },
      { label: "Close Tabs to the Left", disabled: left.length === 0, action: () => void closeTabs(pathsOf(left)) },
      { label: "Close Tabs to the Right", disabled: right.length === 0, action: () => void closeTabs(pathsOf(right)) },
    );
  }
  items.push(
    { label: "Close All Tabs", disabled: tabs.length === 0, action: () => void closeTabs(pathsOf(tabs)) },
    {
      label: "Close Saved Tabs",
      disabled: saved.length === 0,
      action: () => void closeTabs(pathsOf(saved)),
    },
  );
  return items;
}

/** Path actions, preceded by a separator; none for page tabs, which have no file. */
function pathActions(tab: EditorTab, root: string | null): MenuEntry[] {
  if (isVirtualTab(tab.path)) return [];
  return [
    "separator",
    { label: "Copy Path", icon: Copy, action: () => void navigator.clipboard.writeText(tab.path) },
    {
      label: "Copy Relative Path",
      action: () => void navigator.clipboard.writeText(relativePath(tab.path, root)),
    },
    // SSH files are not on this machine, so the file manager cannot show them.
    ...(isSshPath(tab.path)
      ? []
      : [{ label: REVEAL_LABEL, icon: ExternalLink, action: () => void revealItemInDir(tab.path) }]),
  ];
}

function TabIcon({ tab }: { tab: EditorTab }) {
  const [failed, setFailed] = useState(false);
  if (tab.icon && !failed) {
    return (
      <img
        src={tab.icon}
        alt=""
        width={15}
        height={15}
        draggable={false}
        onError={() => setFailed(true)}
        className="size-[15px] shrink-0 rounded-sm object-contain"
      />
    );
  }
  const diffFile = parseDiffTab(tab.path) ?? parseCommitDiffTab(tab.path)?.file;
  if (diffFile) return <FileIcon name={basename(diffFile)} size={15} />;
  return isVirtualTab(tab.path) ? (
    <Blocks size={15} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
  ) : (
    <FileIcon name={tab.name} size={15} />
  );
}

/** The file a tab shows, for git colouring: diff tabs show their file's status too. */
function tabFile(tab: EditorTab): string | null {
  return parseDiffTab(tab.path) ?? (isVirtualTab(tab.path) ? null : tab.path);
}

function tabTooltip(tab: EditorTab): string {
  if (parseExtensionTab(tab.path)) return `Extension: ${tab.name}`;
  const commit = parseCommitDiffTab(tab.path);
  if (commit) return `${commit.file} @ ${commit.hash.slice(0, 8)}`;
  return parseDiffTab(tab.path) ?? tab.path;
}

function Tab({
  tab,
  active,
  onContextMenu,
}: {
  tab: EditorTab;
  active: boolean;
  onContextMenu: (x: number, y: number) => void;
}) {
  const setActive = useWorkspace((s) => s.setActive);
  const ref = useRef<HTMLDivElement>(null);
  const file = tabFile(tab);
  const gitState = useGit((s) => (file ? gitStateOf(s, file) : null));

  // Keep the active tab visible when the bar overflows.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      {...tooltipProps(tabTooltip(tab))}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.path);
        }
      }}
      onClick={() => setActive(tab.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={`group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2.5 ${
        active ? "bg-[#25324d] text-fg ring-1 ring-accent/70 ring-inset" : "text-fg-muted hover:bg-hover/60 hover:text-fg"
      }`}
    >
      <TabIcon tab={tab} />
      <span style={gitState ? { color: GIT_COLORS[gitState] } : undefined}>{tab.name}</span>
      <button
        type="button"
        {...tooltipProps("Close", "Ctrl+F4")}
        aria-label={`Close ${tab.name}${tab.dirty ? " (unsaved changes)" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(tab.path);
        }}
        className={`flex size-[18px] items-center justify-center rounded hover:bg-hover ${
          active || tab.dirty ? "visible" : "invisible group-hover:visible"
        }`}
      >
        {/* Unsaved files show a dot that turns into the close button on hover. */}
        {tab.dirty && <span className="size-2 rounded-full bg-fg-muted group-hover:hidden" />}
        <X size={13} className={tab.dirty ? "hidden group-hover:block" : ""} />
      </button>
    </div>
  );
}

/** Lists every open tab (including ones scrolled out of view) and bulk close actions. */
function TabsMenu() {
  const tabs = useWorkspace((s) => s.tabs);
  const activePath = useWorkspace((s) => s.activePath);
  const root = useWorkspace((s) => s.root);
  const setActive = useWorkspace((s) => s.setActive);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const active = tabs.find((t) => t.path === activePath) ?? null;
  const items: MenuEntry[] = [
    ...tabs.map((tab) => ({
      label: tab.dirty ? `${tab.name} •` : tab.name,
      detail: parseExtensionTab(tab.path)
        ? "Extension"
        : parseDiffTab(tab.path)
          ? "Diff"
          : parseCommitDiffTab(tab.path)
            ? "Commit"
            : relativePath(parentDir(tab.path), root),
      icon: <TabIcon tab={tab} />,
      checked: tab.path === activePath,
      action: () => setActive(tab.path),
    })),
    "separator",
    ...closeActions(tabs, active),
  ];
  if (active) items.push(...pathActions(active, root));

  return (
    <div className="relative flex shrink-0 items-center px-1">
      <div ref={anchorRef}>
        <IconButton
          icon={EllipsisVertical}
          title="Opened Files"
          onClick={() => setOpen(!open)}
          active={open}
          className="size-7"
        />
      </div>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} align="right" onClose={close} />}
    </div>
  );
}

export function EditorTabs() {
  const tabs = useWorkspace((s) => s.tabs);
  const activePath = useWorkspace((s) => s.activePath);
  const root = useWorkspace((s) => s.root);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: EditorTab } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-line-soft/60 bg-editor">
      <div
        role="tablist"
        // Vertical wheel scrolls the tabs sideways, as in IntelliJ.
        onWheel={(e) => {
          if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1.5 [scrollbar-width:none]"
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.path}
            tab={tab}
            active={tab.path === activePath}
            onContextMenu={(x, y) => setMenu({ x, y, tab })}
          />
        ))}
      </div>
      <TabsMenu />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[...closeActions(tabs, menu.tab), ...pathActions(menu.tab, root)]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
