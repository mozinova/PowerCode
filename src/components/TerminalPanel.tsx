import { ChevronDown, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { remoteOf } from "../lib/remote";
import { useWorkspace } from "../state/workspace";
import {
  closeTerminal,
  loadTerminalProfiles,
  newTerminal,
  setActiveTerminal,
  setDefaultTerminalProfile,
  useTerminals,
} from "../terminal/sessions";
import { DropdownMenu, type MenuEntry } from "./Menu";
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
  const { sessions, active } = useTerminals();
  const root = useWorkspace((s) => s.root);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  const containerRef = useRef<HTMLDivElement>(null);

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
    <div className="flex h-full flex-col bg-panel">
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
                  isActive ? "bg-selected-inactive text-fg" : "text-fg-muted hover:bg-hover"
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
                  className={`flex size-[18px] items-center justify-center rounded hover:bg-hover ${
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
        <IconButton icon={Minus} title="Hide" onClick={() => toggleBottomTool("terminal")} className="size-7" />
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-editor" onClick={() => active?.focus()} />
    </div>
  );
}
