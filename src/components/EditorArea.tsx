import { message } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef } from "react";
import { monaco } from "../editor/monaco";
import { loadModel } from "../editor/models";
import { errorMessage } from "../lib/ipc";
import { mediaKind } from "../lib/media";
import { isVirtualTab, parseCommitDiffTab, parseDiffTab, parseExtensionTab } from "../lib/virtualTabs";
import { attachGitGutter } from "../git/gutter";
import { useWorkspace } from "../state/workspace";
import { DiffView } from "./DiffView";
import { EditorTabs } from "./EditorTabs";
import { ExtensionPage } from "./ExtensionPage";
import { MediaViewer } from "./MediaViewer";
import { Kbd } from "./ui";

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

function EmptyEditor() {
  const root = useWorkspace((s) => s.root);
  const hints = root
    ? [
        ["Open File", "Double-click in the Project view"],
        ["Save", "Ctrl+S"],
        ["Project", "Alt+1"],
        ["Terminal", "Alt+F12"],
      ]
    : [
        ["Open Folder", "Ctrl+O"],
        ["Terminal", "Alt+F12"],
      ];
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-editor">
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-2.5 text-[13px]">
        {hints.map(([label, keys]) => (
          <div key={label} className="contents">
            <dt className="text-right text-fg-muted">{label}</dt>
            <dd>
              <Kbd>{keys}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function updateStatus(editor: monaco.editor.ICodeEditor) {
  const { setCursor, setStatus } = useWorkspace.getState();
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    setCursor(null);
    setStatus(null);
    return;
  }
  setCursor({
    line: selection.positionLineNumber,
    column: selection.positionColumn,
    selected: model.getValueLengthInRange(selection),
  });
  const languageId = model.getLanguageId();
  const language = monaco.languages.getLanguages().find((l) => l.id === languageId);
  const options = model.getOptions();
  setStatus({
    language: language?.aliases?.[0] ?? languageId,
    eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
    indent: options.insertSpaces ? `${options.tabSize} spaces` : "Tab",
  });
}

let appliedReveal = 0;

/** Selects the pending reveal location if it is for `path`. */
function applyReveal(editor: monaco.editor.ICodeEditor, path: string) {
  const reveal = useWorkspace.getState().reveal;
  if (!reveal || reveal.path !== path || reveal.nonce === appliedReveal) return;
  appliedReveal = reveal.nonce;
  const selection = new monaco.Selection(reveal.line, reveal.column, reveal.line, reveal.endColumn);
  editor.setSelection(selection);
  editor.revealRangeInCenterIfOutsideViewport(selection);
  editor.focus();
}

function MonacoHost() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPathRef = useRef<string | null>(null);
  const activePath = useWorkspace((s) => s.activePath);

  useEffect(() => {
    const editor = monaco.editor.create(containerRef.current!, {
      model: null,
      automaticLayout: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "all",
      smoothScrolling: true,
      stickyScroll: { enabled: true },
      padding: { top: 6 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerBorder: false,
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    const gutter = attachGitGutter(editor);
    const listeners = [
      editor.onDidChangeCursorSelection(() => updateStatus(editor)),
      editor.onDidChangeModel(() => updateStatus(editor)),
      editor.onDidChangeModelLanguage(() => updateStatus(editor)),
      editor.onDidChangeModelOptions(() => updateStatus(editor)),
    ];
    return () => {
      listeners.forEach((l) => l.dispose());
      gutter.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const previous = shownPathRef.current;
    if (previous && previous !== activePath && editor.getModel() && !editor.getModel()!.isDisposed()) {
      viewStates.set(previous, editor.saveViewState());
    }

    // Media files and pages are shown on top of an empty editor.
    if (!activePath || isVirtualTab(activePath) || mediaKind(activePath)) {
      shownPathRef.current = null;
      editor.setModel(null);
      return;
    }

    let cancelled = false;
    loadModel(activePath).then(
      (model) => {
        if (cancelled) return;
        shownPathRef.current = activePath;
        editor.setModel(model);
        const viewState = viewStates.get(activePath);
        if (viewState) editor.restoreViewState(viewState);
        applyReveal(editor, activePath);
        editor.focus();
      },
      async (e) => {
        if (cancelled) return;
        useWorkspace.getState().closeTab(activePath);
        await message(`Could not open the file:\n${errorMessage(e)}`, {
          title: "PowerCode",
          kind: "error",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // A reveal for the file already shown (e.g. another match in it) applies right away.
  const reveal = useWorkspace((s) => s.reveal);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && reveal && shownPathRef.current === reveal.path) applyReveal(editor, reveal.path);
  }, [reveal]);

  // Forget view states of closed tabs.
  const tabs = useWorkspace((s) => s.tabs);
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.path));
    for (const path of viewStates.keys()) if (!open.has(path)) viewStates.delete(path);
  }, [tabs]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

export function EditorArea() {
  const tabs = useWorkspace((s) => s.tabs);
  const activePath = useWorkspace((s) => s.activePath);
  const extension = activePath ? parseExtensionTab(activePath) : null;
  const diff = activePath ? parseDiffTab(activePath) : null;
  const commitDiff = activePath ? parseCommitDiffTab(activePath) : null;
  const media = activePath && !isVirtualTab(activePath) ? mediaKind(activePath) : null;

  return (
    <div className="flex h-full flex-col bg-editor">
      {tabs.length > 0 && <EditorTabs />}
      <div className="relative min-h-0 flex-1">
        <MonacoHost />
        {!activePath && <EmptyEditor />}
        {activePath && media && <MediaViewer path={activePath} kind={media} />}
        {extension && <ExtensionPage key={activePath} namespace={extension.namespace} name={extension.name} />}
        {diff && <DiffView key={diff} path={diff} />}
        {commitDiff && (
          <DiffView key={activePath} path={commitDiff.file} revision={commitDiff.hash} />
        )}
      </div>
    </div>
  );
}
