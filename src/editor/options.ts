//! Editor options from the user's settings (`editor.*` keys, as in VS Code),
//! applied to every code editor and model as they change.

import { setting, useUserSettings } from "../settings/store";
import { monaco } from "./monaco";

type Values = Record<string, unknown>;

/** Editor defaults, shared with the Settings page's definitions. */
export const EDITOR_DEFAULTS = {
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace',
  fontSize: 13,
  lineHeight: 20,
};

/** The editor options settings control; the rest stays as each editor sets it. */
export function editorOptions(values: Values = useUserSettings.getState().values): monaco.editor.IEditorOptions {
  const s = <T,>(key: string, fallback: T) => setting(key, fallback, values);
  return {
    fontFamily: s("editor.fontFamily", EDITOR_DEFAULTS.fontFamily) || EDITOR_DEFAULTS.fontFamily,
    fontSize: s("editor.fontSize", EDITOR_DEFAULTS.fontSize),
    lineHeight: s("editor.lineHeight", EDITOR_DEFAULTS.lineHeight),
    fontLigatures: s("editor.fontLigatures", true),
    wordWrap: s("editor.wordWrap", "off") as monaco.editor.IEditorOptions["wordWrap"],
    wordWrapColumn: s("editor.wordWrapColumn", 80),
    lineNumbers: s("editor.lineNumbers", "on") as monaco.editor.LineNumbersType,
    renderWhitespace: s("editor.renderWhitespace", "selection") as monaco.editor.IEditorOptions["renderWhitespace"],
    minimap: { enabled: s("editor.minimap.enabled", false) },
    stickyScroll: { enabled: s("editor.stickyScroll.enabled", true) },
    bracketPairColorization: { enabled: s("editor.bracketPairColorization.enabled", true) },
    guides: { indentation: s("editor.guides.indentation", true) },
    smoothScrolling: s("editor.smoothScrolling", true),
    cursorBlinking: s("editor.cursorBlinking", "blink") as monaco.editor.IEditorOptions["cursorBlinking"],
    cursorStyle: s("editor.cursorStyle", "line") as monaco.editor.IEditorOptions["cursorStyle"],
    // Extensions' features: ghost text completions, matching tag renames, colour swatches.
    inlineSuggest: { enabled: s("editor.inlineSuggest.enabled", true) },
    linkedEditing: s("editor.linkedEditing", false),
    colorDecorators: s("editor.colorDecorators", true),
  };
}

/** Indentation of a model: detected from its content, or the configured one. */
export function applyIndentation(model: monaco.editor.ITextModel, values: Values = useUserSettings.getState().values) {
  const tabSize = setting("editor.tabSize", 4, values);
  const insertSpaces = setting("editor.insertSpaces", true, values);
  if (setting("editor.detectIndentation", true, values)) model.detectIndentation(insertSpaces, tabSize);
  else model.updateOptions({ tabSize, insertSpaces });
}

const INDENTATION_KEYS = ["editor.tabSize", "editor.insertSpaces", "editor.detectIndentation"];

/** Keeps `editor`'s options in step with the settings; returns the unsubscribe function. */
export function followEditorSettings(editor: monaco.editor.ICodeEditor | monaco.editor.IDiffEditor) {
  return useUserSettings.subscribe((state, previous) => {
    if (state.values !== previous.values) editor.updateOptions(editorOptions(state.values));
  });
}

let watching = false;

/** Applies the indentation settings to new models, and again to all of them when they change. */
export function watchIndentationSettings() {
  if (watching) return;
  watching = true;
  monaco.editor.onDidCreateModel((model) => applyIndentation(model));
  useUserSettings.subscribe((state, previous) => {
    if (INDENTATION_KEYS.some((k) => state.values[k] !== previous.values[k])) {
      for (const model of monaco.editor.getModels()) applyIndentation(model, state.values);
    }
  });
}
