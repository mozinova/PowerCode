import { useEffect, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { closeActiveTab, lastRoot, openFolder, saveActive } from "./actions";
import { MainToolbar, StatusBar } from "./components/Chrome";
import { EditorArea } from "./components/EditorArea";
import { CommitView } from "./components/CommitView";
import { ExtensionsView } from "./components/ExtensionsView";
import { focusCommandPalette, focusFileSearch } from "./components/FileSearch";
import { ProjectView } from "./components/ProjectView";
import { RemoteFolderPicker } from "./components/RemoteFolderPicker";
import { RemoteView } from "./components/RemoteView";
import { BottomToolButtons, ToolStripe } from "./components/ToolStripes";
import { SearchView, focusFindInFiles } from "./components/SearchView";
import { TerminalPanel } from "./components/TerminalPanel";
import { ExtensionViewContainer } from "./components/ExtensionViews";
import { HostDialogs } from "./components/HostDialogs";
import { OutputPanel } from "./components/OutputPanel";
import { Toasts } from "./components/Toasts";
import { TooltipLayer } from "./components/Tooltip";
import { WebviewLayer } from "./components/WebviewFrame";
import { initExtensions, startExtensionUpdates } from "./extensions/runtime";
import { startAutoSave } from "./editor/autosave";
import { startExtensionHost } from "./exthost/host";
import { startGitWatcher } from "./git/store";
import type { ToolId } from "./state/workspace";
import { useWorkspace } from "./state/workspace";

let initialized = false;

const TOOL_WINDOWS: Partial<Record<ToolId, ReactNode>> = {
  project: <ProjectView />,
  commit: <CommitView />,
  search: <SearchView />,
  remote: <RemoteView />,
  extensions: <ExtensionsView />,
};

/** The content of a tool window, in whichever sidebar it is. */
function toolWindow(tool: ToolId): ReactNode {
  return TOOL_WINDOWS[tool] ?? <ExtensionViewContainer key={tool} tool={tool} />;
}

/** IDE-wide shortcuts, handled in the capture phase so Monaco does not swallow them. */
function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const { toggleTool, toggleBottomTool } = useWorkspace.getState();
      let handled = true;
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "s") void saveActive();
      else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "o") void openFolder();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "n") focusFileSearch();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") focusCommandPalette();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") focusFindInFiles();
      else if (e.altKey && !ctrl && e.code === "Digit0") toggleTool("commit");
      else if (e.altKey && !ctrl && e.code === "Digit9") toggleTool("commit");
      else if (ctrl && e.key === "F4") closeActiveTab();
      else if (ctrl && !e.shiftKey && e.key === "\\") useWorkspace.getState().splitRight();
      else if (e.altKey && !ctrl && e.code === "Digit1") toggleTool("project");
      else if (e.altKey && !ctrl && e.code === "Digit2") toggleTool("extensions");
      else if (e.altKey && !ctrl && e.key === "F12") toggleBottomTool("terminal");
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

/** Suppresses the WebView's browser context menu outside text fields; the IDE provides its own menus. */
function useNoNativeContextMenu() {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest("input, textarea, [contenteditable=true]")) e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

export default function App() {
  const leftTool = useWorkspace((s) => s.leftTool);
  const bottomTool = useWorkspace((s) => s.bottomTool);
  const rightTool = useWorkspace((s) => s.rightTool);

  useGlobalShortcuts();
  useNoNativeContextMenu();

  useEffect(() => {
    // Runs once per app, not per (StrictMode) mount.
    if (initialized) return;
    initialized = true;
    void initExtensions();
    startExtensionUpdates();
    startExtensionHost();
    startGitWatcher();
    startAutoSave();
    const previous = lastRoot();
    if (previous) void openFolder(previous);
  }, []);

  return (
    <div className="relative flex h-full flex-col bg-frame">
      {/* One glow behind both the title bar and the stripe, painted under them. */}
      <div aria-hidden className="frame-glow pointer-events-none absolute inset-x-0 top-0 h-80" />
      <MainToolbar />
      {/* Tool windows and the editor are islands floating on the frame, as in IntelliJ's Islands theme. */}
      <div className="island-area relative flex min-h-0 flex-1">
        <ToolStripe side="left" footer={<BottomToolButtons />} />
        <Group orientation="vertical" className="min-w-0 flex-1">
          <Panel id="main" minSize={120}>
            <Group orientation="horizontal">
              {leftTool && (
                <>
                  <Panel id="left" defaultSize={300} minSize={180}>
                    <div className="island">
                      {toolWindow(leftTool)}
                    </div>
                  </Panel>
                  <Separator className="island-gap" />
                </>
              )}
              <Panel id="editor" minSize={240}>
                <div className="island">
                  <EditorArea />
                </div>
              </Panel>
              {rightTool && (
                <>
                  <Separator className="island-gap" />
                  <Panel id="right" defaultSize={300} minSize={180}>
                    <div className="island">
                      {toolWindow(rightTool)}
                    </div>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          {bottomTool && (
            <>
              <Separator className="island-gap" />
              <Panel id="bottom" defaultSize={260} minSize={100}>
                <div className="island">{bottomTool === "output" ? <OutputPanel /> : <TerminalPanel />}</div>
              </Panel>
            </>
          )}
        </Group>
        <ToolStripe side="right" />
      </div>
      <StatusBar />
      <RemoteFolderPicker />
      <WebviewLayer />
      <HostDialogs />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
