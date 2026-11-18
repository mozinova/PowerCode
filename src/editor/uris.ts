//! Workspace paths and the URIs of their editor models. Local and WSL files
//! are `file:` URIs; files on SSH hosts are `ssh://host/path` (the same string as
//! their workspace path), so a URI always leads back to its path.

import { IS_WINDOWS } from "../lib/platform";
import { monaco } from "./monaco";

export function fileUri(path: string): monaco.Uri {
  return path.startsWith("ssh://") ? monaco.Uri.parse(path) : monaco.Uri.file(path);
}

/** The workspace path of a model URI (`file:` or `ssh:`); Windows drive letters upper-cased like the app's paths. */
export function uriToPath(uri: string | monaco.Uri): string {
  const parsed = typeof uri === "string" ? monaco.Uri.parse(uri) : uri;
  if (parsed.scheme === "ssh") return `ssh://${parsed.authority}${parsed.path}`;
  const fsPath = parsed.fsPath;
  return IS_WINDOWS ? fsPath.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`) : fsPath;
}
