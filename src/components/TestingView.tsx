//! The Testing tool window: the tests extensions find (Jest, Vitest, Python, Go,
//! ...), run or debugged per test, file or all, with each test's latest result.

import {
  Bug,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  FileCode,
  Loader2,
  Minus,
  Play,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { pathFromUri } from "../exthost/languages";
import {
  aggregateState,
  cancelTests,
  clearTestResults,
  countResults,
  DEBUG,
  discoverTests,
  refreshTests,
  resolveTests,
  RUN,
  runAllTests,
  runTests,
  useTesting,
  type TestController,
  type TestMessage,
  type TestNode,
  type TestState,
} from "../exthost/testing";
import { useWorkspace } from "../state/workspace";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";

function StateIcon({ state }: { state: TestState | undefined }): ReactNode {
  switch (state) {
    case "passed":
      return <CircleCheck size={14} className="shrink-0 text-[#5fb865]" />;
    case "failed":
      return <CircleX size={14} className="shrink-0 text-danger" />;
    case "errored":
      return <TriangleAlert size={14} className="shrink-0 text-danger" />;
    case "running":
      return <Loader2 size={14} className="shrink-0 animate-spin text-accent-hover" />;
    case "queued":
      return <Clock size={14} className="shrink-0 text-fg-muted" />;
    case "skipped":
      return <CircleSlash size={14} className="shrink-0 text-fg-subtle" />;
    default:
      return <Circle size={14} className="shrink-0 text-fg-subtle" />;
  }
}

function openLocation(uri?: string, range?: TestMessage["range"]) {
  if (!uri || !/^(file|ssh):/.test(uri)) return;
  const path = pathFromUri(uri);
  const { openFile, openFileAt } = useWorkspace.getState();
  if (range) openFileAt(path, range.start.line + 1, range.start.character + 1, range.start.character + 1);
  else openFile(path);
}

function RowButton({ icon: Icon, title, onClick }: { icon: typeof Play; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
    >
      <Icon size={14} />
    </button>
  );
}

function Messages({ messages }: { messages: TestMessage[] }) {
  return (
    <>
      {messages.map((m, i) => (
        <button
          key={i}
          type="button"
          {...tooltipProps(
            [m.message, m.expected !== undefined ? `Expected: ${m.expected}` : "", m.actual !== undefined ? `Actual: ${m.actual}` : ""]
              .filter(Boolean)
              .join("\n"),
          )}
          onClick={() => openLocation(m.uri, m.range)}
          className="block w-full truncate text-left text-xs text-danger hover:underline"
        >
          {m.message.split("\n")[0] || "Failed"}
        </button>
      ))}
    </>
  );
}

function TestRow({
  controller,
  node,
  depth,
  expanded,
  onToggle,
}: {
  controller: TestController;
  node: TestNode;
  depth: number;
  expanded: Set<number>;
  onToggle: (handle: number) => void;
}) {
  const results = useTesting((s) => s.results);
  const result = results[node.handle];
  const state = aggregateState(node, results);
  const isOpen = expanded.has(node.handle);
  const hasChildren = node.children.length > 0 || node.canResolveChildren;
  const canDebug = controller.profiles.some((p) => p.kind === DEBUG);
  const sorted = [...node.children].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
        {...tooltipProps(node.error ?? node.description)}
        onClick={() => {
          if (hasChildren) onToggle(node.handle);
          else openLocation(node.uri, node.range);
        }}
        onDoubleClick={() => openLocation(node.uri, node.range)}
        style={{ paddingLeft: 6 + depth * 14 }}
        className="group flex h-[26px] cursor-default items-center gap-1.5 pr-1.5 hover:bg-hover"
      >
        <span className="flex w-4 shrink-0 justify-center text-fg-muted">
          {hasChildren && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </span>
        {node.busy ? <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" /> : <StateIcon state={state} />}
        <span className={`min-w-0 truncate ${node.error ? "text-danger" : ""}`}>{node.label}</span>
        {node.description && <span className="min-w-0 shrink truncate text-xs text-fg-subtle">{node.description}</span>}
        <span className="flex-1" />
        {result?.duration !== undefined && <span className="shrink-0 text-xs text-fg-subtle group-hover:hidden">{Math.round(result.duration)} ms</span>}
        <span className="hidden shrink-0 items-center group-hover:flex">
          <RowButton icon={Play} title="Run Test" onClick={() => void runTests(controller.handle, RUN, [node.handle])} />
          {canDebug && <RowButton icon={Bug} title="Debug Test" onClick={() => void runTests(controller.handle, DEBUG, [node.handle])} />}
          {node.uri && <RowButton icon={FileCode} title="Go to Test" onClick={() => openLocation(node.uri, node.range)} />}
        </span>
      </div>
      {result?.messages && (result.state === "failed" || result.state === "errored") && (
        <div style={{ paddingLeft: 6 + depth * 14 + 42 }} className="pr-2 pb-1">
          <Messages messages={result.messages} />
        </div>
      )}
      {isOpen &&
        sorted.map((child) => (
          <TestRow key={child.handle} controller={controller} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} />
        ))}
    </>
  );
}

export function TestingView() {
  const controllers = useTesting((s) => s.controllers);
  const results = useTesting((s) => s.results);
  const running = useTesting((s) => s.running > 0);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Tests are discovered when the view is first shown, as in VS Code.
  useEffect(() => {
    for (const c of controllers) if (c.canResolve) discoverTests(c.handle);
  }, [controllers]);

  const toggle = (handle: number) => {
    const opening = !expanded.has(handle);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(handle);
      else next.delete(handle);
      return next;
    });
    if (!opening) return;
    // Children that are found on demand (e.g. the tests in a file).
    for (const c of controllers) {
      const find = (nodes: TestNode[]): TestNode | undefined =>
        nodes.find((n) => n.handle === handle) ?? nodes.map((n) => find(n.children)).find(Boolean);
      const node = find(c.items);
      if (node?.canResolveChildren) void resolveTests(c.handle, handle);
    }
  };

  const { passed, failed, total } = countResults(controllers, results);

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Testing">
        {running ? (
          <IconButton icon={Square} title="Cancel Test Run" onClick={() => void cancelTests()} className="size-7" size={13} />
        ) : (
          <IconButton icon={Play} title="Run All Tests" onClick={() => void runAllTests(RUN)} className="size-7" size={14} />
        )}
        <IconButton icon={Bug} title="Debug All Tests" onClick={() => void runAllTests(DEBUG)} className="size-7" size={14} />
        <IconButton
          icon={RefreshCw}
          title="Refresh Tests"
          onClick={() => controllers.forEach((c) => void refreshTests(c.handle))}
          className="size-7"
          size={14}
        />
        <IconButton icon={Trash2} title="Clear All Results" onClick={clearTestResults} className="size-7" size={14} />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("testing")} className="size-7" />
      </ToolWindowHeader>
      {total > 0 && (
        <div className="flex items-center gap-3 px-3 pb-1.5 text-xs text-fg-muted">
          <span>
            {passed}/{total} passed
          </span>
          {failed > 0 && <span className="text-danger">{failed} failed</span>}
          {running && <Loader2 size={12} className="animate-spin" />}
        </div>
      )}
      <div role="tree" className="min-h-0 flex-1 overflow-auto pb-2">
        {controllers.length === 0 && (
          <p className="px-3 text-fg-muted">No tests found. Extensions for your test framework (Jest, Vitest, Python, Go, ...) list their tests here.</p>
        )}
        {controllers.map((c) =>
          controllers.length === 1 ? (
            c.items.map((node) => <TestRow key={node.handle} controller={c} node={node} depth={0} expanded={expanded} onToggle={toggle} />)
          ) : (
            <div key={c.handle}>
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{c.label}</div>
              {c.items.map((node) => (
                <TestRow key={node.handle} controller={c} node={node} depth={0} expanded={expanded} onToggle={toggle} />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
