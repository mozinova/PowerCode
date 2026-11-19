import { useEffect, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { closeActiveTab, lastRoot, openFolder, openSettings, saveActive } from "./actions";
import { isNewWindow, listenForOpenRequests, openFiles, takeStartupRequests } from "./cli";
import { MainToolbar, StatusBar } from "./components/Chrome";
import { EditorArea } from "./components/EditorArea";
import { CommitView } from "./components/CommitView";
import { ExtensionsView } from "./components/ExtensionsView";
import { focusCommandPalette, focusFileSearch, focusSymbolSearch } from "./components/FileSearch";
import { runTask } from "./exthost/tasks";
import { ProjectView } from "./components/ProjectView";
import { RemoteFolderPicker } from "./components/RemoteFolderPicker";
import { RemoteView } from "./components/RemoteView";
import { BottomToolButtons, ToolStripe } from "./components/ToolStripes";
import { SearchView, focusFindInFiles } from "./components/SearchView";
import { TerminalPanel } from "./components/TerminalPanel";
import { DebugConsole } from "./components/DebugConsole";
import { DebugView } from "./components/DebugView";
import { TestingView } from "./components/TestingView";
import { ChatView } from "./components/ChatView";
import { ExtensionViewContainer } from "./components/ExtensionViews";
import { HostDialogs } from "./components/HostDialogs";
import { OutputPanel } from "./components/OutputPanel";
import { Toasts } from "./components/Toasts";
import { TooltipLayer } from "./components/Tooltip";
import { TrustDialog } from "./components/TrustDialog";
import { GitHubSignIn } from "./components/GitHubSignIn";
import { WebviewLayer } from "./components/WebviewFrame";
import { initExtensions, startExtensionUpdates } from "./extensions/runtime";
import { startAutoSave } from "./editor/autosave";
import { startExternalChangeWatcher } from "./editor/externalChanges";
import { startSessionSaving } from "./state/session";
import { startExtensionHost } from "./exthost/host";
import { watchIndentationSettings } from "./editor/options";
import { loadUserSettings } from "./settings/store";
import { startDebugging } from "./debug/launch";
import { debugPause, debugRestart, debugStepInto, debugStepOut, debugStepOver, debugStop, toggleBreakpointAtCursor, useDebug } from "./debug/model";
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
  debug: <DebugView />,
  testing: <TestingView />,
  chat: <ChatView />,
};

/** The content of a tool window, in whichever sidebar it is. */
function toolWindow(tool: ToolId): ReactNode {
  return TOOL_WINDOWS[tool] ?? <ExtensionViewContainer key={tool} tool={tool} />;
}

/** Debugger keys, as in VS Code: F5 start/continue, F10/F11 step, F9 breakpoint, ... */
function debugShortcut(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const running = useDebug.getState().sessions.length > 0;
  if (e.key === "F5" && ctrl && e.shiftKey) void debugRestart();
  else if (e.key === "F5" && e.shiftKey) void debugStop();
  else if (e.key === "F5" && ctrl) void startDebugging(true);
  else if (e.key === "F5") void startDebugging();
  else if (e.key === "F9" && !ctrl && !e.shiftKey) toggleBreakpointAtCursor();
  else if (!running) return false;
  else if (e.key === "F6") void debugPause();
  else if (e.key === "F10") void debugStepOver();
  else if (e.key === "F11" && e.shiftKey) void debugStepOut();
  else if (e.key === "F11") void debugStepInto();
  else return false;
  return true;
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
      else if (ctrl && !e.shiftKey && e.key === ",") openSettings();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "n") focusFileSearch();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "p") focusCommandPalette();
      else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "t") focusSymbolSearch();
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "b") void runTask("build");
      else if (ctrl && e.altKey && e.key.toLowerCase() === "i") toggleTool("chat");
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") focusFindInFiles();
      else if (e.altKey && !ctrl && e.code === "Digit0") toggleTool("commit");
      else if (e.altKey && !ctrl && e.code === "Digit9") toggleTool("commit");
      else if (ctrl && e.key === "F4") closeActiveTab();
      else if (ctrl && !e.shiftKey && e.key === "\\") useWorkspace.getState().splitRight();
      else if (e.altKey && !ctrl && e.code === "Digit1") toggleTool("project");
      else if (e.altKey && !ctrl && e.code === "Digit2") toggleTool("extensions");
      else if (e.altKey && !ctrl && e.key === "F12") toggleBottomTool("terminal");
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "d") toggleTool("debug");
      else if (ctrl && e.shiftKey && e.key.toLowerCase() === "y") toggleBottomTool("debug");
      else if (debugShortcut(e)) {
        // Handled.
      }
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
    void loadUserSettings();
    watchIndentationSettings();
    void initExtensions();
    startExtensionUpdates();
    startExtensionHost();
    startGitWatcher();
    startAutoSave();
    startExternalChangeWatcher();
    startSessionSaving();
    // A folder given on the command line (or "Open with") wins over the last one.
    listenForOpenRequests();
    void Promise.all([takeStartupRequests(), isNewWindow()]).then(async ([requests, newWindow]) => {
      const folder = requests.find((r) => r.isDir);
      const previous = lastRoot();
      if (folder) await openFolder(folder.path);
      // A new window starts empty; the first one reopens the last folder.
      else if (previous && !newWindow) await openFolder(previous);
      openFiles(requests);
    });
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
                <div className="island">
                  {bottomTool === "output" ? <OutputPanel /> : bottomTool === "debug" ? <DebugConsole /> : <TerminalPanel />}
                </div>
              </Panel>
            </>
          )}
        </Group>
        <ToolStripe side="right" />
      </div>
      <StatusBar />
      <RemoteFolderPicker />
      <WebviewLayer />
      <TrustDialog />
      <GitHubSignIn />
      <HostDialogs />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
