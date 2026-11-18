//! State of extensions' views on the UI side: which views the host has
//! registered, tree contents loaded so far, and the context `when` clauses
//! are evaluated against.

import { create } from "zustand";
import { useExtensions } from "../extensions/runtime";
import { IS_WINDOWS } from "../lib/platform";
import { setRightDefaults } from "../state/toolLayout";
import { useWorkspace } from "../state/workspace";
import { readContributions, type Contributions } from "./contributions";
import * as rpc from "./rpc";
import { evaluateWhen, useContextKeys } from "./when";

export interface TreeNode {
  handle: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: { themeIcon: string; color?: string } | { uri: string } | { localPath: string };
  resourceUri?: string;
  /** 0 none, 1 collapsed, 2 expanded (`TreeItemCollapsibleState`). */
  collapsible: number;
  contextValue?: string;
  hasCommand: boolean;
}

export interface TreeModel {
  /** Children by parent handle; `""` is the root. Absent means not loaded. */
  children: Record<string, TreeNode[]>;
  /** Expansion the user chose; nodes not listed follow their collapsible state. */
  expanded: Record<string, boolean>;
  selected: string | null;
  error?: string;
}

export interface ViewInfo {
  message?: string;
  title?: string;
  description?: string;
  badge?: number;
}

interface ViewsState {
  /** Views the host provides, by id: trees and webview views. */
  registered: Record<string, { kind: "tree"; showCollapseAll: boolean } | { kind: "webview" }>;
  info: Record<string, ViewInfo>;
  trees: Record<string, TreeModel>;
  /** The webview of each resolved webview view; kept while hidden, like `retainContextWhenHidden`. */
  webviews: Record<string, string>;
}

export const useViews = create<ViewsState>(() => ({ registered: {}, info: {}, trees: {}, webviews: {} }));

export const ROOT = "";

export function resetViews() {
  useViews.setState({ registered: {}, info: {}, trees: {}, webviews: {} });
}

const resolving = new Set<string>();

/** Has the host create the webview of a webview view, once. */
export async function resolveWebviewView(viewId: string) {
  if (useViews.getState().webviews[viewId] || resolving.has(viewId)) return;
  resolving.add(viewId);
  try {
    const result = await rpc.request<{ id: string } | null>("views/resolveWebview", { viewId });
    if (result) useViews.setState(({ webviews }) => ({ webviews: { ...webviews, [viewId]: result.id } }));
  } finally {
    resolving.delete(viewId);
  }
}

function setTree(viewId: string, change: (tree: TreeModel) => Partial<TreeModel>) {
  useViews.setState(({ trees }) => {
    const tree = trees[viewId] ?? { children: {}, expanded: {}, selected: null };
    return { trees: { ...trees, [viewId]: { ...tree, ...change(tree) } } };
  });
}

const loading = new Set<string>();

export async function loadChildren(viewId: string, handle: string) {
  const key = `${viewId}\u0000${handle}`;
  if (loading.has(key)) return;
  loading.add(key);
  try {
    const nodes = await rpc.request<TreeNode[] | null>("views/children", { viewId, handle: handle === ROOT ? null : handle });
    setTree(viewId, (tree) => ({ children: { ...tree.children, [handle]: nodes ?? [] }, error: undefined }));
  } catch (e) {
    setTree(viewId, () => ({ error: e instanceof Error ? e.message : String(e) }));
  } finally {
    loading.delete(key);
  }
}

export function isExpanded(tree: TreeModel | undefined, node: TreeNode): boolean {
  return node.collapsible !== 0 && (tree?.expanded[node.handle] ?? node.collapsible === 2);
}

export function setExpanded(viewId: string, node: TreeNode, expanded: boolean) {
  setTree(viewId, (tree) => ({ expanded: { ...tree.expanded, [node.handle]: expanded } }));
  rpc.notify("views/expanded", { viewId, handle: node.handle, expanded });
}

export function collapseAll(viewId: string) {
  setTree(viewId, (tree) => ({
    expanded: Object.fromEntries(Object.values(tree.children).flat().map((n) => [n.handle, false])),
  }));
}

export function select(viewId: string, handle: string) {
  setTree(viewId, () => ({ selected: handle }));
  rpc.notify("views/selection", { viewId, handles: [handle] });
}

/** Reloads every loaded level of a tree (labels of refreshed elements live in their parent's list). */
function refresh(viewId: string) {
  const tree = useViews.getState().trees[viewId];
  const loaded = tree ? Object.keys(tree.children) : [];
  setTree(viewId, (t) => ({ children: Object.fromEntries(Object.entries(t.children).filter(([k]) => k === ROOT)) }));
  for (const handle of loaded.length ? loaded : [ROOT]) void loadChildren(viewId, handle);
}

// ---- Context for `when` clauses ---------------------------------------------------------

let settings: Record<string, unknown> = {};
let defaults: Record<string, unknown> = {};

export function setConfigurationContext(nextSettings: Record<string, unknown>, nextDefaults?: Record<string, unknown>) {
  settings = nextSettings;
  if (nextDefaults) defaults = nextDefaults;
  // Re-render what depends on the context.
  useContextKeys.setState(({ keys }) => ({ keys: { ...keys } }));
}

/** The keys a `when` clause can read, plus `extra` (e.g. `view`, `viewItem`). */
export function whenContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { root } = useWorkspace.getState();
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...defaults, ...settings })) config[`config.${key}`] = value;
  return {
    isWindows: IS_WINDOWS,
    isMac: navigator.userAgent.includes("Mac"),
    isLinux: !IS_WINDOWS && !navigator.userAgent.includes("Mac"),
    isWeb: false,
    workspaceFolderCount: root ? 1 : 0,
    workbenchState: root ? "folder" : "empty",
    ...config,
    ...useContextKeys.getState().keys,
    ...extra,
  };
}

export function isTrue(when: string | undefined, extra?: Record<string, unknown>): boolean {
  return evaluateWhen(when, whenContext(extra));
}

// ---- Contributions --------------------------------------------------------------------

let cached: { installed: unknown; contributions: Contributions } | null = null;

/** Contributions of the installed extensions, recomputed when that list changes. */
export function contributions(): Contributions {
  const installed = useExtensions.getState().installed;
  if (cached?.installed !== installed) {
    cached = { installed, contributions: readContributions(installed) };
    setRightDefaults(cached.contributions.containers.filter((c) => c.defaultSide === "right").map((c) => c.tool));
  }
  return cached.contributions;
}

export function useContributions(): Contributions {
  useExtensions((s) => s.installed);
  return contributions();
}

// ---- Messages from the host --------------------------------------------------------------

/** Called by the host module: wires notifications about views. */
export function registerViewHandlers(onShow: (viewId: string) => void, onWebviewGone: (id: string) => void) {
  rpc.onNotification("views/registerTree", ({ viewId, showCollapseAll }) =>
    useViews.setState(({ registered }) => ({ registered: { ...registered, [viewId]: { kind: "tree", showCollapseAll } } })),
  );
  rpc.onNotification("views/registerWebview", ({ viewId }) =>
    useViews.setState(({ registered }) => ({ registered: { ...registered, [viewId]: { kind: "webview" } } })),
  );
  rpc.onNotification("views/unregister", ({ viewId }) =>
    useViews.setState(({ registered, trees, webviews }) => {
      const { [viewId]: _view, ...rest } = registered;
      const { [viewId]: _tree, ...otherTrees } = trees;
      const { [viewId]: webview, ...otherWebviews } = webviews;
      if (webview) onWebviewGone(webview);
      return { registered: rest, trees: otherTrees, webviews: otherWebviews };
    }),
  );
  rpc.onNotification("views/refresh", ({ viewId }) => refresh(viewId));
  rpc.onNotification("views/update", ({ viewId, ...info }) =>
    useViews.setState(({ info: all }) => ({ info: { ...all, [viewId]: info } })),
  );
  rpc.onNotification("views/reveal", async ({ viewId, handles, select: shouldSelect, expand }) => {
    onShow(viewId);
    // Expand the ancestors, loading each level, then select the element.
    for (const handle of [ROOT, ...handles.slice(0, -1)]) {
      if (handle !== ROOT) setTree(viewId, (tree) => ({ expanded: { ...tree.expanded, [handle]: true } }));
      if (!useViews.getState().trees[viewId]?.children[handle]) await loadChildren(viewId, handle);
    }
    const target = handles[handles.length - 1];
    if (target && expand) setTree(viewId, (tree) => ({ expanded: { ...tree.expanded, [target]: true } }));
    if (target && shouldSelect) select(viewId, target);
  });
  rpc.onNotification("views/show", ({ viewId }) => onShow(viewId));
}
