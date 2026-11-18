//! Tree views and webviews: `window.createTreeView`, `registerTreeDataProvider`,
//! `createWebviewPanel` and `registerWebviewViewProvider`. The UI renders them
//! and asks for tree children; webview HTML and messages travel as notifications.

import * as path from "node:path";
import { executeCommand } from "./api";
import * as rpc from "./rpc";
import { host } from "./state";
import { CancellationTokenSource, Disposable, EventEmitter, MarkdownString, ThemeColor, ThemeIcon, Uri } from "./types";

// ---- Icons ----------------------------------------------------------------------

/** `iconPath` values: a Uri, a path, `{ light, dark }` or a ThemeIcon. */
export function iconDto(icon: any): { themeIcon: string; color?: string } | { uri: string } | undefined {
  if (!icon) return undefined;
  if (icon instanceof ThemeIcon || (typeof icon.id === "string" && !Uri.isUri(icon))) {
    const color = icon.color instanceof ThemeColor ? icon.color.id : icon.color?.id;
    return { themeIcon: icon.id, color };
  }
  if (typeof icon === "string") return { uri: Uri.file(icon).toString() };
  if (Uri.isUri(icon)) return { uri: icon.toString() };
  if (icon.dark) return iconDto(icon.dark);
  return undefined;
}

// ---- Tree views -------------------------------------------------------------------

interface Tree {
  viewId: string;
  provider: any;
  /** Elements and their tree items by handle, and handles by element. */
  elements: Map<string, unknown>;
  items: Map<string, any>;
  handles: Map<unknown, string>;
  nextHandle: number;
  view: any;
  onDidChangeSelection: EventEmitter<any>;
  onDidChangeVisibility: EventEmitter<any>;
  onDidExpandElement: EventEmitter<any>;
  onDidCollapseElement: EventEmitter<any>;
}

const trees = new Map<string, Tree>();

function handleOf(tree: Tree, element: unknown, item: any): string {
  // A tree item id keeps the handle (and the UI's expansion state) stable across refreshes.
  if (item?.id) {
    const handle = `id:${item.id}`;
    tree.handles.set(element, handle);
    return handle;
  }
  let handle = tree.handles.get(element);
  if (!handle) {
    handle = `h:${tree.nextHandle++}`;
    tree.handles.set(element, handle);
  }
  return handle;
}

function labelOf(item: any): string {
  const label = typeof item.label === "string" ? item.label : item.label?.label;
  if (label !== undefined) return label;
  return item.resourceUri ? path.basename(item.resourceUri.fsPath) : "";
}

function tooltipOf(tooltip: unknown): string | undefined {
  if (tooltip instanceof MarkdownString) return tooltip.value;
  return typeof tooltip === "string" ? tooltip : undefined;
}

export function registerTree(viewId: string, options: any): any {
  const provider = options.treeDataProvider;
  const onDidChangeSelection = new EventEmitter<any>();
  const onDidChangeVisibility = new EventEmitter<any>();
  const onDidExpandElement = new EventEmitter<any>();
  const onDidCollapseElement = new EventEmitter<any>();
  const state = { visible: false, selection: [] as unknown[], message: undefined as string | undefined, title: undefined as string | undefined, description: undefined as string | undefined, badge: undefined as unknown };
  const update = () =>
    rpc.notify("views/update", {
      viewId,
      message: state.message,
      title: state.title,
      description: state.description,
      badge: (state.badge as any)?.value,
    });

  const subscription = provider.onDidChangeTreeData?.((changed: unknown) => {
    const elements = changed === undefined || changed === null ? [] : Array.isArray(changed) ? changed : [changed];
    const handles = elements.map((e) => tree.handles.get(e)).filter((h) => h !== undefined);
    // An element the UI never saw cannot be refreshed alone: refresh everything.
    rpc.notify("views/refresh", { viewId, handles: elements.length === 0 || handles.length < elements.length ? null : handles });
  });

  const view = {
    get visible() {
      return state.visible;
    },
    get selection() {
      return state.selection;
    },
    get message() {
      return state.message;
    },
    set message(value: string | undefined) {
      state.message = value;
      update();
    },
    get title() {
      return state.title;
    },
    set title(value: string | undefined) {
      state.title = value;
      update();
    },
    get description() {
      return state.description;
    },
    set description(value: string | undefined) {
      state.description = value;
      update();
    },
    get badge() {
      return state.badge;
    },
    set badge(value: unknown) {
      state.badge = value;
      update();
    },
    onDidChangeSelection: onDidChangeSelection.event,
    onDidChangeVisibility: onDidChangeVisibility.event,
    onDidExpandElement: onDidExpandElement.event,
    onDidCollapseElement: onDidCollapseElement.event,
    onDidChangeCheckboxState: new EventEmitter<any>().event,
    async reveal(element: unknown, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }) {
      // Ancestors come from `getParent`, so the UI can expand down to the element.
      const chain: string[] = [];
      let current: unknown = element;
      for (let depth = 0; current !== undefined && current !== null && depth < 64; depth++) {
        const item = await provider.getTreeItem(current);
        chain.unshift(handleOf(tree, current, item));
        tree.elements.set(chain[0], current);
        current = provider.getParent ? await provider.getParent(current) : undefined;
      }
      rpc.notify("views/reveal", { viewId, handles: chain, select: options?.select !== false, expand: options?.expand ?? false });
    },
    dispose() {
      subscription?.dispose?.();
      trees.delete(viewId);
      rpc.notify("views/unregister", { viewId });
    },
  };

  const tree: Tree = {
    viewId,
    provider,
    elements: new Map(),
    items: new Map(),
    handles: new Map(),
    nextHandle: 1,
    view,
    onDidChangeSelection,
    onDidChangeVisibility,
    onDidExpandElement,
    onDidCollapseElement,
  };
  (tree as any).state = state;
  trees.set(viewId, tree);
  rpc.notify("views/registerTree", {
    viewId,
    showCollapseAll: options.showCollapseAll ?? false,
    canSelectMany: options.canSelectMany ?? false,
  });
  return view;
}

async function children(params: { viewId: string; handle: string | null }) {
  const tree = trees.get(params.viewId);
  if (!tree) return null;
  const parent = params.handle === null ? undefined : tree.elements.get(params.handle);
  if (params.handle !== null && parent === undefined) return [];
  const elements: unknown[] = (await tree.provider.getChildren(parent)) ?? [];
  return Promise.all(
    elements.map(async (element) => {
      const item = await tree.provider.getTreeItem(element);
      const handle = handleOf(tree, element, item);
      tree.elements.set(handle, element);
      tree.items.set(handle, item);
      return {
        handle,
        label: labelOf(item),
        highlights: typeof item.label === "object" ? item.label?.highlights : undefined,
        description:
          item.description === true && item.resourceUri
            ? path.dirname(path.relative(host.workspaceFolders[0]?.uri.fsPath ?? "", item.resourceUri.fsPath))
            : typeof item.description === "string"
              ? item.description
              : undefined,
        tooltip: tooltipOf(item.tooltip),
        icon: iconDto(item.iconPath),
        resourceUri: item.resourceUri?.toString(),
        collapsible: item.collapsibleState ?? 0,
        contextValue: item.contextValue,
        hasCommand: item.command !== undefined,
      };
    }),
  );
}

/** The element behind a `{ $treeItem }` argument sent by the UI (e.g. a context menu target). */
export function treeElement(ref: { viewId: string; handle: string }): unknown {
  return trees.get(ref.viewId)?.elements.get(ref.handle);
}

// ---- Webviews -----------------------------------------------------------------------

interface WebviewEntry {
  onDidReceiveMessage: EventEmitter<any>;
  onDidDispose: EventEmitter<void>;
  onDidChangeViewState: EventEmitter<any>;
  owner: any;
  state: { active: boolean; visible: boolean };
}

const webviews = new Map<string, WebviewEntry>();
let nextWebview = 1;

/** The origin webviews load from (the UI's `pcwebview` protocol), e.g. `http://pcwebview.localhost`. */
function webviewOrigin(): Uri {
  return Uri.parse(host.webviewOrigin || "http://pcwebview.localhost");
}

function asWebviewUri(uri: Uri): Uri {
  if (uri.scheme !== "file") return uri;
  const origin = webviewOrigin();
  // `/file/C:/dir/a.js` on Windows, `/file/home/me/a.js` elsewhere (see src-tauri/src/webview.rs).
  const local = uri.fsPath.replace(/\\/g, "/").replace(/^\//, "");
  return Uri.from({ scheme: origin.scheme, authority: origin.authority, path: `/file/${local}` });
}

function createWebview(id: string, extensionId: string, initialOptions: any) {
  let html = "";
  let options = initialOptions ?? {};
  const onDidReceiveMessage = new EventEmitter<any>();
  const sendOptions = () =>
    rpc.notify("webview/options", { id, options: { enableScripts: options.enableScripts ?? false, enableForms: options.enableForms } });
  sendOptions();
  const webview = {
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
      rpc.notify("webview/html", { id, html: value, extension: extensionId });
    },
    get options() {
      return options;
    },
    set options(value: any) {
      options = value ?? {};
      sendOptions();
    },
    get cspSource() {
      const origin = webviewOrigin();
      return `${origin.scheme}://${origin.authority}`;
    },
    onDidReceiveMessage: onDidReceiveMessage.event,
    postMessage(message: unknown) {
      rpc.notify("webview/postMessage", { id, message });
      return Promise.resolve(true);
    },
    asWebviewUri,
  };
  return { webview, onDidReceiveMessage };
}

export function createWebviewPanel(extensionId: string, viewType: string, title: string, showOptions: any, options: any = {}) {
  const id = `panel-${nextWebview++}`;
  const { webview, onDidReceiveMessage } = createWebview(id, extensionId, options);
  const onDidDispose = new EventEmitter<void>();
  const onDidChangeViewState = new EventEmitter<any>();
  const state = { active: true, visible: true, title, iconPath: undefined as unknown, disposed: false };
  const preserveFocus = typeof showOptions === "object" && showOptions?.preserveFocus === true;
  rpc.notify("webview/createPanel", { id, viewType, title, extension: extensionId, preserveFocus });
  const panel = {
    viewType,
    webview,
    options,
    viewColumn: 1,
    get title() {
      return state.title;
    },
    set title(value: string) {
      state.title = value;
      rpc.notify("webview/title", { id, title: value });
    },
    get iconPath() {
      return state.iconPath;
    },
    set iconPath(value: unknown) {
      state.iconPath = value;
      rpc.notify("webview/icon", { id, icon: iconDto(value) });
    },
    get active() {
      return state.active;
    },
    get visible() {
      return state.visible;
    },
    onDidDispose: onDidDispose.event,
    onDidChangeViewState: onDidChangeViewState.event,
    reveal(_column?: unknown, preserve?: boolean) {
      rpc.notify("webview/reveal", { id, preserveFocus: preserve ?? false });
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      rpc.notify("webview/dispose", { id });
      webviews.delete(id);
      onDidDispose.fire();
    },
  };
  webviews.set(id, { onDidReceiveMessage, onDidDispose, onDidChangeViewState, owner: panel, state });
  return panel;
}

const webviewViewProviders = new Map<string, { provider: any; extensionId: string }>();

export function registerWebviewViewProvider(extensionId: string, viewId: string, provider: any, options?: any) {
  webviewViewProviders.set(viewId, { provider, extensionId });
  rpc.notify("views/registerWebview", { viewId, retainContextWhenHidden: options?.webviewOptions?.retainContextWhenHidden ?? false });
  return new Disposable(() => {
    webviewViewProviders.delete(viewId);
    rpc.notify("views/unregister", { viewId });
  });
}

/** Creates the webview of a webview view the UI is about to show; returns its id. */
async function resolveWebviewView(params: { viewId: string; state?: unknown }) {
  const registered = webviewViewProviders.get(params.viewId);
  if (!registered) return null;
  const id = `view-${nextWebview++}`;
  const { webview, onDidReceiveMessage } = createWebview(id, registered.extensionId, {});
  const onDidDispose = new EventEmitter<void>();
  const onDidChangeVisibility = new EventEmitter<void>();
  const state = { active: true, visible: true, title: undefined as string | undefined, description: undefined as string | undefined, badge: undefined as unknown };
  const update = () => rpc.notify("views/update", { viewId: params.viewId, title: state.title, description: state.description, badge: (state.badge as any)?.value });
  const view = {
    viewType: params.viewId,
    webview,
    get title() {
      return state.title;
    },
    set title(value: string | undefined) {
      state.title = value;
      update();
    },
    get description() {
      return state.description;
    },
    set description(value: string | undefined) {
      state.description = value;
      update();
    },
    get badge() {
      return state.badge;
    },
    set badge(value: unknown) {
      state.badge = value;
      update();
    },
    get visible() {
      return state.visible;
    },
    onDidDispose: onDidDispose.event,
    onDidChangeVisibility: onDidChangeVisibility.event,
    show() {
      rpc.notify("views/show", { viewId: params.viewId });
    },
  };
  webviews.set(id, {
    onDidReceiveMessage,
    onDidDispose,
    onDidChangeViewState: new EventEmitter<any>(),
    owner: view,
    state,
  });
  await registered.provider.resolveWebviewView(view, { state: params.state }, new CancellationTokenSource().token);
  return { id };
}

// ---- Messages from the UI ----------------------------------------------------------

export function listen() {
  rpc.onRequest("views/children", children);
  rpc.onRequest("views/execute", async (params: { viewId: string; handle: string }) => {
    const item = trees.get(params.viewId)?.items.get(params.handle);
    if (item?.command) await executeCommand(item.command.command, ...(item.command.arguments ?? []));
    return null;
  });
  rpc.onNotification("views/selection", (params: { viewId: string; handles: string[] }) => {
    const tree = trees.get(params.viewId);
    if (!tree) return;
    const selection = params.handles.map((h) => tree.elements.get(h)).filter((e) => e !== undefined);
    (tree as any).state.selection = selection;
    tree.onDidChangeSelection.fire({ selection });
  });
  rpc.onNotification("views/expanded", (params: { viewId: string; handle: string; expanded: boolean }) => {
    const tree = trees.get(params.viewId);
    const element = tree?.elements.get(params.handle);
    if (!tree || element === undefined) return;
    (params.expanded ? tree.onDidExpandElement : tree.onDidCollapseElement).fire({ element });
  });
  rpc.onNotification("views/visible", (params: { viewId: string; visible: boolean }) => {
    const tree = trees.get(params.viewId);
    if (!tree) return;
    (tree as any).state.visible = params.visible;
    tree.onDidChangeVisibility.fire({ visible: params.visible });
  });
  rpc.onRequest("views/resolveWebview", resolveWebviewView);

  rpc.onNotification("webview/message", (params: { id: string; message: unknown }) => {
    webviews.get(params.id)?.onDidReceiveMessage.fire(params.message);
  });
  rpc.onNotification("webview/viewState", (params: { id: string; active: boolean; visible: boolean }) => {
    const entry = webviews.get(params.id);
    if (!entry) return;
    entry.state.active = params.active;
    entry.state.visible = params.visible;
    entry.onDidChangeViewState.fire({ webviewPanel: entry.owner });
  });
  rpc.onNotification("webview/disposed", (params: { id: string }) => {
    const entry = webviews.get(params.id);
    if (!entry) return;
    webviews.delete(params.id);
    (entry.state as any).disposed = true;
    entry.onDidDispose.fire();
  });
}
