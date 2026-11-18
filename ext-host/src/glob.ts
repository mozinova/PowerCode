//! Glob patterns as used by `workspace.findFiles` and file system watchers:
//! `**`, `*`, `?`, `{a,b}` and `[...]`, matched against `/`-separated paths.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let cached = cache.get(glob);
  if (cached) return cached;
  let source = "";
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of directories, including none.
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") source += "[^/]";
    else if (c === "{") {
      inGroup++;
      source += "(?:";
    } else if (c === "}" && inGroup > 0) {
      inGroup--;
      source += ")";
    } else if (c === "," && inGroup > 0) source += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) source += "\\[";
      else {
        source += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else source += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  cached = new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
  cache.set(glob, cached);
  return cached;
}

export function matchesGlob(relativePath: string, glob: string): boolean {
  return globToRegExp(glob.replace(/\\/g, "/")).test(relativePath.replace(/\\/g, "/"));
}
