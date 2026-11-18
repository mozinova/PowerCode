import { useEffect, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { closeActiveTab, lastRoot, openFolder, saveActive } from "./actions";
import { MainToolbar, StatusBar, ToolStripe } from "./components/Chrome";
import { EditorArea } from "./components/EditorArea";
import { CommitView } from "./components/CommitView";
import { ExtensionsView } from "./components/ExtensionsView";
import { focusFileSearch } from "./components/FileSearch";
import { ProjectView } from "./components/ProjectView";
import { RemoteFolderPicker } from "./components/RemoteFolderPicker";
import { RemoteView } from "./components/RemoteView";
import { SearchView, focusFindInFiles } from "./components/SearchView";
import { TerminalPanel } from "./components/TerminalPanel";
import { Toasts } from "./components/Toasts";
import { TooltipLayer } from "./components/Tooltip";
import { initExtensions } from "./extensions/runtime";
import { startGitWatcher } from "./git/store";
import type { LeftTool } from "./state/workspace";
import { useWorkspace } from "./state/workspace";

let initialized = false;

const TOOL_WINDOWS: Record<LeftTool, ReactNode> = {
  project: <ProjectView />,
  commit: <CommitView />,
  search: <SearchView />,
  remote: <RemoteView />,
  extensions: <ExtensionsView />,
};

/** IDE-wide shortcuts, handled in the capture phase so Monaco does not swallow them. */
function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const { toggleLeftTool, toggleBottomTool } = useWorkspace.getState();
      let handled = true;
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "s") void saveActive();
      else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "o") void openFolder();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "n") focusFileSearch();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") focusFindInFiles();
      else if (e.altKey && !ctrl && e.code === "Digit0") toggleLeftTool("commit");
      else if (e.altKey && !ctrl && e.code === "Digit9") toggleLeftTool("commit");
      else if (ctrl && e.key === "F4") closeActiveTab();
      else if (e.altKey && !ctrl && e.code === "Digit1") toggleLeftTool("project");
      else if (e.altKey && !ctrl && e.code === "Digit2") toggleLeftTool("extensions");
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

  useGlobalShortcuts();
  useNoNativeContextMenu();

  useEffect(() => {
    // Runs once per app, not per (StrictMode) mount.
    if (initialized) return;
    initialized = true;
    void initExtensions();
    startGitWatcher();
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
        <ToolStripe />
        <Group orientation="vertical" className="min-w-0 flex-1">
          <Panel id="main" minSize={120}>
            <Group orientation="horizontal">
              {leftTool && (
                <>
                  <Panel id="left" defaultSize={300} minSize={180}>
                    <div className="island">{TOOL_WINDOWS[leftTool]}</div>
                  </Panel>
                  <Separator className="island-gap" />
                </>
              )}
              <Panel id="editor" minSize={240}>
                <div className="island">
                  <EditorArea />
                </div>
              </Panel>
            </Group>
          </Panel>
          {bottomTool && (
            <>
              <Separator className="island-gap" />
              <Panel id="bottom" defaultSize={260} minSize={100}>
                <div className="island">
                  <TerminalPanel />
                </div>
              </Panel>
            </>
          )}
        </Group>
      </div>
      <StatusBar />
      <RemoteFolderPicker />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
