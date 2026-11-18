//! Editor tabs that show a page rather than a file. Their "path" uses a scheme
//! no real file path can start with.

import { basename } from "./paths";

const EXTENSION_PREFIX = "extension:";
const DIFF_PREFIX = "diff:";

export function extensionTabPath(namespace: string, name: string): string {
  return `${EXTENSION_PREFIX}${namespace}.${name}`;
}

/** The extension shown by an extension page tab, or null for any other tab. */
export function parseExtensionTab(path: string): { namespace: string; name: string } | null {
  if (!path.startsWith(EXTENSION_PREFIX)) return null;
  const id = path.slice(EXTENSION_PREFIX.length);
  const dot = id.indexOf(".");
  return dot > 0 ? { namespace: id.slice(0, dot), name: id.slice(dot + 1) } : null;
}

/** A tab comparing `file` with its committed version. */
export function diffTabPath(file: string): string {
  return DIFF_PREFIX + file;
}

export function diffTabTitle(file: string): string {
  return `${basename(file)} (Diff)`;
}

/** The file compared by a diff tab, or null for any other tab. */
export function parseDiffTab(path: string): string | null {
  return path.startsWith(DIFF_PREFIX) ? path.slice(DIFF_PREFIX.length) : null;
}

const COMMIT_PREFIX = "commit:";

/** A tab showing the change a commit made to `file`. */
export function commitDiffTabPath(hash: string, file: string): string {
  return `${COMMIT_PREFIX}${hash}:${file}`;
}

export function commitDiffTabTitle(hash: string, file: string): string {
  return `${basename(file)} (${hash.slice(0, 7)})`;
}

/** The commit and file of a commit diff tab, or null for any other tab. */
export function parseCommitDiffTab(path: string): { hash: string; file: string } | null {
  if (!path.startsWith(COMMIT_PREFIX)) return null;
  const rest = path.slice(COMMIT_PREFIX.length);
  // Hashes contain no colon; the file path (e.g. `C:\...`) may.
  const colon = rest.indexOf(":");
  return colon > 0 ? { hash: rest.slice(0, colon), file: rest.slice(colon + 1) } : null;
}

const WEBVIEW_PREFIX = "webview:";

/** A tab showing an extension's webview panel. */
export function webviewTabPath(id: string): string {
  return WEBVIEW_PREFIX + id;
}

/** The webview shown by a webview tab, or null for any other tab. */
export function parseWebviewTab(path: string): string | null {
  return path.startsWith(WEBVIEW_PREFIX) ? path.slice(WEBVIEW_PREFIX.length) : null;
}

/** The Settings page's tab. */
export const SETTINGS_TAB = "settings:";

const CUSTOM_PREFIX = "custom:";

/** A tab showing `path` in an extension's custom editor (`viewType` has no colon). */
export function customEditorTabPath(viewType: string, path: string): string {
  return `${CUSTOM_PREFIX}${viewType}:${path}`;
}

/** The editor and file of a custom editor tab, or null for any other tab. */
export function parseCustomEditorTab(path: string): { viewType: string; path: string } | null {
  if (!path.startsWith(CUSTOM_PREFIX)) return null;
  const rest = path.slice(CUSTOM_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon > 0 ? { viewType: rest.slice(0, colon), path: rest.slice(colon + 1) } : null;
}

const DOCUMENT_PREFIX = "document:";

/** A tab showing a document an extension provides (content and file system providers), by URI. */
export function documentTabPath(uri: string): string {
  return DOCUMENT_PREFIX + uri;
}

/** The URI shown by a document tab, or null for any other tab. */
export function parseDocumentTab(path: string): string | null {
  return path.startsWith(DOCUMENT_PREFIX) ? path.slice(DOCUMENT_PREFIX.length) : null;
}

const COMPARE_PREFIX = "compare:";

/** A tab comparing two documents by URI (`vscode.diff`): files or documents extensions provide. */
export function compareTabPath(original: string, modified: string): string {
  return COMPARE_PREFIX + JSON.stringify([original, modified]);
}

/** The documents compared by a compare tab, or null for any other tab. */
export function parseCompareTab(path: string): { original: string; modified: string } | null {
  if (!path.startsWith(COMPARE_PREFIX)) return null;
  try {
    const [original, modified] = JSON.parse(path.slice(COMPARE_PREFIX.length));
    return typeof original === "string" && typeof modified === "string" ? { original, modified } : null;
  } catch {
    return null;
  }
}

/** The file name a document or compare tab shows (the modified side's), for its icon. */
export function uriTabFileName(path: string): string | null {
  const uri = parseDocumentTab(path) ?? parseCompareTab(path)?.modified;
  if (!uri) return null;
  const name = uri.replace(/[?#].*$/, "").split("/").pop() ?? "";
  try {
    return decodeURIComponent(name) || null;
  } catch {
    return name || null;
  }
}

/** The file a tab is about, for tabs that show a file some other way (diffs, custom editors). */
export function tabFilePath(path: string): string | null {
  return parseDiffTab(path) ?? parseCommitDiffTab(path)?.file ?? parseCustomEditorTab(path)?.path ?? (isVirtualTab(path) ? null : path);
}

export function isVirtualTab(path: string): boolean {
  return (
    parseExtensionTab(path) !== null ||
    parseDiffTab(path) !== null ||
    parseCommitDiffTab(path) !== null ||
    parseWebviewTab(path) !== null ||
    parseCustomEditorTab(path) !== null ||
    parseDocumentTab(path) !== null ||
    parseCompareTab(path) !== null ||
    path === SETTINGS_TAB
  );
}
