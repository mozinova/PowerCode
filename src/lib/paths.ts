//! Helpers for native paths, which use `\` on Windows and `/` elsewhere.

export function separatorOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : path;
}

/** Joins `name` (which may itself contain `/` or `\`) onto `dir`. */
export function joinPath(dir: string, name: string): string {
  const separator = separatorOf(dir);
  const normalized = name.replace(/[\\/]+/g, separator);
  return dir.endsWith(separator) ? dir + normalized : dir + separator + normalized;
}

/** True if `path` is `dir` itself or lies inside it. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + separatorOf(dir));
}

/** Rewrites `path` after `from` was renamed to `to`. */
export function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}
