//! Extensions' text decorations (`createTextEditorDecorationType` + `setDecorations`)
//! drawn in Monaco: inline styles and whole lines through generated CSS classes,
//! text before/after ranges as injected text, gutter icons, overview ruler marks.

import { convertFileSrc } from "@tauri-apps/api/core";
import { activeThemeColors } from "../editor/themes";
import { monaco } from "../editor/monaco";
import { pathFromUri } from "./languages";

type Options = Record<string, any>;

const types = new Map<string, Options>();
/** Decorations by model URI, then type key. */
const byUri = new Map<string, Map<string, any[]>>();
/** Monaco decoration ids by model URI and type key. */
const applied = new Map<string, Map<string, string[]>>();

// ---- CSS ----------------------------------------------------------------------

let sheet: HTMLStyleElement | null = null;
const classes = new Map<string, string>();
let nextClass = 1;

/** Theme colours extensions use most, for themes that do not define them. */
const FALLBACK_COLORS: Record<string, string> = {
  "editorError.foreground": "#db5c5c",
  "editorWarning.foreground": "#e0b84c",
  "editorInfo.foreground": "#3574f0",
  "editorHint.foreground": "#868a91",
  "editorCodeLens.foreground": "#868a91",
  "editorLineNumber.foreground": "#4b5059",
  "editor.foreground": "#bcbec4",
  "editor.findMatchHighlightBackground": "#32593d80",
  "editor.selectionHighlightBackground": "#2e436e80",
  "editor.wordHighlightBackground": "#3c3f4180",
  "editor.rangeHighlightBackground": "#2e436e40",
  "editorGutter.modifiedBackground": "#70aeff",
  "editorGutter.addedBackground": "#5fb865",
  "editorGutter.deletedBackground": "#db5c5c",
  "gitDecoration.addedResourceForeground": "#5fb865",
  "gitDecoration.modifiedResourceForeground": "#70aeff",
  "gitDecoration.deletedResourceForeground": "#db5c5c",
  "descriptionForeground": "#868a91",
  "foreground": "#dfe1e5",
  "charts.red": "#db5c5c",
  "charts.orange": "#e08855",
  "charts.yellow": "#e0b84c",
  "charts.green": "#5fb865",
  "charts.blue": "#3574f0",
  "charts.purple": "#a67bd9",
};

/** A CSS value from an extension, without anything that could end the declaration. */
function cssValue(value: unknown): string | undefined {
  if (value && typeof value === "object" && "themeColor" in value) {
    const id = (value as { themeColor: string }).themeColor;
    return activeThemeColors()[id] ?? FALLBACK_COLORS[id];
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  return /[;{}<>\\]|\/\*/.test(text) ? undefined : text;
}

const CSS_PROPERTIES: Record<string, string> = {
  backgroundColor: "background-color",
  color: "color",
  border: "border",
  borderColor: "border-color",
  borderRadius: "border-radius",
  borderSpacing: "border-spacing",
  borderStyle: "border-style",
  borderWidth: "border-width",
  outline: "outline",
  outlineColor: "outline-color",
  outlineStyle: "outline-style",
  outlineWidth: "outline-width",
  fontStyle: "font-style",
  fontWeight: "font-weight",
  fontSize: "font-size",
  fontFamily: "font-family",
  textDecoration: "text-decoration",
  cursor: "cursor",
  opacity: "opacity",
  letterSpacing: "letter-spacing",
  margin: "margin",
  width: "width",
  height: "height",
};

function declarations(options: Options): string {
  return Object.entries(CSS_PROPERTIES)
    .map(([key, property]) => {
      const value = cssValue(options[key]);
      return value === undefined ? "" : `${property}: ${value};`;
    })
    .join(" ");
}

/** A class for these declarations (shared by equal styles). */
function classFor(css: string): string | undefined {
  if (!css.trim()) return undefined;
  let name = classes.get(css);
  if (!name) {
    name = `pc-decoration-${nextClass++}`;
    classes.set(css, name);
    sheet ??= document.head.appendChild(document.createElement("style"));
    sheet.append(`.${name} { ${css} }\n`);
  }
  return name;
}

function localUrl(icon: any): string | undefined {
  if (!icon) return undefined;
  if (icon.localPath) return convertFileSrc(icon.localPath);
  if (typeof icon.uri === "string") return icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
  return undefined;
}

// ---- Decorations ------------------------------------------------------------------

/** The type's options for a dark theme (VS Code applies the `dark` overrides there). */
const forTheme = (options: Options | undefined): Options => ({ ...(options ?? {}), ...(options?.dark ?? {}) });

function injected(base: Options | undefined, own: Options | undefined): monaco.editor.InjectedTextOptions | undefined {
  const merged = { ...(base ?? {}), ...(own ?? {}) };
  if (typeof merged.contentText !== "string" || merged.contentText === "") return undefined;
  return { content: merged.contentText, inlineClassName: classFor(declarations(merged)), cursorStops: monaco.editor.InjectedTextCursorStops.None };
}

function toDecoration(type: Options, item: any): monaco.editor.IModelDeltaDecoration {
  const options = forTheme(type);
  const own = forTheme(item.renderOptions);
  const r = item.range;
  const range = new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const decoration: monaco.editor.IModelDecorationOptions = {
    className: classFor(declarations(options)),
    isWholeLine: options.isWholeLine === true,
    stickiness: typeof options.rangeBehavior === "number" ? options.rangeBehavior : monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
    hoverMessage: item.hoverMessage?.map((value: string) => ({ value, isTrusted: false })),
    before: injected(options.before, own.before),
    after: injected(options.after, own.after),
  };
  const gutter = localUrl(options.gutterIconPath);
  if (gutter) {
    const size = cssValue(options.gutterIconSize) ?? "contain";
    decoration.glyphMarginClassName = classFor(`background: url("${gutter.replace(/"/g, "%22")}") center / ${size} no-repeat;`);
  }
  const ruler = cssValue(options.overviewRulerColor);
  if (ruler) decoration.overviewRuler = { color: ruler, position: options.overviewRulerLane ?? monaco.editor.OverviewRulerLane.Center };
  return { range, options: decoration };
}

function apply(uri: string, key: string) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  const type = types.get(key);
  const items = type ? (byUri.get(uri)?.get(key) ?? []) : [];
  let ids = applied.get(uri);
  if (!ids) applied.set(uri, (ids = new Map()));
  ids.set(key, model.deltaDecorations(ids.get(key) ?? [], type ? items.map((item) => toDecoration(type, item)) : []));
}

export function registerDecorationHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("decorations/createType", ({ key, options }) => types.set(key, options ?? {}));
  onNotification("decorations/disposeType", ({ key }) => {
    types.delete(key);
    for (const [uri, map] of byUri) {
      if (map.delete(key)) apply(uri, key);
    }
  });
  onNotification("decorations/set", ({ key, uri, items }) => {
    let map = byUri.get(uri);
    if (!map) byUri.set(uri, (map = new Map()));
    map.set(key, items ?? []);
    apply(uri, key);
  });
  // Files opened after their decorations were set get them too.
  monaco.editor.onDidCreateModel((model) => {
    const uri = model.uri.toString();
    applied.delete(uri);
    for (const key of byUri.get(uri)?.keys() ?? []) apply(uri, key);
  });
}

/** Removes every extension decoration (the extension host restarted). */
export function resetDecorations() {
  for (const [uri, ids] of applied) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) for (const list of ids.values()) model.deltaDecorations(list, []);
  }
  applied.clear();
  byUri.clear();
  types.clear();
}
