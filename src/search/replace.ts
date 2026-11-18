//! Replace for Find in Files. Searches run in Rust; replacing runs here with
//! an equivalent JavaScript regular expression, so open files can be edited
//! in their editor model (keeping undo and unsaved edits) and the rest on disk.

import { getModel, isModelDirty, saveModel } from "../editor/models";
import { monaco } from "../editor/monaco";
import { fsApi, type SearchOptions } from "../lib/ipc";

type Options = Pick<SearchOptions, "query" | "caseSensitive" | "wholeWord" | "regex">;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchRegExp(options: Options, flags = "g"): RegExp {
  let source = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, flags + (options.caseSensitive ? "" : "i"));
}

/** The replacement as `String.replace` expects it: `$1` groups only in regex mode. */
function replacementPattern(options: Options, replacement: string) {
  return options.regex ? replacement : replacement.replace(/\$/g, "$$$$");
}

/** What `match` (one occurrence) becomes, for previews. */
export function replacedText(options: Options, match: string, replacement: string): string {
  return match.replace(searchRegExp(options, ""), replacementPattern(options, replacement));
}

async function readText(path: string): Promise<string> {
  return getModel(path)?.getValue() ?? fsApi.readTextFile(path);
}

/** Writes `text` through the open model when there is one, saving it unless it had unsaved edits. */
async function writeText(path: string, text: string) {
  const model = getModel(path);
  if (!model) {
    await fsApi.writeTextFile(path, text);
    return;
  }
  const hadUnsavedEdits = isModelDirty(path);
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  if (!hadUnsavedEdits) await saveModel(path);
}

/** Replaces every match in `path`; returns how many were replaced. */
export async function replaceInFile(path: string, options: Options, replacement: string): Promise<number> {
  const text = await readText(path);
  const re = searchRegExp(options);
  let count = 0;
  const result = text.replace(re, (...args) => {
    count++;
    // Expand `$1`-style references for this one match.
    return (args[0] as string).replace(searchRegExp(options, ""), replacementPattern(options, replacement));
  });
  if (count > 0) await writeText(path, result);
  return count;
}

/**
 * Replaces the single match at `line`/`column` (1-based, UTF-16). Fails if the
 * text there no longer matches, e.g. after an edit since the search.
 */
export async function replaceMatch(
  path: string,
  line: number,
  column: number,
  options: Options,
  replacement: string,
) {
  const model = getModel(path);
  // Lines with their separators, so CRLF files stay CRLF.
  const parts = (model?.getValue() ?? (await fsApi.readTextFile(path))).split(/(\r?\n)/);
  const index = (line - 1) * 2;
  const content = parts[index];
  if (content === undefined) throw new Error("The match is no longer there; search again.");

  const sticky = searchRegExp(options, "y");
  sticky.lastIndex = column - 1;
  const match = sticky.exec(content);
  if (!match) throw new Error("The match is no longer there; search again.");

  const start = column - 1;
  const end = start + match[0].length;
  const replaced = replacedText(options, match[0], replacement);

  if (model) {
    const hadUnsavedEdits = isModelDirty(path);
    model.pushEditOperations([], [{ range: new monaco.Range(line, start + 1, line, end + 1), text: replaced }], () => null);
    if (!hadUnsavedEdits) await saveModel(path);
    return;
  }
  parts[index] = content.slice(0, start) + replaced + content.slice(end);
  await fsApi.writeTextFile(path, parts.join(""));
}
