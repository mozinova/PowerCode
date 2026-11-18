//! Extensions' custom editors (`contributes.customEditors`): which files they
//! open, the tabs showing them and those tabs' webviews.

import { create } from "zustand";
import { getModel, saveModel } from "../editor/models";
import { monaco } from "../editor/monaco";
import { basename } from "../lib/paths";
import { customEditorTabPath, parseCustomEditorTab } from "../lib/virtualTabs";
import { openPaths, useWorkspace } from "../state/workspace";
import type { CustomEditorInfo } from "./contributions";
import * as rpc from "./rpc";
import { pathFromUri } from "./languages";
import { contributions } from "./views";
import { disposeWebview } from "./webviews";

interface CustomEditorsState {
  /** View types whose provider the host has registered. */
  registered: Record<string, true>;
  /** The webview of each custom editor tab, and what kind of document it edits. */
  tabs: Record<string, { id: string; kind: "text" | "editable" | "readonly" }>;
}

export const useCustomEditors = create<CustomEditorsState>(() => ({ registered: {}, tabs: {} }));

/** A glob as VS Code's `filenamePattern`: `*`, `**`, `?` and `{a,b}`; matched case-insensitively. */
function globRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") source += "(?:";
    else if (ch === "}") source += ")";
    else if (ch === ",") source += "|";
    else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

export function matchesFilenamePattern(pattern: string, path: string): boolean {
  const posix = path.replace(/\\/g, "/");
  // Patterns without a folder part apply to the file name, wherever the file is.
  const subject = pattern.includes("/") ? posix : basename(posix);
  return globRegExp(pattern).test(subject) || (pattern.includes("/") && globRegExp(pattern).test(basename(posix)));
}

/** Custom editors that can open `path`. */
export function customEditorsFor(path: string): CustomEditorInfo[] {
  return contributions().customEditors.filter((e) => e.patterns.some((p) => matchesFilenamePattern(p, path)));
}

/** The tab to open `path` in: a `default`-priority custom editor's, or the file itself. */
export function defaultTabFor(path: string): string {
  const editor = customEditorsFor(path).find((e) => e.priority === "default");
  return editor ? customEditorTabPath(editor.viewType, path) : path;
}

const resolving = new Set<string>();

/** Has the host create the webview of a custom editor tab (once its provider is registered). */
export async function resolveCustomEditorTab(tabPath: string) {
  const tab = parseCustomEditorTab(tabPath);
  if (!tab || useCustomEditors.getState().tabs[tabPath] || resolving.has(tabPath)) return;
  resolving.add(tabPath);
  try {
    const result = await rpc.request<{ id: string; kind: "text" | "editable" | "readonly" } | null>("customEditors/resolve", {
      viewType: tab.viewType,
      uri: monaco.Uri.file(tab.path).toString(),
      title: basename(tab.path),
    });
    if (result) useCustomEditors.setState(({ tabs }) => ({ tabs: { ...tabs, [tabPath]: result } }));
  } finally {
    resolving.delete(tabPath);
  }
}

/** Saves what a custom editor tab edits: its text file, or its custom document through the provider. */
export async function saveCustomEditorTab(tabPath: string) {
  const tab = parseCustomEditorTab(tabPath);
  if (!tab) return;
  const kind = useCustomEditors.getState().tabs[tabPath]?.kind;
  if (kind === "editable") {
    await rpc.request("customEditors/save", { viewType: tab.viewType, uri: monaco.Uri.file(tab.path).toString() });
  } else if (getModel(tab.path)) {
    await saveModel(tab.path);
  }
}

/** Forgets every tab's webview (the host restarted); open tabs resolve again. */
export function resetCustomEditors() {
  useCustomEditors.setState({ registered: {}, tabs: {} });
}

function setTabsDirty(path: string, dirty: boolean) {
  const { groups, setDirty } = useWorkspace.getState();
  for (const tab of groups.flatMap((g) => g.tabs)) {
    if (parseCustomEditorTab(tab.path)?.path === path) setDirty(tab.path, dirty);
  }
}

export function registerCustomEditorHandlers() {
  rpc.onNotification("customEditors/register", ({ viewType }) =>
    useCustomEditors.setState(({ registered }) => ({ registered: { ...registered, [viewType]: true } })),
  );
  rpc.onNotification("customEditors/unregister", ({ viewType }) =>
    useCustomEditors.setState(({ registered }) => {
      const { [viewType]: _gone, ...rest } = registered;
      return { registered: rest };
    }),
  );
  // The host may spell the URI differently (`c%3A`); `pathFromUri` gives the app's form of the path.
  rpc.onNotification("customEditors/dirty", ({ uri, dirty }) => setTabsDirty(pathFromUri(uri), dirty));

  useWorkspace.subscribe((s, previous) => {
    if (s.groups === previous.groups) return;
    const open = openPaths(s);
    const { tabs } = useCustomEditors.getState();
    // Closing a custom editor's last tab disposes its webview (and, for the last editor, its document).
    for (const [tabPath, { id }] of Object.entries(tabs)) {
      if (open.has(tabPath)) continue;
      rpc.notify("webview/disposed", { id });
      disposeWebview(id);
      useCustomEditors.setState(({ tabs: current }) => {
        const { [tabPath]: _closed, ...rest } = current;
        return { tabs: rest };
      });
    }
  });
}
