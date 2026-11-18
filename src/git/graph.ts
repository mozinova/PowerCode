//! Lays out the commit graph of a topologically ordered log into lanes, one
//! row per commit, as drawn next to the history list.

import type { GitCommit } from "../lib/ipc";

/** A line through half a row: `top` runs from the row's top edge to its middle, `bottom` from the middle down. */
export interface GraphEdge {
  from: number;
  to: number;
  color: number;
  half: "top" | "bottom";
}

export interface GraphRow {
  /** Lane of the commit's dot. */
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** Lanes the row spans, for its width. */
  width: number;
}

export function layoutGraph(commits: GitCommit[]): GraphRow[] {
  /** The commit each lane is heading to, or null for a free lane. */
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;

  const claimLane = (hash: string) => {
    let lane = lanes.indexOf(null);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = hash;
    colors[lane] = nextColor++;
    return lane;
  };

  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    // A branch tip nothing above leads to: its line starts at the dot.
    const isTip = lane < 0;
    if (isTip) lane = claimLane(commit.hash);
    const color = colors[lane];
    const edges: GraphEdge[] = [];

    // Top half: every lane coming in either ends at this commit or passes by.
    lanes.forEach((hash, i) => {
      if (hash === null || (isTip && i === lane)) return;
      edges.push({ from: i, to: hash === commit.hash ? lane : i, color: colors[i], half: "top" });
    });
    const passing = lanes.map((hash, i) => (hash !== null && hash !== commit.hash ? i : -1)).filter((i) => i >= 0);
    // Other branches that were heading here end at this commit.
    lanes.forEach((hash, i) => {
      if (hash === commit.hash) lanes[i] = null;
    });

    // Bottom half: lines from the dot to each parent's lane, plus the lanes passing by.
    const [first, ...others] = commit.parents;
    if (first) {
      lanes[lane] = first;
      colors[lane] = color;
      edges.push({ from: lane, to: lane, color, half: "bottom" });
    }
    for (const parent of others) {
      const existing = lanes.indexOf(parent);
      const target = existing >= 0 ? existing : claimLane(parent);
      edges.push({ from: lane, to: target, color: colors[target], half: "bottom" });
    }
    for (const i of passing) edges.push({ from: i, to: i, color: colors[i], half: "bottom" });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, ...edges.map((e) => Math.max(e.from, e.to) + 1));
    return { lane, color, edges, width };
  });
}
