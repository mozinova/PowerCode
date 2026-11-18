//! Marks added, modified and deleted lines (relative to HEAD) in the editor gutter.

import { diffArrays } from "diff";
import { monaco } from "../editor/monaco";
import { modelPath } from "../editor/models";
import { gitApi } from "../lib/ipc";
import { isWithin } from "../lib/paths";
import { pathKey } from "../lib/platform";
import { useWorkspace } from "../state/workspace";
import { fileState, useGit } from "./store";

/** Large files are skipped: the line diff is quadratic in the worst case. */
const MAX_LINES = 20_000;
const DEBOUNCE_MS = 250;

/** HEAD contents by `head commit + path`, so a new commit invalidates them. */
const headCache = new Map<string, Promise<string | null>>();

export function headContent(path: string): Promise<string | null> {
  const { status } = useGit.getState();
  const root = useWorkspace.getState().root;
  if (!status?.isRepo || !status.head || !root) return Promise.resolve(null);
  const key = `${status.head}:${pathKey(path)}`;
  let content = headCache.get(key);
  if (!content) {
    content = gitApi.showHead(root, path).catch(() => null);
    headCache.set(key, content);
  }
  return content;
}

interface LineChanges {
  added: [number, number][];
  modified: [number, number][];
  /** Lines below which lines were removed (0 = above the first line). */
  deleted: number[];
}

export function lineChanges(oldText: string, newLines: string[]): LineChanges {
  const changes: LineChanges = { added: [], modified: [], deleted: [] };
  const parts = diffArrays(oldText.split(/\r?\n/), newLines);
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const count = part.value.length;
    if (part.removed) {
      const next = parts[i + 1];
      if (next?.added) {
        changes.modified.push([line, line + next.value.length - 1]);
        line += next.value.length;
        i++;
      } else {
        changes.deleted.push(line - 1);
      }
    } else if (part.added) {
      changes.added.push([line, line + count - 1]);
      line += count;
    } else {
      line += count;
    }
  }
  return changes;
}

function decorations(changes: LineChanges, lineCount: number): monaco.editor.IModelDeltaDecoration[] {
  const range = (start: number, end: number, className: string) => ({
    range: new monaco.Range(start, 1, end, 1),
    options: { isWholeLine: true, linesDecorationsClassName: className },
  });
  return [
    ...changes.added.map(([s, e]) => range(s, e, "git-gutter-added")),
    ...changes.modified.map(([s, e]) => range(s, e, "git-gutter-modified")),
    // A deletion is drawn at the boundary below line `n`, i.e. on top of line n + 1.
    ...changes.deleted.map((n) =>
      n < lineCount ? range(n + 1, n + 1, "git-gutter-deleted") : range(n, n, "git-gutter-deleted-below"),
    ),
  ];
}

/** Keeps the editor's gutter marks in sync with its model and the git status. */
export function attachGitGutter(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const collection = editor.createDecorationsCollection();
  let timer: number | undefined;
  let run = 0;

  const update = async () => {
    const current = ++run;
    const model = editor.getModel();
    const path = model && modelPath(model);
    const { status, files } = useGit.getState();
    if (!model || !path || !status?.isRepo || !status.top || !isWithin(path, status.top)) {
      collection.clear();
      return;
    }
    const file = files.get(pathKey(path));
    const state = file && fileState(file);
    // Untracked and ignored files have nothing to compare against.
    if (state === "untracked" || state === "ignored" || model.getLineCount() > MAX_LINES) {
      collection.clear();
      return;
    }
    const head = state === "added" ? "" : await headContent(path);
    if (current !== run || editor.getModel() !== model) return;
    if (head === null) {
      collection.clear();
      return;
    }
    collection.set(decorations(lineChanges(head, model.getLinesContent()), model.getLineCount()));
  };

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void update(), DEBOUNCE_MS);
  };

  const listeners = [
    editor.onDidChangeModel(() => void update()),
    editor.onDidChangeModelContent(schedule),
  ];
  const unsubscribe = useGit.subscribe((state, previous) => {
    if (state.status !== previous.status) schedule();
  });
  void update();

  return {
    dispose() {
      window.clearTimeout(timer);
      listeners.forEach((l) => l.dispose());
      unsubscribe();
      collection.clear();
    },
  };
}
