//! Debugging in the code editor: breakpoints in the gutter (click to toggle),
//! the line execution stopped at, and values on hover while paused.

import { monaco } from "../editor/monaco";
import { modelPath } from "../editor/models";
import { featureProviders, onFeatureChange, provideFeature } from "../exthost/languages";
import { moveBreakpointLines, toggleBreakpoint, useBreakpoints, type BreakpointEntry } from "./breakpoints";
import { dap, evaluate, useDebug, type StackFrame } from "./model";

interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const toRange = (r: RangeDto) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);

type InlineValue =
  | { kind: "text"; range: RangeDto; text: string }
  | { kind: "variable"; range: RangeDto; variableName?: string; caseSensitive?: boolean }
  | { kind: "expression"; range: RangeDto; expression?: string };

/** Longest value shown for one variable, and for one line, as in VS Code. */
const MAX_VALUE_LENGTH = 100;
const MAX_LINE_LENGTH = 300;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The variables of a frame's scopes (the cheap ones), by name, for inline values. */
async function frameVariables(sessionId: string, frameId: number): Promise<{ name: string; value: string }[]> {
  const { scopes } = await dap<{ scopes: { variablesReference: number; expensive?: boolean }[] }>(sessionId, "scopes", { frameId });
  const lists = await Promise.all(
    (scopes ?? [])
      .filter((s) => !s.expensive && s.variablesReference > 0)
      .map((s) =>
        dap<{ variables: { name: string; value: string }[] }>(sessionId, "variables", { variablesReference: s.variablesReference })
          .then((r) => r.variables ?? [])
          .catch(() => []),
      ),
  );
  return lists.flat();
}

/** The text an extension's inline values give, by line (1-based). */
async function inlineValueTexts(
  model: monaco.editor.ITextModel,
  frame: StackFrame,
  sessionId: string,
  visible: monaco.IRange,
): Promise<Map<number, string[]>> {
  const providers = featureProviders("inlineValues", model.getLanguageId());
  const stopped = { line: frame.line - 1, character: Math.max(0, frame.column - 1) };
  // From the top of the view down to where execution stopped: lines below have not run yet.
  const lastLine = Math.min(visible.endLineNumber, frame.line);
  if (visible.startLineNumber > lastLine) return new Map();
  const range = { start: { line: visible.startLineNumber - 1, character: 0 }, end: { line: lastLine - 1, character: model.getLineMaxColumn(lastLine) - 1 } };
  const results = await Promise.all(
    providers.map((p) =>
      provideFeature<InlineValue[] | null>(p.handle, "inlineValues", model, { range, frameId: frame.id, stoppedLocation: { start: stopped, end: stopped } }).catch(
        () => null,
      ),
    ),
  );
  const values = results.flatMap((r) => r ?? []);
  let variables: Promise<{ name: string; value: string }[]> | null = null;
  const byLine = new Map<number, string[]>();
  for (const value of values) {
    const at = toRange(value.range);
    let text: string | null = null;
    if (value.kind === "text") {
      text = value.text;
    } else if (value.kind === "variable") {
      const name = value.variableName ?? model.getValueInRange(at);
      variables ??= frameVariables(sessionId, frame.id).catch(() => []);
      const list = await variables;
      const found =
        list.find((v) => v.name === name) ??
        (value.caseSensitive === false ? list.find((v) => v.name.toLowerCase() === name.toLowerCase()) : undefined);
      if (found) text = `${name} = ${clip(found.value, MAX_VALUE_LENGTH)}`;
    } else {
      const expression = value.expression ?? model.getValueInRange(at);
      const result = await evaluate(expression, "watch").catch(() => null);
      if (result) text = `${expression} = ${clip(result.result, MAX_VALUE_LENGTH)}`;
    }
    if (text === null) continue;
    const line = at.startLineNumber;
    byLine.set(line, [...(byLine.get(line) ?? []), text]);
  }
  return byLine;
}

const GUTTER_TARGETS = new Set([monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN, monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS]);

function breakpointClass(b: BreakpointEntry, verified: boolean | undefined, debugging: boolean): string {
  if (!b.enabled) return "pc-bp pc-bp-disabled";
  if (debugging && verified === false) return "pc-bp pc-bp-unverified";
  if (b.logMessage) return "pc-bp pc-bp-log";
  if (b.condition || b.hitCondition) return "pc-bp pc-bp-conditional";
  return "pc-bp";
}

function breakpointHover(b: BreakpointEntry, message?: string): string {
  const parts = [b.logMessage ? `Log: ${b.logMessage}` : "Breakpoint"];
  if (b.condition) parts.push(`Condition: ${b.condition}`);
  if (b.hitCondition) parts.push(`Hit count: ${b.hitCondition}`);
  if (!b.enabled) parts.push("(disabled)");
  if (message) parts.push(message);
  return parts.join("\n\n");
}

/** The frame being shown, if it is in `path`. */
function focusedFrameIn(path: string): StackFrame | undefined {
  const { focus, sessions } = useDebug.getState();
  if (!focus || focus.frameId === null) return undefined;
  const frame = sessions
    .find((s) => s.id === focus.sessionId)
    ?.threads.find((t) => t.id === focus.threadId)
    ?.frames?.find((f) => f.id === focus.frameId);
  return frame?.source?.path === path ? frame : undefined;
}

/** Wires breakpoints and the execution line into one editor. */
export function attachDebugger(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  /** Breakpoint decoration ids, one per breakpoint of `decorated` (in order). */
  let breakpointIds: string[] = [];
  const frameDecorations = editor.createDecorationsCollection();
  const hintDecorations = editor.createDecorationsCollection();
  const inlineValueDecorations = editor.createDecorationsCollection();
  /** What the inline values shown were computed for; a newer update replaces them. */
  let inlineKey = "";
  let inlineTicket = 0;
  /** Which breakpoint each breakpoint decoration stands for (to follow edits). */
  let decorated: { id: string; decoration: string }[] = [];

  const path = () => {
    const model = editor.getModel();
    return model ? modelPath(model) : undefined;
  };

  const render = () => {
    const file = path();
    if (!file) {
      breakpointIds = editor.deltaDecorations(breakpointIds, []);
      frameDecorations.clear();
      decorated = [];
      return;
    }
    const { list, status } = useBreakpoints.getState();
    const debugging = useDebug.getState().sessions.length > 0;
    const mine = list.filter((b) => b.path === file);
    breakpointIds = editor.deltaDecorations(
      breakpointIds,
      mine.map((b) => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
          glyphMarginClassName: breakpointClass(b, status[b.id]?.verified, debugging),
          glyphMarginHoverMessage: { value: breakpointHover(b, status[b.id]?.message) },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    decorated = mine.map((b, i) => ({ id: b.id, decoration: breakpointIds[i] }));

    const frame = focusedFrameIn(file);
    frameDecorations.set(
      frame
        ? [
            {
              range: new monaco.Range(frame.line, 1, frame.line, 1),
              options: { isWholeLine: true, className: "pc-frame-line", glyphMarginClassName: "pc-frame-glyph", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
            },
          ]
        : [],
    );
  };

  /** Extensions' inline values for the frame execution stopped at in this file (on stop, frame change, scroll). */
  const updateInlineValues = async (force = false) => {
    const file = path();
    const model = editor.getModel();
    const frame = file ? focusedFrameIn(file) : undefined;
    const { focus, generation } = useDebug.getState();
    const visible = editor.getVisibleRanges()[0];
    if (!model || !frame || !focus || !visible || featureProviders("inlineValues", model.getLanguageId()).length === 0) {
      inlineKey = "";
      inlineTicket++;
      inlineValueDecorations.clear();
      return;
    }
    const key = `${focus.sessionId}:${frame.id}:${generation}:${model.uri}:${visible.startLineNumber}-${visible.endLineNumber}`;
    if (key === inlineKey && !force) return;
    inlineKey = key;
    const ticket = ++inlineTicket;
    const byLine = await inlineValueTexts(model, frame, focus.sessionId, visible).catch(() => new Map<number, string[]>());
    if (ticket !== inlineTicket || model.isDisposed()) return;
    inlineValueDecorations.set(
      [...byLine].map(([line, texts]) => {
        const column = model.getLineMaxColumn(line);
        return {
          range: new monaco.Range(line, column, line, column),
          options: {
            after: { content: clip(texts.join(", "), MAX_LINE_LENGTH), inlineClassName: "pc-inline-value" },
            showIfCollapsed: true,
          },
        };
      }),
    );
  };
  let scrollTimer: number | undefined;

  // Breakpoints follow their lines as text is inserted or deleted above them.
  let moveTimer: number | undefined;
  const trackMoves = () => {
    window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      const file = path();
      const model = editor.getModel();
      if (!file || !model) return;
      const lines = new Map<string, number>();
      for (const { id, decoration } of decorated) {
        const range = decoration ? model.getDecorationRange(decoration) : null;
        if (range) lines.set(id, range.startLineNumber);
      }
      moveBreakpointLines(file, lines);
    }, 300);
  };

  const listeners = [
    editor.onDidChangeModel(render),
    editor.onDidChangeModelContent(trackMoves),
    editor.onMouseDown((e) => {
      const file = path();
      if (!file || !e.target.position || !GUTTER_TARGETS.has(e.target.type) || !e.event.leftButton) return;
      toggleBreakpoint(file, e.target.position.lineNumber);
      e.event.preventDefault();
    }),
    // A faded dot where clicking would add a breakpoint, as in VS Code.
    editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      const file = path();
      if (!file || !line || e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || useBreakpoints.getState().list.some((b) => b.path === file && b.line === line)) {
        hintDecorations.clear();
        return;
      }
      hintDecorations.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "pc-bp pc-bp-hint" } }]);
    }),
    editor.onMouseLeave(() => hintDecorations.clear()),
    editor.onDidChangeModel(() => void updateInlineValues()),
    editor.onDidScrollChange((e) => {
      if (!e.scrollTopChanged || !inlineKey) return;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => void updateInlineValues(), 200);
    }),
  ];
  const unsubscribe = [
    useBreakpoints.subscribe(render),
    useDebug.subscribe(render),
    useDebug.subscribe(() => void updateInlineValues()),
    onFeatureChange((kind) => kind === "inlineValues" && void updateInlineValues(true)),
  ];
  render();
  void updateInlineValues();

  return {
    dispose() {
      window.clearTimeout(moveTimer);
      window.clearTimeout(scrollTimer);
      listeners.forEach((l) => l.dispose());
      unsubscribe.forEach((u) => u());
      breakpointIds = editor.deltaDecorations(breakpointIds, []);
      frameDecorations.clear();
      hintDecorations.clear();
      inlineTicket++;
      inlineValueDecorations.clear();
    },
  };
}

/**
 * What hovering `position` evaluates. A language's evaluatable expression provider
 * decides (e.g. `this.items[i]`, not just `i`); without one, the word with the
 * members before it (`a.b.c`) is evaluated. With providers that find nothing there,
 * nothing is shown, as in VS Code.
 */
async function hoveredExpression(model: monaco.editor.ITextModel, position: monaco.Position): Promise<{ expression: string; range: monaco.Range } | null> {
  const providers = featureProviders("evaluatableExpression", model.getLanguageId());
  if (providers.length > 0) {
    for (const p of providers) {
      const result = await provideFeature<{ range: RangeDto; expression?: string } | null>(p.handle, "evaluatableExpression", model, {
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      }).catch(() => null);
      if (!result) continue;
      const range = toRange(result.range);
      const expression = result.expression ?? model.getValueInRange(range);
      if (expression.trim()) return { expression, range };
    }
    return null;
  }
  const line = model.getLineContent(position.lineNumber);
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  let start = word.startColumn - 1;
  while (start > 0 && /[\w$.]/.test(line[start - 1])) start--;
  const expression = line.slice(start, word.endColumn - 1).replace(/^\.+/, "");
  if (!expression) return null;
  return { expression, range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn) };
}

let hoverRegistered = false;

/** While paused, hovering an identifier (or a selection) shows its value. */
export function registerDebugHover() {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("*", {
    async provideHover(model, position) {
      const { focus } = useDebug.getState();
      if (!focus || focus.frameId === null || !modelPath(model)) return null;
      const target = await hoveredExpression(model, position);
      if (!target) return null;
      const { expression, range } = target;
      try {
        const result = await evaluate(expression, "hover");
        const fence = "```";
        return {
          range,
          contents: [{ value: `**${expression}**` }, { value: `${fence}\n${result.result}\n${fence}` }],
        };
      } catch {
        return null;
      }
    },
  });
}
