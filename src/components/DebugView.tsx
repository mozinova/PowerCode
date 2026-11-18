import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  CirclePlay,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCw,
  Settings,
  Square,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  removeBreakpoints,
  setAllEnabled,
  updateBreakpoint,
  useBreakpoints,
} from "../debug/breakpoints";
import { loadLaunchConfigurations, openLaunchJson, selectConfiguration, startDebugging, useLaunch } from "../debug/launch";
import {
  dap,
  debugContinue,
  debugPause,
  debugRestart,
  debugStepInto,
  debugStepOut,
  debugStepOver,
  debugStop,
  evaluate,
  focusFrame,
  useDebug,
  type SessionState,
} from "../debug/model";
import { basename } from "../lib/paths";
import { useWorkspace } from "../state/workspace";
import { Codicon } from "./ExtIcon";
import { Select } from "./Select";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";
import { VariableChildren, VariableRow } from "./VariableTree";

function Section({ title, actions, children, grow = false }: { title: string; actions?: ReactNode; children: ReactNode; grow?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div role="group" className={`flex min-h-0 flex-col ${open && grow ? "flex-1" : ""}`}>
      <div className="group flex h-7 shrink-0 items-center border-t border-line-soft pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 px-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase hover:text-fg"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </button>
        {open && actions && <span className="invisible flex items-center group-hover:visible">{actions}</span>}
      </div>
      {open && <div className="min-h-0 overflow-auto pb-1">{children}</div>}
    </div>
  );
}

function ToolbarButton({ icon: Icon, title, shortcut, onClick, color }: { icon: LucideIcon; title: string; shortcut?: string; onClick: () => void; color?: string }) {
  return (
    <button
      type="button"
      {...tooltipProps(title, shortcut)}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      style={color ? { color } : undefined}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}

/** Continue/pause, steps, restart and stop, while a session runs. */
function DebugToolbar() {
  const stopped = useDebug((s) => s.sessions.some((x) => x.status === "stopped"));
  return (
    <div className="flex items-center gap-0.5 px-2 pb-1.5">
      {stopped ? (
        <ToolbarButton icon={Play} title="Continue" shortcut="F5" onClick={() => void debugContinue()} color="#5fb865" />
      ) : (
        <ToolbarButton icon={Pause} title="Pause" shortcut="F6" onClick={() => void debugPause()} />
      )}
      <button
        type="button"
        {...tooltipProps("Step Over", "F10")}
        aria-label="Step Over"
        onClick={() => void debugStepOver()}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Codicon name="debug-step-over" />
      </button>
      <button
        type="button"
        {...tooltipProps("Step Into", "F11")}
        aria-label="Step Into"
        onClick={() => void debugStepInto()}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Codicon name="debug-step-into" />
      </button>
      <button
        type="button"
        {...tooltipProps("Step Out", "Shift+F11")}
        aria-label="Step Out"
        onClick={() => void debugStepOut()}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Codicon name="debug-step-out" />
      </button>
      <ToolbarButton icon={RotateCw} title="Restart" shortcut="Ctrl+Shift+F5" onClick={() => void debugRestart()} color="#5fb865" />
      <ToolbarButton icon={Square} title="Stop" shortcut="Shift+F5" onClick={() => void debugStop()} color="#db5c5c" />
    </div>
  );
}

function Variables() {
  const focus = useDebug((s) => s.focus);
  const generation = useDebug((s) => s.generation);
  const [scopes, setScopes] = useState<{ name: string; variablesReference: number; expensive?: boolean }[]>([]);
  useEffect(() => {
    if (!focus || focus.frameId === null) return setScopes([]);
    let cancelled = false;
    dap<{ scopes: typeof scopes }>(focus.sessionId, "scopes", { frameId: focus.frameId })
      .then((r) => !cancelled && setScopes(r?.scopes ?? []))
      .catch(() => !cancelled && setScopes([]));
    return () => {
      cancelled = true;
    };
  }, [focus?.sessionId, focus?.frameId, generation]);
  if (!focus || scopes.length === 0) return <div className="px-4 py-1 text-xs text-fg-muted">Not paused.</div>;
  return (
    <div role="tree">
      {scopes.map((scope, i) => (
        <ScopeRow key={`${scope.name}-${i}`} sessionId={focus.sessionId} scope={scope} initiallyOpen={i === 0 && !scope.expensive} />
      ))}
    </div>
  );
}

function ScopeRow({ sessionId, scope, initiallyOpen }: { sessionId: string; scope: { name: string; variablesReference: number }; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <div onClick={() => setOpen(!open)} className="flex h-[22px] cursor-default items-center gap-1 px-1 text-xs font-medium hover:bg-hover">
        {open ? <ChevronDown size={13} className="text-fg-muted" /> : <ChevronRight size={13} className="text-fg-muted" />}
        {scope.name}
      </div>
      {open && <VariableChildren sessionId={sessionId} reference={scope.variablesReference} depth={1} />}
    </>
  );
}

const WATCH_KEY = "powercode.watch";

function storedWatches(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function Watch() {
  const [expressions, setExpressions] = useState(storedWatches);
  const [adding, setAdding] = useState(false);
  const focus = useDebug((s) => s.focus);
  const generation = useDebug((s) => s.generation);
  const [values, setValues] = useState<Record<string, { result: string; variablesReference: number; sessionId: string } | { error: string }>>({});
  const save = (next: string[]) => {
    setExpressions(next);
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(next));
    } catch {
      // Not remembered.
    }
  };
  useEffect(() => {
    if (!focus) return setValues({});
    let cancelled = false;
    void Promise.all(
      expressions.map(async (e) => {
        try {
          return [e, await evaluate(e, "watch")] as const;
        } catch (err) {
          return [e, { error: err instanceof Error ? err.message : String(err) }] as const;
        }
      }),
    ).then((entries) => !cancelled && setValues(Object.fromEntries(entries)));
    return () => {
      cancelled = true;
    };
  }, [expressions, focus?.sessionId, focus?.frameId, generation]);

  return (
    <Section
      title="Watch"
      actions={<IconButton icon={Plus} title="Add Expression" onClick={() => setAdding(true)} className="size-6" size={14} />}
    >
      {expressions.map((expression) => {
        const value = values[expression];
        return (
          <div key={expression} className="group/watch relative">
            {value && "result" in value ? (
              <VariableRow sessionId={value.sessionId} variable={{ name: expression, value: value.result, variablesReference: value.variablesReference }} depth={0} />
            ) : (
              <div className="flex h-[22px] items-center gap-1 pr-6 pl-5 font-mono text-xs">
                <span className="text-[#c77dbb]">{expression}</span>
                <span className="text-fg-muted">=</span>
                <span className="truncate text-fg-muted">{value && "error" in value ? value.error : "not available"}</span>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove ${expression}`}
              onClick={() => save(expressions.filter((e) => e !== expression))}
              className="invisible absolute top-0.5 right-1 flex size-[18px] items-center justify-center rounded text-fg-muted group-hover/watch:visible hover:bg-hover"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {adding && (
        <input
          autoFocus
          placeholder="Expression to watch"
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            const value = e.currentTarget.value.trim();
            if (e.key === "Enter" && value) {
              save([...expressions, value]);
              setAdding(false);
            }
            if (e.key === "Escape") setAdding(false);
          }}
          className="mx-2 my-0.5 h-6 w-[calc(100%-16px)] rounded border border-accent bg-input px-1.5 font-mono text-xs outline-none"
        />
      )}
      {expressions.length === 0 && !adding && <div className="px-4 py-1 text-xs text-fg-muted">No expressions.</div>}
    </Section>
  );
}

function CallStack() {
  const sessions = useDebug((s) => s.sessions);
  const focus = useDebug((s) => s.focus);
  if (sessions.length === 0) return <div className="px-4 py-1 text-xs text-fg-muted">Not debugging.</div>;
  return (
    <div role="tree" className="text-xs">
      {sessions.map((session) => (
        <SessionRows key={session.id} session={session} focusFrameId={focus?.sessionId === session.id ? focus.frameId : null} />
      ))}
    </div>
  );
}

function SessionRows({ session, focusFrameId }: { session: SessionState; focusFrameId: number | null }) {
  const statusLabel = session.status === "stopped" ? "Paused" : session.status === "running" ? "Running" : session.status === "initializing" ? "Starting" : "";
  return (
    <>
      <div className="flex h-[22px] items-center gap-1.5 px-2 font-medium">
        <CircleDot size={12} className={session.status === "stopped" ? "text-[#e0b84c]" : "text-[#5fb865]"} />
        <span className="truncate">{session.name}</span>
        <span className="text-fg-subtle">{statusLabel}</span>
      </div>
      {session.threads.map((thread) => (
        <div key={thread.id}>
          {session.threads.length > 1 && (
            <div className="flex h-[22px] items-center gap-1.5 pl-6 text-fg-muted">
              {thread.name}
              <span className="text-fg-subtle">{thread.stopped ? `Paused${thread.reason ? ` on ${thread.reason}` : ""}` : "Running"}</span>
            </div>
          )}
          {(thread.frames ?? []).map((frame) => (
            <div
              key={frame.id}
              onClick={() => focusFrame(session.id, thread.id, frame)}
              className={`flex h-[22px] cursor-default items-center gap-1.5 pr-2 pl-7 ${
                focusFrameId === frame.id ? "bg-selected-inactive" : "hover:bg-hover"
              } ${frame.presentationHint === "subtle" || !frame.source?.path ? "text-fg-muted" : ""}`}
            >
              <span className="min-w-0 truncate">{frame.name}</span>
              <span className="ml-auto shrink-0 text-fg-subtle">
                {frame.source?.name ?? (frame.source?.path ? basename(frame.source.path) : "")}
                {frame.line ? `:${frame.line}` : ""}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Breakpoints() {
  const list = useBreakpoints((s) => s.list);
  const status = useBreakpoints((s) => s.status);
  const root = useWorkspace((s) => s.root);
  if (list.length === 0) return <div className="px-4 py-1 text-xs text-fg-muted">Click the gutter (or F9) to add one.</div>;
  return (
    <div className="text-xs">
      {list.map((b) => (
        <div
          key={b.id}
          onClick={() => useWorkspace.getState().openFileAt(b.path, b.line, 1, 1)}
          className="group/bp flex h-[22px] cursor-default items-center gap-1.5 pr-1.5 pl-2 hover:bg-hover"
          {...tooltipProps(status[b.id]?.message ?? b.path)}
        >
          <input
            type="checkbox"
            checked={b.enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateBreakpoint(b.id, { enabled: e.target.checked })}
            className="size-3.5 accent-accent"
          />
          <span className={`pc-bp-dot ${!b.enabled ? "opacity-40" : status[b.id]?.verified === false ? "pc-bp-dot-unverified" : ""}`} />
          <span className="truncate">{basename(b.path)}</span>
          <span className="shrink-0 text-fg-subtle">{b.line}</span>
          <span className="min-w-0 truncate text-fg-subtle">{root && b.path.startsWith(root) ? b.path.slice(root.length + 1).replace(/[\\/][^\\/]*$/, "") : ""}</span>
          <button
            type="button"
            aria-label="Remove breakpoint"
            onClick={(e) => {
              e.stopPropagation();
              removeBreakpoints([b.id]);
            }}
            className="invisible ml-auto flex size-[18px] shrink-0 items-center justify-center rounded text-fg-muted group-hover/bp:visible hover:bg-hover"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The Run and Debug tool window. */
export function DebugView() {
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const root = useWorkspace((s) => s.root);
  const configurations = useLaunch((s) => s.configurations);
  const compounds = useLaunch((s) => s.compounds);
  const selected = useLaunch((s) => s.selected);
  const debugging = useDebug((s) => s.sessions.length > 0);
  const breakpoints = useBreakpoints((s) => s.list);

  useEffect(() => {
    void loadLaunchConfigurations();
  }, [root]);

  const options = [
    ...configurations.map((c) => ({ id: c.name, label: c.name })),
    ...compounds.map((c) => ({ id: c.name, label: `${c.name} (compound)` })),
  ];

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Run and Debug">
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("debug")} className="size-7" />
      </ToolWindowHeader>
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <button
          type="button"
          {...tooltipProps("Start Debugging", "F5")}
          aria-label="Start Debugging"
          onClick={() => void startDebugging()}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[#5fb865] hover:bg-hover"
        >
          <CirclePlay size={18} strokeWidth={1.75} />
        </button>
        {options.length > 0 ? (
          <Select ariaLabel="Debug configuration" options={options} value={selected ?? ""} onChange={selectConfiguration} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">Current file (no launch.json)</span>
        )}
        <IconButton icon={Settings} title={options.length ? "Open launch.json" : "Create launch.json"} onClick={() => void openLaunchJson()} className="size-7 shrink-0" />
      </div>
      {debugging && <DebugToolbar />}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Section title="Variables">
          <Variables />
        </Section>
        <Watch />
        <Section title="Call Stack">
          <CallStack />
        </Section>
        <Section
          title="Breakpoints"
          actions={
            breakpoints.length > 0 && (
              <>
                <IconButton
                  icon={CircleDot}
                  title={breakpoints.every((b) => b.enabled) ? "Disable All Breakpoints" : "Enable All Breakpoints"}
                  onClick={() => setAllEnabled(!breakpoints.every((b) => b.enabled))}
                  className="size-6"
                  size={14}
                />
                <IconButton icon={Trash2} title="Remove All Breakpoints" onClick={() => removeBreakpoints(breakpoints.map((b) => b.id))} className="size-6" size={14} />
              </>
            )
          }
        >
          <Breakpoints />
        </Section>
      </div>
    </div>
  );
}

