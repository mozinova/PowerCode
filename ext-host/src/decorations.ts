//! `window.createTextEditorDecorationType` and `TextEditor.setDecorations`: the
//! options go to the UI, which draws them in Monaco (see src/exthost/decorations.ts).

import * as rpc from "./rpc";
import { MarkdownString, ThemeColor, Uri } from "./types";
import { iconDto } from "./views";

let nextType = 1;

/** Colours may be ThemeColors; the UI resolves `{ themeColor }` against the editor theme. */
function color(value: unknown): unknown {
  if (value instanceof ThemeColor) return { themeColor: value.id };
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return { themeColor: (value as { id: string }).id };
  return value;
}

/** Render options as plain data: colours resolved later, icons as local files or URIs. */
function renderOptions(options: any): any {
  if (!options || typeof options !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === "gutterIconPath") out[key] = iconDto(typeof value === "string" ? Uri.file(value) : value);
    else if (key === "before" || key === "after") out[key] = attachment(value);
    else if (key === "light" || key === "dark") out[key] = renderOptions(value);
    else if (/color$/i.test(key)) out[key] = color(value);
    else out[key] = value;
  }
  return out;
}

function attachment(value: any) {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (key === "contentIconPath") out[key] = iconDto(typeof v === "string" ? Uri.file(v) : v);
    else if (/color$/i.test(key)) out[key] = color(v);
    else out[key] = v;
  }
  return out;
}

function hover(message: unknown): string[] | undefined {
  const list = Array.isArray(message) ? message : message === undefined ? [] : [message];
  const texts = list.map((m) => (m instanceof MarkdownString ? m.value : typeof m === "string" ? m : (m as { value?: string })?.value)).filter((m): m is string => !!m);
  return texts.length ? texts : undefined;
}

export function createDecorationType(options: any) {
  const key = `TextEditorDecorationType${nextType++}`;
  rpc.notify("decorations/createType", { key, options: renderOptions(options) });
  return {
    key,
    dispose() {
      rpc.notify("decorations/disposeType", { key });
    },
  };
}

/** `TextEditor.setDecorations`: ranges, or `DecorationOptions` with hovers and per-range render options. */
export function setDecorations(uri: Uri, type: { key: string }, items: any[], toRange: (r: any) => unknown) {
  rpc.notify("decorations/set", {
    key: type.key,
    uri: uri.toString(),
    items: (items ?? []).map((item) =>
      item && item.range
        ? { range: toRange(item.range), hoverMessage: hover(item.hoverMessage), renderOptions: renderOptions(item.renderOptions) }
        : { range: toRange(item) },
    ),
  });
}
