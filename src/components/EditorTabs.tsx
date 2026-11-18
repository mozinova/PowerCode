import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Blocks, Columns2, Copy, ExternalLink, EllipsisVertical, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { closeTab, closeTabs } from "../actions";
import { basename, isWithin, parentDir } from "../lib/paths";
import { REVEAL_LABEL } from "../lib/platform";
import { isSshPath } from "../lib/remote";
import { isVirtualTab, parseCommitDiffTab, parseDiffTab, parseExtensionTab } from "../lib/virtualTabs";
import { GIT_COLORS, gitStateOf, useGit } from "../git/store";
import { useWorkspace, type EditorGroup, type EditorTab } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { ContextMenu, DropdownMenu, type MenuEntry } from "./Menu";
import { tooltipProps } from "./Tooltip";
import { IconButton } from "./ui";

/** Splits `group` to the right, showing its active tab in the new group. */
function splitGroup(group: number) {
  const state = useWorkspace.getState();
  state.focusGroup(group);
  state.splitRight();
}

function relativePath(path: string, root: string | null) {
  return root && isWithin(path, root) && path !== root ? path.slice(root.length + 1) : path;
}

const pathsOf = (tabs: EditorTab[]) => tabs.map((t) => t.path);

/** "Close …" actions shared by the tab context menu and the tab bar menu. */
function closeActions(tabs: EditorTab[], target: EditorTab | null, group: number): MenuEntry[] {
  const index = target ? tabs.indexOf(target) : -1;
  const others = tabs.filter((t) => t !== target);
  const right = index < 0 ? [] : tabs.slice(index + 1);
  const left = index < 0 ? [] : tabs.slice(0, index);
  const saved = tabs.filter((t) => !t.dirty);
  const items: MenuEntry[] = [];
  if (target) {
    items.push(
      { label: "Close", shortcut: "Ctrl+F4", icon: X, action: () => void closeTab(target.path, group) },
      { label: "Close Other Tabs", disabled: others.length === 0, action: () => void closeTabs(pathsOf(others), group) },
      { label: "Close Tabs to the Left", disabled: left.length === 0, action: () => void closeTabs(pathsOf(left), group) },
      { label: "Close Tabs to the Right", disabled: right.length === 0, action: () => void closeTabs(pathsOf(right), group) },
    );
  }
  items.push(
    { label: "Close All Tabs", disabled: tabs.length === 0, action: () => void closeTabs(pathsOf(tabs), group) },
    {
      label: "Close Saved Tabs",
      disabled: saved.length === 0,
      action: () => void closeTabs(pathsOf(saved), group),
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
  group,
  active,
  focused,
  onContextMenu,
}: {
  tab: EditorTab;
  group: number;
  active: boolean;
  /** Whether this tab's group is the focused one; its active tab is then highlighted. */
  focused: boolean;
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
          void closeTab(tab.path, group);
        }
      }}
      onClick={() => setActive(tab.path, group)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={`group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2.5 ${
        active && focused
          ? "bg-[#25324d] text-fg ring-1 ring-accent/70 ring-inset"
          : active
            ? "bg-white/6 text-fg"
            : "text-fg-muted hover:bg-hover/60 hover:text-fg"
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
          void closeTab(tab.path, group);
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
function TabsMenu({ group }: { group: EditorGroup }) {
  const { tabs, activePath } = group;
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
      action: () => setActive(tab.path, group.id),
    })),
    "separator",
    { label: "Split Right", icon: Columns2, shortcut: "Ctrl+\\", disabled: !active, action: () => splitGroup(group.id) },
    "separator",
    ...closeActions(tabs, active, group.id),
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

export function EditorTabs({ group, focused }: { group: EditorGroup; focused: boolean }) {
  const { tabs, activePath } = group;
  const root = useWorkspace((s) => s.root);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: EditorTab } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className="flex h-10 shrink-0 items-center bg-editor">
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
            group={group.id}
            active={tab.path === activePath}
            focused={focused}
            onContextMenu={(x, y) => setMenu({ x, y, tab })}
          />
        ))}
      </div>
      <IconButton
        icon={Columns2}
        title="Split Editor Right"
        shortcut="Ctrl+\\"
        onClick={() => splitGroup(group.id)}
        className="size-7 shrink-0"
      />
      <TabsMenu group={group} />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: "Split Right",
              icon: Columns2,
              action: () => {
                useWorkspace.getState().setActive(menu.tab.path, group.id);
                splitGroup(group.id);
              },
            },
            "separator",
            ...closeActions(tabs, menu.tab, group.id),
            ...pathActions(menu.tab, root),
          ]}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
