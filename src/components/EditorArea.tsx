import { message } from "@tauri-apps/plugin-dialog";
import { Fragment, useEffect, useRef } from "react";
import { Group as PanelGroup, Panel, Separator } from "react-resizable-panels";
import { monaco } from "../editor/monaco";
import { loadModel, modelPath } from "../editor/models";
import { errorMessage } from "../lib/ipc";
import { mediaKind } from "../lib/media";
import { isVirtualTab, parseCommitDiffTab, parseDiffTab, parseExtensionTab, parseWebviewTab } from "../lib/virtualTabs";
import { attachGitGutter } from "../git/gutter";
import { useWorkspace, type EditorGroup } from "../state/workspace";
import { DiffView } from "./DiffView";
import { EditorTabs } from "./EditorTabs";
import { ExtensionPage } from "./ExtensionPage";
import { MediaViewer } from "./MediaViewer";
import { WebviewAnchor } from "./WebviewFrame";
import { Kbd } from "./ui";

/** Scroll position and selections per group and file, restored when switching tabs. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const viewKey = (group: number, path: string) => `${group}\u0000${path}`;

const isFocusedGroup = (group: number) => useWorkspace.getState().activeGroup === group;

/** The code editor of each group showing a text file. */
const editors = new Map<number, monaco.editor.IStandaloneCodeEditor>();

/** The focused group's code editor, if it shows a text file. */
export function activeEditor(): monaco.editor.IStandaloneCodeEditor | undefined {
  return editors.get(useWorkspace.getState().activeGroup);
}

// Go to Definition and peek "open" targets in other files as tabs.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (resource.scheme !== "file") return false;
    const model = monaco.editor.getModel(resource);
    const path = (model && modelPath(model)) ?? resource.fsPath;
    const { openFile, openFileAt } = useWorkspace.getState();
    if (!selectionOrPosition) openFile(path);
    else if (monaco.Range.isIRange(selectionOrPosition)) {
      const r = selectionOrPosition;
      openFileAt(path, r.startLineNumber, r.startColumn, r.endColumn, r.endLineNumber);
    } else {
      const p = selectionOrPosition;
      openFileAt(path, p.lineNumber, p.column, p.column);
    }
    return true;
  },
});

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

/** Selects the pending reveal location if it is for `path` and this group is focused. */
function applyReveal(editor: monaco.editor.ICodeEditor, group: number, path: string) {
  const reveal = useWorkspace.getState().reveal;
  if (!reveal || reveal.path !== path || reveal.nonce === appliedReveal || !isFocusedGroup(group)) return;
  appliedReveal = reveal.nonce;
  const selection = new monaco.Selection(reveal.line, reveal.column, reveal.endLine ?? reveal.line, reveal.endColumn);
  editor.setSelection(selection);
  editor.revealRangeInCenterIfOutsideViewport(selection);
  editor.focus();
}

/** The Monaco editor of one group. Files open in two groups share their model. */
function MonacoHost({ group }: { group: EditorGroup }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPathRef = useRef<string | null>(null);
  const activePath = group.activePath;
  const focused = useWorkspace((s) => s.activeGroup === group.id);

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
      // Extension grammars colour code through semantic tokens (see editor/textmate.ts).
      // A global option: it also applies to the diff editors.
      "semanticHighlighting.enabled": true,
    });
    editorRef.current = editor;
    editors.set(group.id, editor);
    const gutter = attachGitGutter(editor);
    // Only the focused group's editor drives the status bar.
    const status = () => isFocusedGroup(group.id) && updateStatus(editor);
    const listeners = [
      editor.onDidChangeCursorSelection(status),
      editor.onDidChangeModel(status),
      editor.onDidChangeModelLanguage(status),
      editor.onDidChangeModelOptions(status),
      editor.onDidFocusEditorText(() => useWorkspace.getState().focusGroup(group.id)),
    ];
    return () => {
      listeners.forEach((l) => l.dispose());
      gutter.dispose();
      if (editors.get(group.id) === editor) editors.delete(group.id);
      editor.dispose();
      editorRef.current = null;
    };
  }, [group.id]);

  // Switching groups shows the newly focused editor's position in the status bar.
  useEffect(() => {
    if (focused && editorRef.current) updateStatus(editorRef.current);
  }, [focused]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const previous = shownPathRef.current;
    if (previous && previous !== activePath && editor.getModel() && !editor.getModel()!.isDisposed()) {
      viewStates.set(viewKey(group.id, previous), editor.saveViewState());
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
        const viewState = viewStates.get(viewKey(group.id, activePath));
        if (viewState) editor.restoreViewState(viewState);
        applyReveal(editor, group.id, activePath);
        // A background group loading its file must not steal focus.
        if (isFocusedGroup(group.id)) editor.focus();
      },
      async (e) => {
        if (cancelled) return;
        useWorkspace.getState().closeTab(activePath, group.id);
        await message(`Could not open the file:\n${errorMessage(e)}`, {
          title: "PowerCode",
          kind: "error",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [activePath, group.id]);

  // A reveal for the file already shown (e.g. another match in it) applies right away.
  const reveal = useWorkspace((s) => s.reveal);
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && reveal && shownPathRef.current === reveal.path) applyReveal(editor, group.id, reveal.path);
  }, [reveal, group.id]);

  // Forget view states of tabs this group closed.
  useEffect(() => {
    const open = new Set(group.tabs.map((t) => viewKey(group.id, t.path)));
    const prefix = viewKey(group.id, "");
    for (const key of viewStates.keys()) if (key.startsWith(prefix) && !open.has(key)) viewStates.delete(key);
  }, [group.tabs, group.id]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

function EditorGroupView({ group, split }: { group: EditorGroup; split: boolean }) {
  const focused = useWorkspace((s) => s.activeGroup === group.id);
  const focusGroup = useWorkspace((s) => s.focusGroup);
  const activePath = group.activePath;
  const extension = activePath ? parseExtensionTab(activePath) : null;
  const diff = activePath ? parseDiffTab(activePath) : null;
  const commitDiff = activePath ? parseCommitDiffTab(activePath) : null;
  const webview = activePath ? parseWebviewTab(activePath) : null;
  const media = activePath && !isVirtualTab(activePath) ? mediaKind(activePath) : null;

  return (
    // Any click inside a group (tabs, editor, pages) focuses it.
    <div className="flex h-full flex-col bg-editor" onMouseDownCapture={() => focusGroup(group.id)}>
      {group.tabs.length > 0 && <EditorTabs group={group} focused={focused || !split} />}
      <div className="relative min-h-0 flex-1">
        <MonacoHost group={group} />
        {!activePath && <EmptyEditor />}
        {activePath && media && <MediaViewer path={activePath} kind={media} />}
        {extension && <ExtensionPage key={activePath} namespace={extension.namespace} name={extension.name} />}
        {diff && <DiffView key={diff} path={diff} />}
        {commitDiff && <DiffView key={activePath} path={commitDiff.file} revision={commitDiff.hash} />}
        {webview && (
          <div className="absolute inset-0 bg-editor">
            <WebviewAnchor id={webview} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The editor groups side by side (Split Editor), resizable. */
export function EditorArea() {
  const groups = useWorkspace((s) => s.groups);
  // Always the same container, so splitting does not recreate the first group's editor.
  return (
    <PanelGroup orientation="horizontal" className="h-full">
      {groups.map((group, i) => (
        <Fragment key={group.id}>
          {i > 0 && <Separator />}
          <Panel id={`editor-group-${group.id}`} minSize={200}>
            <EditorGroupView group={group} split={groups.length > 1} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
