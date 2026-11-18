import { Columns2, FileText, Rows2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { monaco } from "../editor/monaco";
import { editorOptions, followEditorSettings } from "../editor/options";
import { uriToPath } from "../editor/uris";
import { documentModel, isWritableDocument, releaseDocumentModels } from "../exthost/virtualDocuments";
import { errorMessage } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "./ui";

const isFile = (uri: string) => /^(file|ssh):/.test(uri);

/** A short name for one side: the file name, or the URI's last segment. */
function sideLabel(uri: string) {
  const parsed = monaco.Uri.parse(uri);
  return parsed.path.split("/").pop() || uri;
}

/**
 * Compares two documents by URI (`vscode.diff`): files or documents extensions
 * provide. The modified side can be edited when its file or provider allows.
 */
export function CompareView({ original, modified, title }: { original: string; modified: string; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openFile = useWorkspace((s) => s.openFile);

  useEffect(() => {
    const editor = monaco.editor.createDiffEditor(containerRef.current!, {
      automaticLayout: true,
      originalEditable: false,
      readOnly: !isWritableDocument(modified),
      ...editorOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
    });
    editorRef.current = editor;
    const unfollow = followEditorSettings(editor);
    let cancelled = false;
    setError(null);
    Promise.all([documentModel(original, true), documentModel(modified, true)]).then(
      ([before, after]) => {
        if (!cancelled) editor.setModel({ original: before, modified: after });
      },
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
      unfollow();
      // The models belong to the documents, not to this view: they go when no tab shows them.
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      releaseDocumentModels();
    };
  }, [original, modified]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div className="absolute inset-0 flex flex-col bg-editor">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs text-fg-muted">
        <span className="truncate font-medium text-fg">{title}</span>
        <span className="truncate font-code">
          {sideLabel(original)} ↔ {sideLabel(modified)}
        </span>
        <div className="flex-1" />
        <IconButton
          icon={sideBySide ? Rows2 : Columns2}
          title={sideBySide ? "Show Inline" : "Show Side by Side"}
          onClick={() => setSideBySide(!sideBySide)}
          className="size-6"
          size={14}
        />
        {isFile(modified) && (
          <IconButton icon={FileText} title="Open File" onClick={() => openFile(uriToPath(modified))} className="size-6" size={14} />
        )}
      </div>
      {error && <p className="px-3 py-2 text-danger">{error}</p>}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
