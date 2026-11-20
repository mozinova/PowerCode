//! The Hierarchy tool window: callers or callees of a function, supertypes or
//! subtypes of a type, from the language's extension (see exthost/hierarchy.ts).

import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  Component,
  Loader2,
  Minus,
  PhoneIncoming,
  PhoneOutgoing,
  SquareFunction,
  Variable,
  type LucideIcon,
} from "lucide-react";
import { openCall, openNode, setDirection, toggleNode, useHierarchy, type HierarchyNode } from "../exthost/hierarchy";
import { useWorkspace } from "../state/workspace";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";

/** An icon and colour for a `vscode.SymbolKind`. */
function symbolIcon(kind: number): [LucideIcon, string] {
  if (kind === 5 || kind === 8 || kind === 11) return [SquareFunction, "#b189f5"];
  if (kind === 4 || kind === 22 || kind === 9) return [Box, "#e5865b"];
  if (kind === 10 || kind === 25) return [Component, "#6aab73"];
  if (kind === 6 || kind === 7 || kind === 12 || kind === 13 || kind === 21) return [Variable, "#56a8f5"];
  return [Braces, "#9aa0a6"];
}

function Row({ node, parent, depth }: { node: HierarchyNode; parent: HierarchyNode | null; depth: number }) {
  const expanded = useHierarchy((s) => s.expanded.has(node.key));
  const kind = useHierarchy((s) => s.kind);
  const [Icon, color] = symbolIcon(node.item.kind);
  // A child list that came back empty: nothing to expand.
  const leaf = node.children !== null && node.children.length === 0;
  const calls = kind === "call" && node.ranges.length > 1 ? `${node.ranges.length} calls` : "";

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={leaf ? undefined : expanded}
        {...tooltipProps(node.item.detail ? `${node.item.name} — ${node.item.detail}` : node.item.name)}
        onClick={() => (kind === "call" && parent ? openCall(node, parent) : openNode(node))}
        onDoubleClick={() => !leaf && toggleNode(node)}
        style={{ paddingLeft: 6 + depth * 14 }}
        className="flex h-[26px] cursor-default items-center gap-1.5 pr-2 hover:bg-hover"
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            if (!leaf) toggleNode(node);
          }}
          className="flex w-4 shrink-0 justify-center text-fg-muted"
        >
          {node.loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : leaf ? null : expanded ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
        </button>
        <Icon size={15} strokeWidth={1.75} className="shrink-0" style={{ color }} />
        <span className={`min-w-0 truncate ${node.item.deprecated ? "line-through" : ""}`}>{node.item.name}</span>
        {node.item.detail && <span className="min-w-0 shrink truncate text-xs text-fg-subtle">{node.item.detail}</span>}
        {calls && <span className="shrink-0 text-xs text-fg-subtle">· {calls}</span>}
      </div>
      {expanded && node.children?.map((child) => <Row key={child.key} node={child} parent={node} depth={depth + 1} />)}
    </>
  );
}

export function HierarchyView() {
  const kind = useHierarchy((s) => s.kind);
  const direction = useHierarchy((s) => s.direction);
  const roots = useHierarchy((s) => s.roots);
  const toggleTool = useWorkspace((s) => s.toggleTool);

  const title = kind === "type" ? "Type Hierarchy" : kind === "call" ? "Call Hierarchy" : "Hierarchy";
  const directions =
    kind === "type"
      ? ([
          ["supertypes", ArrowUpNarrowWide, "Supertypes"],
          ["subtypes", ArrowDownNarrowWide, "Subtypes"],
        ] as const)
      : ([
          ["incoming", PhoneIncoming, "Callers"],
          ["outgoing", PhoneOutgoing, "Callees"],
        ] as const);

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title={title}>
        {kind &&
          directions.map(([id, icon, label]) => (
            <IconButton key={id} icon={icon} title={label} active={direction === id} onClick={() => setDirection(id)} className="size-7" size={14} />
          ))}
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("hierarchy")} className="size-7" />
      </ToolWindowHeader>
      <div role="tree" className="min-h-0 flex-1 overflow-auto pb-2">
        {roots.length === 0 && (
          <p className="px-3 text-fg-muted">
            Place the cursor on a function or type and choose Show Call Hierarchy (Shift+Alt+H) or Show Type Hierarchy.
          </p>
        )}
        {roots.map((root) => (
          <Row key={root.key} node={root} parent={null} depth={0} />
        ))}
      </div>
    </div>
  );
}
