//! Call and type hierarchies from extensions (`registerCallHierarchyProvider`,
//! `registerTypeHierarchyProvider`), shown in the Hierarchy tool window: the
//! callers or callees of a function, the supertypes or subtypes of a type.
//! Items stay in the extension host; nodes are expanded by asking it again.

import { create } from "zustand";
import { monaco } from "../editor/monaco";
import { notify } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { featureProviders, pathFromUri, provideFeature, provideForItem } from "./languages";

interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface HierarchyItem {
  id: number;
  name: string;
  /** `vscode.SymbolKind`. */
  kind: number;
  detail?: string;
  uri: string;
  range: RangeDto;
  selectionRange: RangeDto;
  deprecated?: boolean;
}

export interface HierarchyNode {
  key: string;
  /** The provider that gave the item (expanding asks it). */
  handle: number;
  item: HierarchyItem;
  /** Where the call happens (calls only): in the caller for incoming, in this item for outgoing. */
  ranges: RangeDto[];
  /** Loaded children; null until expanded. */
  children: HierarchyNode[] | null;
  loading: boolean;
}

export type HierarchyKind = "call" | "type";
export type HierarchyDirection = "incoming" | "outgoing" | "supertypes" | "subtypes";

interface HierarchyState {
  kind: HierarchyKind | null;
  direction: HierarchyDirection;
  roots: HierarchyNode[];
  expanded: Set<string>;
  /** The symbol the hierarchy is for. */
  title: string;
}

export const useHierarchy = create<HierarchyState>(() => ({
  kind: null,
  direction: "incoming",
  roots: [],
  expanded: new Set(),
  title: "",
}));

let nextKey = 1;

const node = (handle: number, item: HierarchyItem, ranges: RangeDto[] = []): HierarchyNode => ({
  key: String(nextKey++),
  handle,
  item,
  ranges,
  children: null,
  loading: false,
});

const PROVIDER_KIND: Record<HierarchyKind, string> = { call: "callHierarchy", type: "typeHierarchy" };

/** Whether `model`'s language has providers for `kind` (menus enable the command on it). */
export function hasHierarchy(kind: HierarchyKind, model: monaco.editor.ITextModel | null | undefined): boolean {
  return !!model && featureProviders(PROVIDER_KIND[kind], model.getLanguageId()).length > 0;
}

function update(key: string, change: (n: HierarchyNode) => HierarchyNode) {
  const visit = (nodes: HierarchyNode[]): HierarchyNode[] =>
    nodes.map((n) => (n.key === key ? change(n) : n.children ? { ...n, children: visit(n.children) } : n));
  useHierarchy.setState((s) => ({ roots: visit(s.roots) }));
}

/** Loads a node's children in the current direction. */
async function load(target: HierarchyNode) {
  const { direction } = useHierarchy.getState();
  const method = { incoming: "incomingCalls", outgoing: "outgoingCalls", supertypes: "supertypes", subtypes: "subtypes" }[direction];
  update(target.key, (n) => ({ ...n, loading: true }));
  const related = await provideForItem<{ item: HierarchyItem; ranges: RangeDto[] }[]>(target.handle, method, target.item.id).catch(() => []);
  // The direction changed meanwhile: these children belong to the other one.
  if (useHierarchy.getState().direction !== direction) return;
  update(target.key, (n) => ({ ...n, loading: false, children: (related ?? []).map((r) => node(target.handle, r.item, r.ranges)) }));
}

export function toggleNode(target: HierarchyNode) {
  const { expanded } = useHierarchy.getState();
  const next = new Set(expanded);
  if (next.has(target.key)) {
    next.delete(target.key);
  } else {
    next.add(target.key);
    if (target.children === null && !target.loading) void load(target);
  }
  useHierarchy.setState({ expanded: next });
}

/** Shows the other direction (callers ↔ callees, supertypes ↔ subtypes) for the same roots. */
export function setDirection(direction: HierarchyDirection) {
  const { roots, direction: current } = useHierarchy.getState();
  if (direction === current) return;
  const fresh = roots.map((r) => node(r.handle, r.item));
  useHierarchy.setState({ direction, roots: fresh, expanded: new Set(fresh.map((r) => r.key)) });
  fresh.forEach((r) => void load(r));
}

/** Shows the call or type hierarchy of the symbol at the cursor of `editor`. */
export async function showHierarchy(kind: HierarchyKind, editor: monaco.editor.ICodeEditor | null | undefined) {
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!model || !position) return;
  const providers = featureProviders(PROVIDER_KIND[kind], model.getLanguageId());
  const label = kind === "call" ? "call" : "type";
  if (providers.length === 0) {
    notify("info", `No ${label} hierarchy for ${model.getLanguageId()} files`, "An extension for the language provides it.");
    return;
  }
  const method = kind === "call" ? "prepareCallHierarchy" : "prepareTypeHierarchy";
  const results = await Promise.all(
    providers.map((p) =>
      provideFeature<HierarchyItem[] | null>(p.handle, method, model, { position: { line: position.lineNumber - 1, character: position.column - 1 } })
        .then((items) => (items ?? []).map((item) => node(p.handle, item)))
        .catch(() => []),
    ),
  );
  const roots = results.flat();
  if (roots.length === 0) {
    notify("info", `No ${label} hierarchy here`, "Place the cursor on a symbol.");
    return;
  }
  const direction: HierarchyDirection = kind === "call" ? "incoming" : "subtypes";
  useHierarchy.setState({ kind, direction, roots, expanded: new Set(roots.map((r) => r.key)), title: roots[0].item.name });
  roots.forEach((r) => void load(r));
  useWorkspace.getState().showTool("hierarchy");
}

function openAt(uri: string, range: RangeDto) {
  if (!/^(file|ssh):/.test(uri)) return;
  useWorkspace
    .getState()
    .openFileAt(pathFromUri(uri), range.start.line + 1, range.start.character + 1, range.end.character + 1, range.end.line + 1);
}

/** Opens a node's symbol. */
export function openNode(target: HierarchyNode) {
  openAt(target.item.uri, target.item.selectionRange);
}

/**
 * Opens where a call happens: an incoming call is in the caller (`target`), an
 * outgoing one in the function that makes it (`parent`).
 */
export function openCall(target: HierarchyNode, parent: HierarchyNode | null) {
  const { direction } = useHierarchy.getState();
  const range = target.ranges[0];
  if (!range) return openNode(target);
  if (direction === "incoming") openAt(target.item.uri, range);
  else if (parent) openAt(parent.item.uri, range);
}

/** Forgets the hierarchy (the extension host restarted: its items are gone). */
export function resetHierarchy() {
  useHierarchy.setState({ kind: null, roots: [], expanded: new Set(), title: "" });
}
