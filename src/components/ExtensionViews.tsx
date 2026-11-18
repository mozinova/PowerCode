import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, Ellipsis, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { menuItems, type Contributions, type MenuItem, type ViewContainer, type ViewDescriptor } from "../exthost/contributions";
import * as rpc from "../exthost/rpc";
import { useExtensionHost } from "../exthost/state";
import {
  collapseAll,
  isExpanded,
  isTrue,
  loadChildren,
  resolveWebviewView,
  ROOT,
  select,
  setExpanded,
  useContributions,
  useViews,
  type TreeNode,
} from "../exthost/views";
import { useContextKeys } from "../exthost/when";
import { getModel } from "../editor/models";
import { monaco } from "../editor/monaco";
import { basename } from "../lib/paths";
import { isVirtualTab, parseWebviewTab } from "../lib/virtualTabs";
import { notify } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { Codicon, ExtIcon, TreeNodeIcon } from "./ExtIcon";
import { ContextMenu, DropdownMenu, type MenuEntry } from "./Menu";
import { tooltipProps } from "./Tooltip";
import { ToolWindowHeader } from "./ui";
import { WebviewAnchor } from "./WebviewFrame";

function execute(command: string, args: unknown[] = []) {
  rpc.request("commands/execute", { command, args }).catch((e) =>
    notify("error", "Command failed", e instanceof Error ? e.message : String(e)),
  );
}

/** Re-renders when context keys change, so `when` clauses are re-evaluated. */
function useWhenContext() {
  useContextKeys((s) => s.keys);
  useWorkspace((s) => s.root);
}

export function visibleViews(container: ViewContainer): ViewDescriptor[] {
  return container.views.filter((v) => isTrue(v.when));
}

/** Containers shown in the stripe: their own `when` holds and some view is visible. */
export function useVisibleContainers(): ViewContainer[] {
  useWhenContext();
  const contributions = useContributions();
  return contributions.containers.filter((c) => isTrue(c.when) && visibleViews(c).length > 0);
}

// ---- Actions -------------------------------------------------------------------------

function ActionButton({ contributions, item, args }: { contributions: Contributions; item: MenuItem; args: unknown[] }) {
  const info = contributions.commands.get(item.command);
  const title = info?.title ?? item.command;
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        execute(item.command, args);
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
    >
      {info?.icon ? <ExtIcon icon={info.icon} mono size={16} /> : <span className="px-1 text-xs">{title}</span>}
    </button>
  );
}

function menuEntries(contributions: Contributions, groups: MenuItem[][], args: unknown[]): MenuEntry[] {
  const entries: MenuEntry[] = [];
  groups.forEach((group, i) => {
    if (i > 0) entries.push("separator");
    for (const item of group) {
      const info = contributions.commands.get(item.command);
      entries.push({ label: info?.title ?? item.command, action: () => execute(item.command, args) });
    }
  });
  return entries;
}

function MoreActions({ entries }: { entries: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (entries.length === 0) return null;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        {...tooltipProps("More Actions")}
        aria-label="More Actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Ellipsis size={16} />
      </button>
      {open && <DropdownMenu items={entries} anchorRef={anchorRef} align="right" onClose={close} />}
    </>
  );
}

function ViewActions({ view }: { view: ViewDescriptor }) {
  useWhenContext();
  const contributions = useContributions();
  const registered = useViews((s) => s.registered[view.id]);
  const { inline, other } = menuItems(contributions, "view/title", (when) => isTrue(when, { view: view.id }));
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {inline.map((item) => (
        <ActionButton key={item.command} contributions={contributions} item={item} args={[]} />
      ))}
      {registered?.kind === "tree" && registered.showCollapseAll && (
        <button
          type="button"
          {...tooltipProps("Collapse All")}
          aria-label="Collapse All"
          onClick={() => collapseAll(view.id)}
          className="flex size-6 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Codicon name="collapse-all" />
        </button>
      )}
      <MoreActions entries={menuEntries(contributions, other, [])} />
    </div>
  );
}

// ---- Welcome content -----------------------------------------------------------------------

/** Text with markdown links: `command:` links run commands, others open in the browser. */
function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index));
    const [, label, href] = match;
    parts.push(
      <a
        key={match.index}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          followLink(href);
        }}
        className="text-accent-hover hover:underline"
      >
        {label}
      </a>,
    );
    last = match.index! + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function followLink(href: string) {
  if (href.startsWith("command:")) {
    const [command, query] = href.slice("command:".length).split("?");
    let args: unknown[] = [];
    try {
      const parsed = query ? JSON.parse(decodeURIComponent(query)) : [];
      args = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Ignore malformed arguments.
    }
    execute(command, args);
  } else {
    void openUrl(href);
  }
}

function Welcome({ view }: { view: ViewDescriptor }) {
  useWhenContext();
  const contributions = useContributions();
  const entries = contributions.welcome.filter((w) => w.view === view.id && isTrue(w.when));
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3 text-[13px] text-fg-muted">
      {entries.flatMap((entry, i) =>
        entry.contents.split("\n").map((line, j) => {
          const button = /^\s*\[([^\]]+)\]\(([^)\s]+)\)\s*$/.exec(line);
          if (button) {
            return (
              <button
                key={`${i}-${j}`}
                type="button"
                onClick={() => followLink(button[2])}
                className="h-7 w-full rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover"
              >
                {button[1]}
              </button>
            );
          }
          return line.trim() ? (
            <p key={`${i}-${j}`} className="leading-5">
              <LinkedText text={line} />
            </p>
          ) : null;
        }),
      )}
    </div>
  );
}

// ---- Trees -------------------------------------------------------------------------------

function TreeRows({ view, parent, depth }: { view: ViewDescriptor; parent: string; depth: number }) {
  const tree = useViews((s) => s.trees[view.id]);
  const nodes = tree?.children[parent];
  useEffect(() => {
    if (!nodes) void loadChildren(view.id, parent);
  }, [nodes, view.id, parent]);
  if (!nodes) {
    return depth === 0 ? (
      <div className="flex items-center gap-2 px-4 py-2 text-fg-muted">
        <Loader2 size={14} className="animate-spin" />
      </div>
    ) : null;
  }
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.handle} view={view} node={node} depth={depth} />
      ))}
    </>
  );
}

function TreeRow({ view, node, depth }: { view: ViewDescriptor; node: TreeNode; depth: number }) {
  const tree = useViews((s) => s.trees[view.id]);
  const contributions = useContributions();
  useWhenContext();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const expanded = isExpanded(tree, node);
  const selected = tree?.selected === node.handle;
  const args = [{ $treeItem: { viewId: view.id, handle: node.handle } }];
  const { inline, other } = menuItems(contributions, "view/item/context", (when) =>
    isTrue(when, { view: view.id, viewItem: node.contextValue ?? "" }),
  );

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.collapsible ? expanded : undefined}
        aria-selected={selected}
        {...tooltipProps(node.tooltip)}
        onClick={() => {
          select(view.id, node.handle);
          if (node.collapsible) setExpanded(view.id, node, !expanded);
          if (node.hasCommand) void rpc.request("views/execute", { viewId: view.id, handle: node.handle }).catch(() => {});
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          select(view.id, node.handle);
          if (other.length > 0) setMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={`group flex h-[26px] cursor-default items-center gap-1.5 pr-1.5 ${selected ? "bg-selected-inactive" : "hover:bg-hover"}`}
      >
        <span className="flex w-4 shrink-0 justify-center text-fg-muted">
          {node.collapsible !== 0 && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </span>
        <TreeNodeIcon node={node} expanded={expanded} />
        <span className="min-w-0 truncate">{node.label}</span>
        {node.description && <span className="min-w-0 shrink truncate text-xs text-fg-muted">{node.description}</span>}
        <span className="flex-1" />
        {inline.length > 0 && (
          <span className="invisible flex shrink-0 items-center group-hover:visible">
            {inline.map((item) => (
              <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
            ))}
          </span>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuEntries(contributions, other, args)} onClose={closeMenu} />}
      {expanded && <TreeRows view={view} parent={node.handle} depth={depth + 1} />}
    </>
  );
}

function TreeBody({ view }: { view: ViewDescriptor }) {
  const tree = useViews((s) => s.trees[view.id]);
  const info = useViews((s) => s.info[view.id]);
  const empty = tree?.children[ROOT]?.length === 0;
  return (
    <div role="tree" aria-label={view.name} className="min-h-0 flex-1 overflow-auto pb-2">
      {info?.message && <div className="px-4 py-2 text-fg-muted">{info.message}</div>}
      {tree?.error && <div className="px-4 py-2 text-danger">{tree.error}</div>}
      {empty ? <Welcome view={view} /> : <TreeRows view={view} parent={ROOT} depth={0} />}
    </div>
  );
}

// ---- Webview views -----------------------------------------------------------------------

function WebviewBody({ view }: { view: ViewDescriptor }) {
  const id = useViews((s) => s.webviews[view.id]);
  useEffect(() => {
    if (!id) void resolveWebviewView(view.id).catch(() => {});
  }, [id, view.id]);
  return <div className="min-h-0 flex-1">{id ? <WebviewAnchor id={id} /> : null}</div>;
}

// ---- Container ---------------------------------------------------------------------------

function ViewBody({ view }: { view: ViewDescriptor }) {
  const registered = useViews((s) => s.registered[view.id]);
  const status = useExtensionHost((s) => s.status);

  // Showing a view activates extensions waiting for `onView:<id>`.
  useEffect(() => {
    rpc.notify("activate", { event: `onView:${view.id}` });
    rpc.notify("views/visible", { viewId: view.id, visible: true });
    return () => rpc.notify("views/visible", { viewId: view.id, visible: false });
  }, [view.id, status]);

  if (registered?.kind === "tree") return <TreeBody view={view} />;
  if (registered?.kind === "webview") return <WebviewBody view={view} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Welcome view={view} />
      {status === "starting" && (
        <div className="flex items-center gap-2 px-4 py-2 text-fg-muted">
          <Loader2 size={14} className="animate-spin" /> Starting extensions…
        </div>
      )}
      {status !== "running" && status !== "starting" && (
        <div className="px-4 py-2 text-fg-muted">The extension providing this view is not running.</div>
      )}
    </div>
  );
}

function ViewSection({ view, single }: { view: ViewDescriptor; single: boolean }) {
  const [open, setOpen] = useState(!view.collapsed);
  const info = useViews((s) => s.info[view.id]);
  if (single) return <ViewBody view={view} />;
  return (
    <div className={`flex min-h-0 flex-col ${open ? "flex-1" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        className="group flex h-7 shrink-0 cursor-default items-center gap-1 border-t border-line-soft pr-1.5 pl-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase hover:text-fg"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="min-w-0 flex-1 truncate">
          {info?.title ?? view.name}
          {info?.description && <span className="ml-1.5 font-normal normal-case">{info.description}</span>}
        </span>
        {open && (
          <span className="invisible group-hover:visible" onClick={(e) => e.stopPropagation()}>
            <ViewActions view={view} />
          </span>
        )}
      </div>
      {open && <ViewBody view={view} />}
    </div>
  );
}

/** The tool window of an extension's view container. */
export function ExtensionViewContainer({ tool }: { tool: string }) {
  useWhenContext();
  const contributions = useContributions();
  const info = useViews((s) => s.info);
  const container = contributions.containers.find((c) => c.tool === tool);
  if (!container) return <ToolWindowHeader title="View" />;
  const views = visibleViews(container);
  const single = views.length === 1;
  // One view: the header names it too ("Container: View"), unless it repeats the container.
  const viewTitle = single ? (info[views[0].id]?.title ?? views[0].name) : "";
  const title = viewTitle && viewTitle !== container.title ? `${container.title}: ${viewTitle}` : container.title;
  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title={title}>{single && <ViewActions view={views[0]} />}</ToolWindowHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {views.map((view) => (
          <ViewSection key={view.id} view={view} single={single} />
        ))}
      </div>
    </div>
  );
}

// ---- Editor title actions ------------------------------------------------------------------

/** `editor/title` contributions for the tab shown in a group (e.g. Claude Code's button). */
export function EditorTitleActions({ path }: { path: string | null }) {
  useWhenContext();
  useExtensionHost((s) => s.status);
  const contributions = useContributions();
  if (!path || useExtensionHost.getState().status !== "running") return null;
  const isFile = !isVirtualTab(path);
  const model = isFile ? getModel(path) : null;
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const context = {
    resourceScheme: isFile ? "file" : parseWebviewTab(path) ? "webview-panel" : "untitled",
    resourceFilename: name,
    resourceExtname: dot > 0 ? name.slice(dot) : "",
    resourcePath: isFile ? path : undefined,
    resourceLangId: model?.getLanguageId(),
    editorLangId: model?.getLanguageId(),
    activeEditor: isFile ? "workbench.editors.files.textFileEditor" : parseWebviewTab(path) ? "WebviewEditor" : undefined,
    textInputFocus: false,
    editorTextFocus: false,
  };
  const { inline, other } = menuItems(contributions, "editor/title", (when) => isTrue(when, context));
  const args = isFile ? [{ $uri: monaco.Uri.file(path).toString() }] : [];
  if (inline.length === 0 && other.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
      {inline.map((item) => (
        <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
      ))}
      <MoreActions entries={menuEntries(contributions, other, args)} />
    </div>
  );
}
