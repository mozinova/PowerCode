//! A tool call of the AI tool window shown whole in an editor tab: what the assistant
//! gave the tool and what came back. A read-only Markdown document under the `pcai`
//! scheme, kept until its tab closes (the model is reused when it opens again).

import { monaco } from "../editor/monaco";
import { documentTabPath } from "../lib/virtualTabs";
import { useWorkspace } from "../state/workspace";
import type { AiPart } from "./store";

type ToolPart = Extract<AiPart, { kind: "tool" }>;

/** A code fence longer than any run of backticks in `text`, so the text cannot close it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function block(text: string, language = ""): string {
  const f = fence(text);
  return `${f}${language}\n${text}\n${f}`;
}

export function toolDocumentText(tool: ToolPart): string {
  const parts = [`# ${tool.title}${tool.detail ? `: ${tool.detail}` : ""}`];
  if (tool.input) parts.push("## Input", block(tool.input, /^\s*[{[]/.test(tool.input) ? "json" : ""));
  if (tool.output !== undefined && tool.output !== null) {
    parts.push(tool.error ? "## Output (failed)" : "## Output", tool.output ? block(tool.output) : "_(empty)_");
  } else {
    parts.push("## Output", "_(none yet)_");
  }
  return `${parts.join("\n\n")}\n`;
}

/** Opens (or refreshes) the tool call's document; `key` names the call within the conversation. */
export function openToolDocument(tool: ToolPart, key: string) {
  const name = (tool.detail?.split(/[\\/]/).pop() || tool.title).replace(/[\\/?#%]/g, "_").slice(0, 60);
  const uri = monaco.Uri.from({ scheme: "pcai", path: `/${tool.title} ${name}.md`, query: key });
  const text = toolDocumentText(tool);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    // The output may have arrived since it was first opened.
    if (existing.getValue() !== text) existing.setValue(text);
  } else {
    monaco.editor.createModel(text, "markdown", uri);
  }
  useWorkspace.getState().openFile(documentTabPath(uri.toString()), `${tool.title}: ${name}`);
}
