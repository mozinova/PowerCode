//! The editor's right-click menu: PowerCode's own (Monaco's is turned off), with
//! the code actions, a clipboard that works in the webview (Tauri's clipboard),
//! and extensions' `editor/context` items, as in VS Code.

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import { focusCommandPalette } from "../components/FileSearch";
import { menuEntries } from "../components/ExtensionViews";
import { ContextMenu, type MenuEntry } from "../components/Menu";
import { menuItems } from "../exthost/contributions";
import { useExtensionHost } from "../exthost/state";
import { isTrue, useContributions } from "../exthost/views";
import { basename } from "../lib/paths";
import { modelPath } from "./models";
import { monaco } from "./monaco";

const copyText = (text: string) => writeText(text).catch(() => navigator.clipboard.writeText(text));

/** The selection's text, or (like VS Code with an empty selection) the cursor's whole line. */
function clipboardText(editor: monaco.editor.ICodeEditor): { text: string; range: monaco.IRange } | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return null;
  if (!selection.isEmpty()) return { text: model.getValueInRange(selection), range: selection };
  const line = selection.startLineNumber;
  const range =
    line < model.getLineCount()
      ? new monaco.Range(line, 1, line + 1, 1)
      : new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
  return { text: `${model.getLineContent(line)}\n`, range };
}

async function cut(editor: monaco.editor.ICodeEditor) {
  const target = clipboardText(editor);
  if (!target) return;
  await copyText(target.text);
  editor.executeEdits("cut", [{ range: target.range, text: "" }]);
  editor.focus();
}

async function paste(editor: monaco.editor.ICodeEditor) {
  const text = await readText().catch(() => navigator.clipboard.readText().catch(() => ""));
  editor.focus();
  // Monaco's own paste: multiple cursors, auto-indent and "paste on new line" as usual.
  if (text) editor.trigger("keyboard", "paste", { text, pasteOnNewLine: false, multicursorText: null, mode: null });
}

function EditorMenu({ editor, x, y, onClose }: { editor: monaco.editor.ICodeEditor; x: number; y: number; onClose: () => void }) {
  const contributions = useContributions();
  const hostRunning = useExtensionHost((s) => s.status === "running");
  const model = editor.getModel();
  if (!model) return null;
  const readOnly = editor.getOption(monaco.editor.EditorOption.readOnly);
  const hasSelection = !(editor.getSelection()?.isEmpty() ?? true);

  /** A Monaco editor action, disabled where the language does not support it. */
  const action = (id: string, label: string, shortcut?: string, needsWrite = false): MenuEntry => {
    const found = editor.getAction(id);
    return {
      label,
      shortcut,
      disabled: !found || !found.isSupported() || (needsWrite && readOnly),
      action: () => void found?.run(),
    };
  };

  const items: MenuEntry[] = [
    action("editor.action.revealDefinition", "Go to Definition", "F12"),
    action("editor.action.goToReferences", "Go to References", "Shift+F12"),
    action("editor.action.peekDefinition", "Peek Definition", "Alt+F12"),
    "separator",
    action("editor.action.rename", "Rename Symbol", "F2", true),
    action("editor.action.changeAll", "Change All Occurrences", "Ctrl+F2", true),
    hasSelection
      ? action("editor.action.formatSelection", "Format Selection", "Ctrl+K Ctrl+F", true)
      : action("editor.action.formatDocument", "Format Document", "Shift+Alt+F", true),
    "separator",
    { label: "Cut", shortcut: "Ctrl+X", disabled: readOnly, action: () => void cut(editor) },
    { label: "Copy", shortcut: "Ctrl+C", action: () => void copyText(clipboardText(editor)?.text ?? "") },
    { label: "Paste", shortcut: "Ctrl+V", disabled: readOnly, action: () => void paste(editor) },
  ];

  // Extensions' items for this file (e.g. "Explain with ...", "Run Test"), with its Uri as argument.
  if (hostRunning) {
    const path = modelPath(model);
    const name = basename(path ?? model.uri.path);
    const dot = name.lastIndexOf(".");
    const context = {
      resourceScheme: model.uri.scheme,
      resourceFilename: name,
      resourceExtname: dot > 0 ? name.slice(dot) : "",
      resourcePath: path,
      resourceLangId: model.getLanguageId(),
      editorLangId: model.getLanguageId(),
      editorHasSelection: hasSelection,
      editorReadonly: readOnly,
      editorTextFocus: true,
      textInputFocus: true,
      activeEditor: "workbench.editors.files.textFileEditor",
    };
    const { inline, other } = menuItems(contributions, "editor/context", (when) => isTrue(when, context));
    const groups = [...(inline.length ? [inline] : []), ...other];
    const extensionEntries = menuEntries(contributions, groups, [{ $uri: model.uri.toString() }]);
    if (extensionEntries.length > 0) items.push("separator", ...extensionEntries);
  }

  items.push("separator", { label: "Command Palette", shortcut: "Ctrl+Shift+P", action: () => focusCommandPalette() });
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/**
 * Shows PowerCode's menu on right-clicks in `editor` (whose own menu must be off:
 * `contextmenu: false`; Monaco still moves the cursor to the click).
 */
export function useEditorContextMenu(editor: monaco.editor.ICodeEditor | null) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const listener = editor.onContextMenu((e) => {
      // Not on widgets drawn over the text (hovers, the find box, comment threads).
      if (e.target.type === monaco.editor.MouseTargetType.OVERLAY_WIDGET || e.target.type === monaco.editor.MouseTargetType.CONTENT_WIDGET) return;
      e.event.preventDefault();
      setMenu({ x: e.event.browserEvent.clientX, y: e.event.browserEvent.clientY });
    });
    return () => listener.dispose();
  }, [editor]);
  const element = menu && editor ? <EditorMenu editor={editor} x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null;
  return element;
}

