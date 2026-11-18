import { ChevronRight, Minus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appendConsole, clearConsole, evaluate, useDebug, type ConsoleEntry } from "../debug/model";
import { useWorkspace } from "../state/workspace";
import { IconButton } from "./ui";
import { VariableRow } from "./VariableTree";

const COLORS: Record<ConsoleEntry["kind"], string> = {
  output: "text-fg",
  input: "text-fg-muted",
  result: "text-fg",
  error: "text-danger",
  info: "text-fg-subtle italic",
};

function Entry({ entry }: { entry: ConsoleEntry }) {
  if (entry.variablesReference && entry.sessionId) {
    return (
      <VariableRow
        sessionId={entry.sessionId}
        variable={{ name: "", value: entry.text.trimEnd(), variablesReference: entry.variablesReference }}
        depth={0}
        label=""
      />
    );
  }
  const color = entry.category === "stderr" ? "text-danger" : entry.category === "important" ? "text-[#e0b84c]" : COLORS[entry.kind];
  return (
    <div className={`px-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap ${color}`}>
      {entry.kind === "input" && <ChevronRight size={12} className="mr-1 inline align-[-2px]" />}
      {entry.text}
    </div>
  );
}

/** The Debug Console: the debuggee's output and an expression prompt (REPL). */
export function DebugConsole() {
  const entries = useDebug((s) => s.console);
  const debugging = useDebug((s) => s.sessions.length > 0);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [input, setInput] = useState("");

  useEffect(() => {
    const el = listRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const submit = async () => {
    const expression = input.trim();
    if (!expression) return;
    setInput("");
    setHistory((h) => [expression, ...h.filter((e) => e !== expression)].slice(0, 100));
    setHistoryIndex(-1);
    appendConsole({ kind: "input", text: `${expression}\n` });
    followRef.current = true;
    try {
      const result = await evaluate(expression, "repl");
      appendConsole({ kind: "result", text: `${result.result}\n`, variablesReference: result.variablesReference || undefined, sessionId: result.sessionId });
    } catch (e) {
      appendConsole({ kind: "error", text: `${e instanceof Error ? e.message : String(e)}\n` });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-3">
        <span className="font-semibold">Debug Console</span>
        <div className="flex-1" />
        <IconButton icon={Trash2} title="Clear Console" onClick={clearConsole} className="size-7" />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleBottomTool("debug")} className="size-7" />
      </div>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto pb-1 select-text"
      >
        {entries.length === 0 && <div className="px-3 text-xs text-fg-muted">Output of debug sessions appears here.</div>}
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-line-soft px-2">
        <ChevronRight size={14} className="shrink-0 text-accent-hover" />
        <input
          value={input}
          disabled={!debugging}
          placeholder={debugging ? "Evaluate an expression" : "Start debugging to evaluate expressions"}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            else if (e.key === "ArrowUp" && history.length) {
              const next = Math.min(historyIndex + 1, history.length - 1);
              setHistoryIndex(next);
              setInput(history[next]);
            } else if (e.key === "ArrowDown") {
              const next = historyIndex - 1;
              setHistoryIndex(next);
              setInput(next >= 0 ? history[next] : "");
            } else return;
            e.preventDefault();
          }}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
    </div>
  );
}
