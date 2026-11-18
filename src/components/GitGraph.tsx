import { ChevronDown, ChevronRight, Copy, GitBranchPlus, Loader2, TriangleRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkoutRevision, createBranch, openCommitDiff, validateBranchName } from "../git/actions";
import { layoutGraph, type GraphRow } from "../git/graph";
import { useGit } from "../git/store";
import { formatCommitDate } from "../lib/format";
import { errorMessage, gitApi, type CommitDetails, type GitBranch, type GitCommit } from "../lib/ipc";
import { basename, isWithin, parentDir } from "../lib/paths";
import { useWorkspace } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { ContextMenu, type MenuEntry } from "./Menu";
import { PromptDialog } from "./PromptDialog";
import { Select } from "./Select";
import { tooltipProps } from "./Tooltip";

const PAGE_SIZE = 300;
const ROW_HEIGHT = 24;
const LANE_WIDTH = 12;
/** Wider graphs are cut off; their lanes stay consistent, only hidden. */
const MAX_LANES = 8;
const LANE_COLORS = ["#56a8f5", "#73bd79", "#cf8e6d", "#c77dbb", "#2aacb8", "#d5b778", "#f75464", "#a8a8f0"];
const ALL_BRANCHES = "--all";

const laneColor = (index: number) => LANE_COLORS[index % LANE_COLORS.length];
const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;

function GraphCell({ row, lanes, isHead, height }: { row: GraphRow; lanes: number; isHead: boolean; height: number }) {
  const mid = ROW_HEIGHT / 2;
  // Rows grow when a commit is expanded; lanes passing by continue down the extra height.
  return (
    <svg width={lanes * LANE_WIDTH} height={height} className="shrink-0 self-start overflow-hidden" aria-hidden>
      {row.edges.map((edge, i) => {
        const [y1, y2] = edge.half === "top" ? [0, mid] : [mid, height];
        const [x1, x2] = [laneX(edge.from), laneX(edge.to)];
        const bend = edge.half === "top" ? mid : mid + ROW_HEIGHT / 2;
        const d =
          x1 === x2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${(y1 + bend) / 2}, ${x2} ${(y1 + bend) / 2}, ${x2} ${bend} L ${x2} ${y2}`;
        return <path key={i} d={d} stroke={laneColor(edge.color)} strokeWidth={1.6} fill="none" />;
      })}
      <circle
        cx={laneX(row.lane)}
        cy={mid}
        r={isHead ? 4 : 3.5}
        fill={isHead ? "var(--color-panel)" : laneColor(row.color)}
        stroke={laneColor(row.color)}
        strokeWidth={isHead ? 2 : 1}
      />
    </svg>
  );
}

type BadgeKind = "head" | "local" | "remote" | "tag";

const BADGE_STYLES: Record<BadgeKind, string> = {
  head: "bg-[#3f5f3f] text-[#b8e0b8]",
  local: "bg-[#2f4a2f] text-[#9fd29f]",
  remote: "bg-[#4a3a5a] text-[#d2b8f0]",
  tag: "bg-[#5a4a24] text-[#f0d896]",
};

/** Branch and tag labels next to a commit subject. */
function RefBadges({ refs }: { refs: string[] }) {
  const badges = refs.flatMap((ref): { label: string; kind: BadgeKind }[] => {
    if (ref.startsWith("HEAD -> ")) return [{ label: ref.slice(8), kind: "head" }];
    if (ref === "HEAD") return [{ label: "HEAD", kind: "head" }];
    if (ref.startsWith("tag: ")) return [{ label: ref.slice(5), kind: "tag" }];
    if (ref.endsWith("/HEAD")) return [];
    return [{ label: ref, kind: ref.includes("/") ? "remote" : "local" }];
  });
  return badges.map((b) => (
    <span key={b.label} className={`max-w-28 shrink-0 truncate rounded px-1 text-[11px] leading-4 ${BADGE_STYLES[b.kind]}`}>
      {b.label}
    </span>
  ));
}

const STATUS_COLORS: Record<string, string> = {
  A: "#73bd79",
  M: "#70aeff",
  R: "#70aeff",
  C: "#70aeff",
  T: "#70aeff",
  D: "#6f737a",
};

/** Files changed by an expanded commit; each opens the commit's diff of that file. */
function CommitFiles({ commit, details }: { commit: GitCommit; details: CommitDetails | "loading" | string }) {
  const root = useWorkspace((s) => s.root);
  if (details === "loading") {
    return <Loader2 size={13} className="my-1 ml-1 animate-spin text-fg-muted" />;
  }
  if (typeof details === "string") return <p className="py-1 text-xs text-danger">{details}</p>;
  return details.files.map((file) => {
    const dir = parentDir(file.path);
    return (
      <div
        key={file.path}
        role="treeitem"
        onClick={(e) => {
          e.stopPropagation();
          openCommitDiff(commit.hash, file.path);
        }}
        {...tooltipProps(file.origPath ? `${file.origPath} → ${file.path}` : file.path)}
        style={{ height: ROW_HEIGHT }}
        className="flex cursor-default items-center gap-1.5 rounded pr-1 pl-1 hover:bg-hover/60"
      >
        <FileIcon name={basename(file.path)} size={15} />
        <span className="shrink-0" style={{ color: STATUS_COLORS[file.status] }}>
          {basename(file.path)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
          {root && isWithin(dir, root) && dir !== root ? dir.slice(root.length + 1) : ""}
        </span>
        <span className="w-3 shrink-0 text-xs font-semibold" style={{ color: STATUS_COLORS[file.status] }}>
          {file.status}
        </span>
      </div>
    );
  });
}

function commitTooltip(commit: GitCommit) {
  return `${commit.subject}\n${commit.author} · ${formatCommitDate(commit.date)} · ${commit.hash.slice(0, 8)}`;
}

/**
 * The commit history with its graph, shown below the changes in the Commit
 * tool window (VS Code's "Source Control Graph"). Clicking a commit lists the
 * files it changed.
 */
export function GitGraphSection() {
  const root = useWorkspace((s) => s.root);
  const status = useGit((s) => s.status);
  const [revision, setRevision] = useState("HEAD");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Map<string, CommitDetails | "loading" | string>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; commit: GitCommit } | null>(null);
  const [branchFrom, setBranchFrom] = useState<GitCommit | null>(null);
  const loadId = useRef(0);
  const closeMenu = useCallback(() => setMenu(null), []);

  const isRepo = status?.isRepo ?? false;
  const logRevision = revision === ALL_BRANCHES ? null : revision;

  const loadPage = useCallback(
    async (skip: number) => {
      if (!root) return;
      const id = ++loadId.current;
      setLoading(true);
      try {
        const page = await gitApi.log(root, logRevision, skip, PAGE_SIZE);
        if (id !== loadId.current) return;
        setCommits((previous) => (skip === 0 ? page : [...previous, ...page]));
        setHasMore(page.length === PAGE_SIZE);
        setError(null);
      } catch (e) {
        if (id === loadId.current) setError(errorMessage(e));
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    },
    [root, logRevision],
  );

  // New commits, checkouts and branch changes all move HEAD or the branch.
  useEffect(() => {
    if (isRepo) void loadPage(0);
    else setCommits([]);
  }, [isRepo, loadPage, status?.head, status?.branch]);

  useEffect(() => {
    if (root && isRepo) gitApi.branches(root).then(setBranches, () => setBranches([]));
  }, [root, isRepo, status?.branch]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = Math.min(MAX_LANES, Math.max(1, ...graph.map((r) => r.width)));

  const toggle = (commit: GitCommit) => {
    if (expanded.has(commit.hash)) {
      setExpanded((previous) => {
        const next = new Map(previous);
        next.delete(commit.hash);
        return next;
      });
      return;
    }
    setExpanded((previous) => new Map(previous).set(commit.hash, "loading"));
    if (!root) return;
    gitApi.commitDetails(root, commit.hash).then(
      (details) => setExpanded((previous) => (previous.has(commit.hash) ? new Map(previous).set(commit.hash, details) : previous)),
      (e) => setExpanded((previous) => new Map(previous).set(commit.hash, errorMessage(e))),
    );
  };

  const menuItems = (commit: GitCommit): MenuEntry[] => [
    { label: "Copy Revision Number", icon: Copy, action: () => void navigator.clipboard.writeText(commit.hash) },
    { label: "Copy Commit Subject", action: () => void navigator.clipboard.writeText(commit.subject) },
    "separator",
    { label: "Checkout Revision", icon: TriangleRight, action: () => void checkoutRevision(commit.hash) },
    { label: "New Branch…", icon: GitBranchPlus, action: () => setBranchFrom(commit) },
  ];

  const branchOptions = [
    { id: "HEAD", label: status?.branch ?? "HEAD" },
    { id: ALL_BRANCHES, label: "All Branches" },
    ...branches.filter((b) => b.name !== status?.branch).map((b) => ({ id: b.name, label: b.name })),
  ];
  const headHash = status?.head;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
        <div className="min-w-0 flex-1">
          <Select ariaLabel="History of" options={branchOptions} value={revision} onChange={setRevision} />
        </div>
        {loading && <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />}
      </div>
      <div
        role="tree"
        aria-label="Commits"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_HEIGHT * 20) {
            void loadPage(commits.length);
          }
        }}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {error && <p className="px-3 py-1 text-danger">{error}</p>}
        {!loading && !error && commits.length === 0 && <p className="px-3 py-1 text-fg-muted">No commits yet.</p>}
        {commits.map((commit, index) => {
          const details = expanded.get(commit.hash);
          const fileCount = details && typeof details === "object" ? details.files.length : 1;
          const height = details ? ROW_HEIGHT * (1 + fileCount) : ROW_HEIGHT;
          return (
            <div
              key={commit.hash}
              role="treeitem"
              aria-expanded={details !== undefined}
              onClick={() => toggle(commit)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, commit });
              }}
              className="mx-1 flex cursor-default rounded pr-1 pl-1"
            >
              <GraphCell row={graph[index]} lanes={lanes} isHead={commit.hash === headHash} height={height} />
              <div className="min-w-0 flex-1">
                <div
                  {...tooltipProps(commitTooltip(commit))}
                  style={{ height: ROW_HEIGHT }}
                  className="flex items-center gap-1.5 rounded pl-1 hover:bg-hover/50"
                >
                  {details ? (
                    <ChevronDown size={13} className="shrink-0 text-fg-muted" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0 text-fg-muted" />
                  )}
                  <span className={`truncate ${commit.hash === headHash ? "font-semibold" : ""}`}>{commit.subject}</span>
                  <RefBadges refs={commit.refs} />
                </div>
                {details && <CommitFiles commit={commit} details={details} />}
              </div>
            </div>
          );
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.commit)} onClose={closeMenu} />}
      {branchFrom && (
        <PromptDialog
          title={`New Branch from ${branchFrom.hash.slice(0, 8)}`}
          placeholder="feature/my-change"
          validate={validateBranchName}
          onSubmit={(name) => createBranch(name, branchFrom.hash)}
          onClose={() => setBranchFrom(null)}
        />
      )}
    </div>
  );
}
