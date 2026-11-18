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

export function isVirtualTab(path: string): boolean {
  return parseExtensionTab(path) !== null || parseDiffTab(path) !== null || parseCommitDiffTab(path) !== null;
}
