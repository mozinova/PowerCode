import { Columns2, FileText, Rows2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { monaco } from "../editor/monaco";
import { getModel } from "../editor/models";
import { headContent } from "../git/gutter";
import { fileState, useGit } from "../git/store";
import { errorMessage, fsApi, gitApi } from "../lib/ipc";
import { basename } from "../lib/paths";
import { pathKey } from "../lib/platform";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "./ui";

/** URI of a model created by the diff view; keeps the extension for language detection. */
function diffUri(scheme: string, path: string) {
  return monaco.Uri.from({ scheme, path: "/" + path.replace(/\\/g, "/") });
}

/** Reuses this view's model for `uri`, updating its text, or creates it. */
function ownModel(uri: monaco.Uri, text: string) {
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
  if (model.getValue() !== text) model.setValue(text);
  return model;
}

/**
 * Compares two versions of a file side by side (or inline):
 * - without `revision`: HEAD with the current content, including unsaved edits;
 * - with `revision`: the change a commit made, i.e. `revision^` with `revision`.
 * Both sides are read-only; "Open File" edits the file.
 */
export function DiffView({ path, revision }: { path: string; revision?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const head = useGit((s) => s.status?.head ?? null);
  const state = useGit((s) => {
    const file = s.files.get(pathKey(path));
    return file ? fileState(file) : null;
  });
  const root = useWorkspace((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const scheme = revision ? `diff-${revision}` : "diff-current";

  useEffect(() => {
    const editor = monaco.editor.createDiffEditor(containerRef.current!, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      // The modified side is the open file's own model unless it was created here.
      monaco.editor.getModel(diffUri(scheme, path))?.dispose();
      editorRef.current = null;
    };
  }, [path, scheme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  // Working tree diffs reload when HEAD moves or the file's status changes;
  // a commit's diff never changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      let original: string;
      let modified: monaco.editor.ITextModel;
      if (revision) {
        if (!root) return;
        // A root commit has no parent: everything in it was added.
        const [before, after] = await Promise.all([
          gitApi.showAt(root, `${revision}^`, path).catch(() => null),
          gitApi.showAt(root, revision, path),
        ]);
        original = before ?? "";
        modified = ownModel(diffUri(scheme, path), after ?? "");
      } else {
        original = state === "added" || state === "untracked" ? "" : ((await headContent(path)) ?? "");
        // The open file's model, so unsaved edits show; otherwise the file on disk.
        modified =
          getModel(path) ??
          ownModel(diffUri(scheme, path), state === "deleted" ? "" : await fsApi.readTextFile(path));
      }
      const editor = editorRef.current;
      if (cancelled || !editor) return;
      const previous = editor.getModel();
      editor.setModel({
        original: monaco.editor.createModel(original, modified.getLanguageId()),
        modified,
      });
      previous?.original.dispose();
    })().catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [path, revision, scheme, root, revision ? null : head, revision ? null : state]);

  return (
    <div className="absolute inset-0 flex flex-col bg-editor">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs text-fg-muted">
        <span className="font-medium text-fg">{basename(path)}</span>
        <span className="font-code">
          {revision ? `${revision.slice(0, 8)}^ ↔ ${revision.slice(0, 8)}` : "HEAD ↔ Working Tree"}
        </span>
        <div className="flex-1" />
        <IconButton
          icon={sideBySide ? Rows2 : Columns2}
          title={sideBySide ? "Show Inline" : "Show Side by Side"}
          onClick={() => setSideBySide(!sideBySide)}
          className="size-6"
          size={14}
        />
        {state !== "deleted" && (
          <IconButton icon={FileText} title="Open File" onClick={() => openFile(path)} className="size-6" size={14} />
        )}
      </div>
      {error && <p className="px-3 py-2 text-danger">{error}</p>}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
