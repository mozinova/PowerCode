import { ChevronDown, ClipboardPaste, Copy, Eraser, Minus, Plus, Sparkles, TextSelect, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { remoteOf } from "../lib/remote";
import { useWorkspace } from "../state/workspace";
import {
  closeTerminal,
  currentTerminalBackground,
  loadTerminalProfiles,
  newTerminal,
  setActiveTerminal,
  setDefaultTerminalProfile,
  useTerminals,
} from "../terminal/sessions";
import { DotsSpinner } from "./AiView";
import { ContextMenu, DropdownMenu, type MenuEntry } from "./Menu";
import { IconButton } from "./ui";
import { tooltipProps } from "./Tooltip";

/** "+" opens the default profile; the arrow lists every profile and picks the default. */
function NewTerminalButton({ root }: { root: string | null }) {
  const profiles = useTerminals((s) => s.profiles);
  const defaultProfile = useTerminals((s) => s.defaultProfile);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Remote workspaces always open the remote shell, so profiles do not apply.
  const remote = remoteOf(root);

  const items: MenuEntry[] = [
    ...profiles.map((p) => ({ label: p.name, action: () => newTerminal(root, p.id) })),
    "separator",
    { label: "Default Profile", disabled: true, action: () => {} },
    ...profiles.map((p) => ({
      label: p.name,
      checked: p.id === defaultProfile,
      action: () => setDefaultTerminalProfile(p.id),
    })),
  ];

  return (
    <div ref={anchorRef} className="flex items-center">
      <IconButton icon={Plus} title="New Terminal" onClick={() => newTerminal(root)} className="size-7" />
      {!remote && profiles.length > 0 && (
        <IconButton icon={ChevronDown} title="Terminal Profiles" onClick={() => setOpen(!open)} active={open} className="h-7 w-5" size={13} />
      )}
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
    </div>
  );
}

export function TerminalPanel() {
  const { sessions, active, generating } = useTerminals();
  const root = useWorkspace((s) => s.root);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  const containerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems: MenuEntry[] = active
    ? [
        { label: "Copy", icon: Copy, shortcut: "Ctrl+Shift+C", disabled: !active.hasSelection(), action: () => active.copySelection() },
        { label: "Paste", icon: ClipboardPaste, shortcut: "Ctrl+Shift+V", action: () => void active.paste() },
        { label: "Select All", icon: TextSelect, action: () => active.selectAll() },
        "separator",
        { label: "Clear Terminal", icon: Eraser, action: () => active.clear() },
        "separator",
        { label: "New Terminal", icon: Plus, action: () => newTerminal(root) },
        {
          label: "Kill Terminal",
          icon: Trash2,
          action: () => {
            closeTerminal(active);
            if (useTerminals.getState().sessions.length === 0) toggleBottomTool("terminal");
          },
        },
      ]
    : [];

  // Opening the tool window with no sessions starts one, like IntelliJ, once the
  // profiles are known so it uses the chosen default.
  useEffect(() => {
    let cancelled = false;
    void loadTerminalProfiles().then(() => {
      if (!cancelled && useTerminals.getState().sessions.length === 0) newTerminal(root);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    active.attach(container);
    const observer = new ResizeObserver(() => active.layout());
    observer.observe(container);
    return () => {
      observer.disconnect();
      active.detach();
    };
  }, [active]);

  return (
    // One surface: the tab bar takes the active terminal's background, with no border between them.
    <div className="flex h-full flex-col" style={{ background: active?.background ?? currentTerminalBackground() }}>
      <div className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-3">
        <span className="mr-2 font-semibold">Terminal</span>
        <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {sessions.map((session) => {
            const isActive = session === active;
            return (
              <div
                key={session.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTerminal(session)}
                className={`group flex h-7 shrink-0 cursor-default items-center gap-1 rounded-md pr-1 pl-2.5 ${
                  isActive ? "bg-white/8 text-fg" : "text-fg-muted hover:bg-white/5 hover:text-fg"
                }`}
              >
                {session.title}
                <button
                  type="button"
                  {...tooltipProps("Close")}
                  aria-label={`Close ${session.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(session);
                    if (useTerminals.getState().sessions.length === 0) toggleBottomTool("terminal");
                  }}
                  className={`flex size-[18px] items-center justify-center rounded hover:bg-white/10 ${
                    isActive ? "visible" : "invisible group-hover:visible"
                  }`}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <NewTerminalButton root={root} />
        <div className="flex-1" />
        {generating ? (
          <div className="mr-2.5 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
            <DotsSpinner size={12} />
            <span>Generating command…</span>
          </div>
        ) : (
          <div className="mr-2.5 hidden items-center gap-1.5 text-xs text-fg-subtle select-none sm:flex">
            <Sparkles size={12} className="text-accent/80" />
            <span>Type</span>
            <kbd className="rounded border border-line-soft bg-input px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent">&gt;</kbd>
            <span>to ask AI for a command suggestion</span>
          </div>
        )}
        <IconButton icon={Minus} title="Hide" onClick={() => toggleBottomTool("terminal")} className="size-7" />
      </div>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
        onClick={() => active?.focus()}
        onContextMenu={(e) => {
          e.preventDefault();
          if (active) setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {generating && (
          <div className="pointer-events-none absolute right-4 bottom-3 z-10 flex items-center gap-2.5 rounded-lg border border-accent/40 bg-panel/95 px-3 py-1.5 text-xs font-medium text-accent shadow-lg shadow-black/40 backdrop-blur-md select-none">
            <DotsSpinner size={13} />
            <span>Generating command…</span>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
