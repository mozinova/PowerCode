//! Debugging in the code editor: breakpoints in the gutter (click to toggle),
//! the line execution stopped at, and values on hover while paused.

import { monaco } from "../editor/monaco";
import { modelPath } from "../editor/models";
import { moveBreakpointLines, toggleBreakpoint, useBreakpoints, type BreakpointEntry } from "./breakpoints";
import { evaluate, useDebug, type StackFrame } from "./model";

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
  ];
  const unsubscribe = [useBreakpoints.subscribe(render), useDebug.subscribe(render)];
  render();

  return {
    dispose() {
      window.clearTimeout(moveTimer);
      listeners.forEach((l) => l.dispose());
      unsubscribe.forEach((u) => u());
      breakpointIds = editor.deltaDecorations(breakpointIds, []);
      frameDecorations.clear();
      hintDecorations.clear();
    },
  };
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
      // `a.b.c` up to the hovered word, so members can be inspected too.
      const line = model.getLineContent(position.lineNumber);
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      let start = word.startColumn - 1;
      while (start > 0 && /[\w$.]/.test(line[start - 1])) start--;
      const expression = line.slice(start, word.endColumn - 1).replace(/^\.+/, "");
      if (!expression) return null;
      try {
        const result = await evaluate(expression, "hover");
        const fence = "```";
        return {
          range: new monaco.Range(position.lineNumber, start + 1, position.lineNumber, word.endColumn),
          contents: [{ value: `**${expression}**` }, { value: `${fence}\n${result.result}\n${fence}` }],
        };
      } catch {
        return null;
      }
    },
  });
}
