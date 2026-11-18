import { Blocks, Folder, GitCommitHorizontal, ScrollText, Search, Server, SquareTerminal, type LucideIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { create } from "zustand";
import { useViews } from "../exthost/views";
import { useGit } from "../git/store";
import { arrange, moveTool, useToolLayout, type Side } from "../state/toolLayout";
import { useWorkspace, type ToolId } from "../state/workspace";
import { ExtIcon } from "./ExtIcon";
import { useVisibleContainers } from "./ExtensionViews";
import { tooltipProps } from "./Tooltip";
import { IconButton } from "./ui";

/** A stripe entry: a tool window that can sit in either sidebar. */
interface ToolEntry {
  id: ToolId;
  title: string;
  shortcut?: string;
  icon: (size: number) => ReactNode;
  badge: number;
}

const lucide = (Icon: LucideIcon) => (size: number) => <Icon size={size} strokeWidth={1.75} />;

/** Every tool window, built-in first, then extensions' view containers. */
function useToolEntries(): ToolEntry[] {
  // Changed files to commit, as VS Code's Source Control badge counts them.
  const changeCount = useGit((s) => s.status?.files.filter((f) => !f.ignored).length ?? 0);
  const containers = useVisibleContainers();
  const info = useViews((s) => s.info);
  return [
    { id: "project", title: "Project", shortcut: "Alt+1", icon: lucide(Folder), badge: 0 },
    { id: "commit", title: "Commit", shortcut: "Alt+0", icon: lucide(GitCommitHorizontal), badge: changeCount },
    { id: "search", title: "Find in Files", shortcut: "Ctrl+Shift+F", icon: lucide(Search), badge: 0 },
    { id: "remote", title: "Remote Hosts", icon: lucide(Server), badge: 0 },
    { id: "extensions", title: "Extensions", shortcut: "Alt+2", icon: lucide(Blocks), badge: 0 },
    ...containers.map((c) => ({
      id: c.tool,
      title: c.title,
      icon: (size: number) => <ExtIcon icon={c.icon} mono size={size} />,
      badge: c.views.reduce((sum, v) => sum + (info[v.id]?.badge ?? 0), 0),
    })),
  ];
}

// ---- Dragging ------------------------------------------------------------------------

interface DragState {
  /** The entry being dragged, once the pointer moved far enough to count as a drag. */
  id: ToolId | null;
  x: number;
  y: number;
  /** Where it would drop: a stripe and a position in it. */
  target: { side: Side; index: number } | null;
}

const useToolDrag = create<DragState>(() => ({ id: null, x: 0, y: 0, target: null }));

/** Pixels the pointer must travel before a press becomes a drag (below that it is a click). */
const DRAG_THRESHOLD = 4;
/** How far outside a stripe a drop still lands in it. */
const STRIPE_SLACK = 32;

/** The stripe and position under the pointer, from the entries' positions on screen. */
function dropTarget(x: number, y: number, dragged: ToolId): DragState["target"] {
  for (const nav of document.querySelectorAll<HTMLElement>("[data-tool-stripe]")) {
    const rect = nav.getBoundingClientRect();
    if (x < rect.left - STRIPE_SLACK || x > rect.right + STRIPE_SLACK || y < rect.top || y > rect.bottom) continue;
    const entries = [...nav.querySelectorAll<HTMLElement>("[data-tool-entry]")].filter((e) => e.dataset.toolEntry !== dragged);
    const index = entries.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.top + r.height / 2 < y;
    }).length;
    return { side: nav.dataset.toolStripe as Side, index };
  }
  return null;
}

/** Visible entries of both stripes, in their displayed order. */
function shownOrder(): Record<Side, string[]> {
  const order = (side: Side) =>
    [...document.querySelectorAll<HTMLElement>(`[data-tool-stripe="${side}"] [data-tool-entry]`)].map((e) => e.dataset.toolEntry!);
  return { left: order("left"), right: order("right") };
}

function EntryButton({ entry, side, active }: { entry: ToolEntry; side: Side; active: boolean }) {
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const dragging = useToolDrag((s) => s.id === entry.id);
  // A press that turned into a drag must not also toggle the tool when released.
  const draggedRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const button = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    // Captured, so moves keep coming even over webviews and other stripes.
    button.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!draggedRef.current) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        draggedRef.current = true;
      }
      useToolDrag.setState({ id: entry.id, x: ev.clientX, y: ev.clientY, target: dropTarget(ev.clientX, ev.clientY, entry.id) });
    };
    const up = () => {
      button.removeEventListener("pointermove", move);
      button.removeEventListener("pointerup", up);
      button.removeEventListener("pointercancel", up);
      const { target } = useToolDrag.getState();
      if (draggedRef.current && target) {
        moveTool(entry.id, target.side, target.index, shownOrder());
        useWorkspace.getState().placeTool(entry.id, target.side);
      }
      useToolDrag.setState({ id: null, target: null });
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("pointerup", up);
    button.addEventListener("pointercancel", up);
  };

  return (
    <button
      type="button"
      data-tool-entry={entry.id}
      {...tooltipProps(entry.title, entry.shortcut, side === "left" ? "right" : "left")}
      aria-label={entry.title}
      aria-pressed={active}
      onPointerDown={onPointerDown}
      onClick={() => {
        if (!draggedRef.current) toggleTool(entry.id);
        draggedRef.current = false;
      }}
      className={`relative flex size-9 shrink-0 touch-none items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${
        active ? "bg-selected-inactive text-fg" : ""
      } ${dragging ? "opacity-30" : ""}`}
    >
      {entry.icon(22)}
      {entry.badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white">
          {entry.badge > 99 ? "99+" : entry.badge}
        </span>
      )}
    </button>
  );
}

/** Where a dragged entry would land. */
function DropIndicator() {
  return <div aria-hidden className="h-0.5 w-8 shrink-0 rounded-full bg-accent" />;
}

/** The dragged entry's icon, following the pointer. */
function DragGhost({ entries }: { entries: ToolEntry[] }) {
  const { id, x, y } = useToolDrag();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-[1100] flex size-9 items-center justify-center rounded-md bg-selected-inactive text-fg shadow-lg shadow-black/40"
      style={{ left: x - 18, top: y - 18 }}
    >
      {entry.icon(22)}
    </div>
  );
}

/**
 * A sidebar's stripe of tool window entries. Entries can be dragged to reorder
 * them or move them to the other sidebar; `footer` sits at the bottom (fixed).
 */
export function ToolStripe({ side, footer }: { side: Side; footer?: ReactNode }) {
  const entries = useToolEntries();
  const layout = useToolLayout();
  const open = useWorkspace((s) => (side === "left" ? s.leftTool : s.rightTool));
  const target = useToolDrag((s) => (s.target?.side === side ? s.target.index : null));
  const draggingId = useToolDrag((s) => s.id);

  const byId = new Map(entries.map((e) => [e.id, e]));
  const ordered = arrange(entries.map((e) => e.id), side, layout).map((id) => byId.get(id as ToolId)!);
  // The dragged entry stays in place (dimmed); the indicator's index counts the others.
  const others = ordered.filter((e) => e.id !== draggingId);
  const items: ReactNode[] = [];
  let shown = 0;
  for (const entry of ordered) {
    if (entry.id !== draggingId) {
      if (target === shown) items.push(<DropIndicator key="drop" />);
      shown++;
    }
    items.push(<EntryButton key={entry.id} entry={entry} side={side} active={open === entry.id} />);
  }
  if (target !== null && target >= others.length) items.push(<DropIndicator key="drop" />);

  return (
    <nav
      aria-label={side === "left" ? "Tool windows" : "Right tool windows"}
      data-tool-stripe={side}
      className="flex w-12 shrink-0 flex-col items-center gap-1.5 py-1"
    >
      {items}
      <div className="flex-1" />
      {footer}
      {side === "left" && <DragGhost entries={entries} />}
    </nav>
  );
}

/** The bottom tool windows' buttons, at the foot of the left stripe. */
export function BottomToolButtons() {
  const bottomTool = useWorkspace((s) => s.bottomTool);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  return (
    <>
      <IconButton
        icon={ScrollText}
        title="Output"
        tooltipSide="right"
        active={bottomTool === "output"}
        onClick={() => toggleBottomTool("output")}
        className="size-9"
        size={22}
      />
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
    </>
  );
}
