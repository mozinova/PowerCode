//! Fuzzy matching of file names and paths, shared by the file search (Ctrl+Shift+N)
//! and the AI tool window's @ mentions.

import { basename } from "../lib/paths";

export interface FileMatch {
  relative: string;
  name: string;
  dir: string;
  score: number;
  /** Matched character positions within `name`, or within `relative` for path queries. */
  indices: number[];
}

/** Case-insensitive fuzzy match favouring substrings, prefixes and word starts. */
export function fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const substring = t.indexOf(q);
  if (substring >= 0) {
    return {
      score: 100 + (substring === 0 ? 50 : 0) - t.length * 0.1,
      indices: Array.from({ length: q.length }, (_, i) => substring + i),
    };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\\/._\-\s]/.test(t[i - 1]) || target[i] !== t[i];
    const consecutive = indices.length > 0 && i === indices[indices.length - 1] + 1;
    score += (consecutive ? 5 : 1) + (wordStart ? 3 : 0);
    indices.push(i);
    from = i + 1;
  }
  return { score: score - t.length * 0.1, indices };
}

export function searchFiles(files: string[], query: string, limit = 50): FileMatch[] {
  const byPath = /[\\/]/.test(query);
  const matches: FileMatch[] = [];
  for (const relative of files) {
    const name = basename(relative);
    const match = fuzzyMatch(query, byPath ? relative : name);
    if (!match) continue;
    matches.push({
      relative,
      name,
      dir: relative.slice(0, relative.length - name.length).replace(/[\\/]$/, ""),
      ...match,
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.relative.length - b.relative.length)
    .slice(0, limit);
}
