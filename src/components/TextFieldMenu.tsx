//! The right-click menu of text fields (search boxes, inputs, the commit message):
//! PowerCode's own instead of the WebView's browser menu (Emoji, Import passwords,
//! Writing direction, ...), as VS Code does. The clipboard goes through Tauri, which
//! works where the WebView's clipboard API is refused.

import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import { ContextMenu, type MenuEntry } from "./Menu";

type Field = HTMLInputElement | HTMLTextAreaElement;

/** Input types that hold text the user edits. */
const TEXT_TYPES = new Set(["text", "search", "url", "email", "password", "tel", "number", ""]);

function textField(target: EventTarget | null): Field | null {
  const element = target instanceof Element ? target.closest("input, textarea") : null;
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLInputElement && TEXT_TYPES.has(element.type)) return element;
  return null;
}

interface Selection {
  start: number;
  end: number;
}

function TextFieldMenu({ field, selection, x, y, onClose }: { field: Field; selection: Selection; x: number; y: number; onClose: () => void }) {
  const readOnly = field.readOnly || field.disabled;
  const selected = field.value.slice(selection.start, selection.end);
  // Like browsers: a password's text is never copied out.
  const secret = field instanceof HTMLInputElement && field.type === "password";

  /** Back in the field with the selection it had, so editing commands apply there (and to its undo stack). */
  const focus = () => {
    field.focus();
    try {
      field.setSelectionRange(selection.start, selection.end);
    } catch {
      // Number inputs have no selection.
    }
  };
  // `insertText` edits like typing: React's onChange fires and Ctrl+Z undoes it.
  const insert = (text: string) => {
    focus();
    if (!document.execCommand("insertText", false, text)) field.setRangeText(text, selection.start, selection.end, "end");
  };

  const items: MenuEntry[] = [
    {
      label: "Undo",
      shortcut: "Ctrl+Z",
      disabled: readOnly,
      action: () => {
        focus();
        document.execCommand("undo");
      },
    },
    "separator",
    {
      label: "Cut",
      shortcut: "Ctrl+X",
      disabled: readOnly || secret || !selected,
      action: () => {
        void writeText(selected).catch(() => navigator.clipboard.writeText(selected));
        insert("");
      },
    },
    {
      label: "Copy",
      shortcut: "Ctrl+C",
      disabled: secret || !selected,
      action: () => void writeText(selected).catch(() => navigator.clipboard.writeText(selected)),
    },
    {
      label: "Paste",
      shortcut: "Ctrl+V",
      disabled: readOnly,
      action: () =>
        void readText()
          .catch(() => navigator.clipboard.readText())
          .then((text) => {
            if (!text) return focus();
            // A one-line field takes one line.
            insert(field instanceof HTMLInputElement ? text.replace(/\r?\n/g, " ") : text);
          })
          .catch(focus),
    },
    "separator",
    {
      label: "Select All",
      shortcut: "Ctrl+A",
      disabled: !field.value,
      action: () => {
        field.focus();
        field.select();
      },
    },
  ];
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/**
 * The WebView's browser menu never shows. Text fields get PowerCode's menu; other
 * places either have their own (the editor, the terminal, tree rows) or none.
 */
export function TextFieldMenus() {
  const [menu, setMenu] = useState<{ field: Field; selection: Selection; x: number; y: number } | null>(null);
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // A component already showed its own menu (or handled the click).
      if (e.defaultPrevented) return;
      e.preventDefault();
      const field = textField(e.target);
      if (!field) return;
      setMenu({ field, selection: { start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 }, x: e.clientX, y: e.clientY });
    };
    // Bubbling, after React's handlers (the editor's and the trees' menus prevent the default).
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
  return menu ? <TextFieldMenu {...menu} onClose={() => setMenu(null)} /> : null;
}
