//! Extensions' webviews (panels in editor tabs, views in tool windows). Their
//! HTML is served by the `pcwebview` protocol (src-tauri/src/webview.rs) from
//! an origin of its own, and talks to the extension through postMessage.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { activeThemeColors } from "../editor/themes";
import * as rpc from "./rpc";
import { appendOutput, useExtensionHost } from "./state";

export interface WebviewState {
  id: string;
  /** Bumped whenever new HTML is served; part of the frame URL so it reloads. */
  version: number;
  enableScripts: boolean;
  enableForms: boolean;
  extension?: string;
}

export const useWebviews = create<{ webviews: Record<string, WebviewState> }>(() => ({ webviews: {} }));

/** `http://pcwebview.localhost` on Windows, `pcwebview://localhost` elsewhere. */
export const WEBVIEW_ORIGIN = convertFileSrc("", "pcwebview").replace(/\/$/, "");

export function webviewUrl(webview: WebviewState): string {
  return `${WEBVIEW_ORIGIN}/${webview.id}/index.html?v=${webview.version}`;
}

/** State saved by the webview's `vscode.setState`, given back after it reloads. */
const savedStates = new Map<string, unknown>();
const htmlById = new Map<string, string>();

function update(id: string, change: Partial<WebviewState>) {
  useWebviews.setState(({ webviews }) => {
    const current = webviews[id] ?? { id, version: 0, enableScripts: false, enableForms: false };
    return { webviews: { ...webviews, [id]: { ...current, ...change } } };
  });
}

// ---- HTML -----------------------------------------------------------------------

const DEFAULT_COLORS: Record<string, string> = {
  foreground: "#dfe1e5",
  descriptionForeground: "#868a91",
  errorForeground: "#db5c5c",
  focusBorder: "#3574f0",
  "widget.border": "#393b40",
  "editor.background": "#1e1f22",
  "editor.foreground": "#bcbec4",
  "sideBar.background": "#2b2d30",
  "sideBar.foreground": "#dfe1e5",
  "sideBarSectionHeader.background": "#2b2d30",
  "panel.background": "#2b2d30",
  "panel.border": "#393b40",
  "button.background": "#3574f0",
  "button.foreground": "#ffffff",
  "button.hoverBackground": "#4682fa",
  "button.secondaryBackground": "#43454a",
  "button.secondaryForeground": "#dfe1e5",
  "button.secondaryHoverBackground": "#4e5157",
  "input.background": "#1e1f22",
  "input.foreground": "#dfe1e5",
  "input.border": "#4e5157",
  "input.placeholderForeground": "#6f737a",
  "inputOption.activeBorder": "#3574f0",
  "dropdown.background": "#2b2d30",
  "dropdown.foreground": "#dfe1e5",
  "dropdown.border": "#4e5157",
  "list.hoverBackground": "#393b40",
  "list.activeSelectionBackground": "#2e436e",
  "list.activeSelectionForeground": "#ffffff",
  "list.inactiveSelectionBackground": "#43454a",
  "badge.background": "#3574f0",
  "badge.foreground": "#ffffff",
  "textLink.foreground": "#589df6",
  "textLink.activeForeground": "#78b0f8",
  "textCodeBlock.background": "#1e1f22",
  "textBlockQuote.background": "#2b2d30",
  "textBlockQuote.border": "#4e5157",
  "textPreformat.foreground": "#bcbec4",
  "scrollbarSlider.background": "#4e515766",
  "scrollbarSlider.hoverBackground": "#4e5157aa",
  "scrollbarSlider.activeBackground": "#6f737a",
  "progressBar.background": "#3574f0",
  "toolbar.hoverBackground": "#393b40",
  "icon.foreground": "#ced0d6",
  "checkbox.background": "#1e1f22",
  "checkbox.border": "#4e5157",
  "menu.background": "#2b2d30",
  "menu.foreground": "#dfe1e5",
  "menu.selectionBackground": "#2e436e",
  "editorWidget.background": "#2b2d30",
  "editorWidget.border": "#393b40",
  "terminal.background": "#1e1f22",
  "terminal.foreground": "#bcbec4",
};

const FONT = '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
const CODE_FONT = '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace';

function themeStyle(background: string): string {
  const colors = { ...DEFAULT_COLORS, ...activeThemeColors() };
  const variables = Object.entries(colors)
    .map(([key, value]) => `--vscode-${key.replace(/\./g, "-")}: ${value};`)
    .join("\n");
  // VS Code's default webview styles, which extensions build on.
  return `:root {
${variables}
--vscode-font-family: ${FONT};
--vscode-font-size: 13px;
--vscode-font-weight: normal;
--vscode-editor-font-family: ${CODE_FONT};
--vscode-editor-font-size: 13px;
--vscode-editor-font-weight: normal;
--pc-background: ${background};
}
html { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
body { background-color: transparent; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }
kbd { background-color: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 3px; padding: 1px 3px; }
:focus { outline-color: var(--vscode-focusBorder); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-corner { background-color: transparent; }`;
}

/**
 * The `acquireVsCodeApi` bridge, run before the page's own scripts (and its CSP).
 * Exported for tests.
 */
export function bootstrap(id: string): string {
  const state = JSON.stringify(savedStates.get(id) ?? null).replace(/</g, "\\u003c");
  return `(function () {
  var state = ${state};
  var post = function (message) { window.parent.postMessage(Object.assign({ __pcWebview: ${JSON.stringify(id)} }, message), "*"); };
  var acquired = false;
  var api = Object.freeze({
    postMessage: function (message) { post({ type: "message", message: message }); },
    getState: function () { return state; },
    setState: function (value) { state = value; post({ type: "setState", state: value }); return value; }
  });
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
    acquired = true;
    return api;
  };
  // Messages from the extension arrive from PowerCode's window in an envelope and are
  // delivered again from the page itself: as in VS Code, their origin is the webview's
  // own (pages such as Codex drop messages from any other origin). The envelope stops
  // here, so the page's listeners see each message once.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data.__pcHostMessage !== true) return;
    event.stopImmediatePropagation();
    var origin = window.location.origin;
    window.postMessage(data.message, origin && origin !== "null" ? origin : "*");
  }, true);
  // Errors go to PowerCode's Output ("Webviews"), as a webview has no visible console.
  var describe = function (value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  };
  var report = function (level, parts) {
    try { post({ type: "log", level: level, text: Array.prototype.map.call(parts, describe).join(" ").slice(0, 4000) }); } catch (e) {}
  };
  var consoleError = console.error;
  console.error = function () { report("error", arguments); return consoleError.apply(console, arguments); };
  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) report("error", ["Failed to load " + (target.src || target.href)]);
    else report("error", [event.error || event.message]);
  }, true);
  window.addEventListener("unhandledrejection", function (event) { report("error", ["Unhandled rejection:", event.reason]); });
  document.addEventListener("securitypolicyviolation", function (event) {
    report("warning", ["Blocked by the page's Content-Security-Policy (" + event.violatedDirective + "): " + (event.blockedURI || "inline")]);
  });
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (/^(https?:|mailto:|command:)/i.test(href)) {
      event.preventDefault();
      post({ type: "link", href: href });
    }
  }, true);
  var ready = function () {
    document.body.classList.add("vscode-dark");
    document.body.setAttribute("data-vscode-theme-kind", "vscode-dark");
    post({ type: "ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();`;
}

/** The page as served: theme variables and the API bridge first, then the extension's HTML. */
function compose(id: string, html: string, enableScripts: boolean, background: string): string {
  const injected =
    `<style id="_defaultStyles">${themeStyle(background)}</style>` +
    (enableScripts ? `<script>${bootstrap(id)}</script>` : "");
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + injected + html.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const end = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, end)}<head>${injected}</head>${html.slice(end)}`;
  }
  return `<!DOCTYPE html><html><head>${injected}</head><body>${html}</body></html>`;
}

/** Background of the surface a webview sits on, so `--pc-background` matches. */
const backgrounds = new Map<string, string>();

async function serve(id: string) {
  const html = htmlById.get(id);
  if (html === undefined) return;
  const webview = useWebviews.getState().webviews[id];
  const page = compose(id, html, webview?.enableScripts ?? false, backgrounds.get(id) ?? DEFAULT_COLORS["editor.background"]);
  await invoke("webview_set_html", { id, html: page });
  ready.delete(id);
  update(id, { version: (useWebviews.getState().webviews[id]?.version ?? 0) + 1 });
}

export function setWebviewHtml(id: string, html: string, extension?: string) {
  htmlById.set(id, html);
  if (extension) update(id, { extension });
  void serve(id);
}

export function setWebviewOptions(id: string, options: { enableScripts: boolean; enableForms?: boolean }) {
  const current = useWebviews.getState().webviews[id];
  update(id, { enableScripts: options.enableScripts, enableForms: options.enableForms ?? options.enableScripts });
  // Scripts are injected (or not) when serving, so a change needs a new page.
  if (current && current.enableScripts !== options.enableScripts) void serve(id);
}

export function setWebviewBackground(id: string, background: string) {
  backgrounds.set(id, background);
}

export function disposeWebview(id: string) {
  htmlById.delete(id);
  savedStates.delete(id);
  backgrounds.delete(id);
  frames.delete(id);
  anchors.delete(id);
  ready.delete(id);
  queued.delete(id);
  void invoke("webview_dispose", { id }).catch(() => {});
  useWebviews.setState(({ webviews }) => {
    const { [id]: _removed, ...rest } = webviews;
    return { webviews: rest };
  });
}

export function disposeAllWebviews() {
  for (const id of Object.keys(useWebviews.getState().webviews)) disposeWebview(id);
}

// ---- Placement ------------------------------------------------------------------------

/**
 * Where each webview is shown: the element it is laid over (see WebviewLayer).
 * Webviews live in a layer of their own because moving an iframe in the DOM
 * reloads it; this way switching tabs or tool windows keeps their state.
 */
const anchors = new Map<string, HTMLElement>();

export function setAnchor(id: string, element: HTMLElement) {
  anchors.set(id, element);
}

/** Forgets `element` as the anchor of `id`, unless another one replaced it meanwhile. */
export function clearAnchor(id: string, element: HTMLElement) {
  if (anchors.get(id) === element) anchors.delete(id);
}

export function anchorOf(id: string): HTMLElement | undefined {
  const element = anchors.get(id);
  return element?.isConnected ? element : undefined;
}

// ---- Messages ---------------------------------------------------------------------

const frames = new Map<string, HTMLIFrameElement>();
/** Webviews whose page has loaded; messages to others wait in `queued`. */
const ready = new Set<string>();
const queued = new Map<string, unknown[]>();

export function attachFrame(id: string, frame: HTMLIFrameElement | null) {
  if (frame) frames.set(id, frame);
  else if (frames.get(id)) frames.delete(id);
}

/** How messages travel to a webview's bridge (which delivers them with the page's own origin). */
const envelope = (message: unknown) => ({ __pcHostMessage: true, message });

export function postToWebview(id: string, message: unknown) {
  const frame = frames.get(id);
  if (frame?.contentWindow && ready.has(id)) {
    frame.contentWindow.postMessage(envelope(message), "*");
    return;
  }
  queued.set(id, [...(queued.get(id) ?? []), message]);
}

function flushQueue(id: string) {
  const frame = frames.get(id);
  const messages = queued.get(id);
  if (!frame?.contentWindow || !messages) return;
  queued.delete(id);
  for (const message of messages) frame.contentWindow.postMessage(envelope(message), "*");
}

/** Runs `command:id?args` links like VS Code: args are a JSON value or array. */
function runCommandLink(href: string) {
  const match = /^command:([^?]+)(?:\?(.*))?$/i.exec(href);
  if (!match) return;
  let args: unknown[] = [];
  if (match[2]) {
    try {
      const parsed = JSON.parse(decodeURIComponent(match[2]));
      args = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Arguments that are not JSON are dropped.
    }
  }
  void rpc.request("commands/execute", { command: match[1], args }).catch(() => {});
}

/** A webview's errors, in the "Webviews" Output channel (tagged with its extension). */
function logWebview(id: string, level: string, text: string) {
  const extension = useWebviews.getState().webviews[id]?.extension ?? "webview";
  useExtensionHost.setState(({ outputs }) =>
    outputs.some((o) => o.id === "webviews") ? {} : { outputs: [...outputs, { id: "webviews", name: "Webviews", text: "" }] },
  );
  appendOutput("webviews", `[${new Date().toLocaleTimeString()}] [${level}] [${extension}] ${text}\n`);
}

let listening = false;

export function listenToWebviews() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    const data = event.data as { __pcWebview?: string; type?: string; message?: unknown; state?: unknown; href?: string };
    const id = data?.__pcWebview;
    if (typeof id !== "string") return;
    // Only the webview's own frame may speak for it.
    const frame = frames.get(id);
    if (!frame || event.source !== frame.contentWindow) return;
    switch (data.type) {
      case "message":
        rpc.notify("webview/message", { id, message: data.message });
        break;
      case "setState":
        savedStates.set(id, data.state);
        break;
      case "ready":
        ready.add(id);
        flushQueue(id);
        break;
      case "link":
        if (data.href?.toLowerCase().startsWith("command:")) runCommandLink(data.href);
        else if (data.href) void openUrl(data.href);
        break;
      case "log":
        logWebview(id, (data as { level?: string }).level ?? "error", (data as { text?: string }).text ?? "");
        break;
    }
  });
}
