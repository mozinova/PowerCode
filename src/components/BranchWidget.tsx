import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitGraph,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkout, createBranch, fetchAll, pull, pushBranch, validateBranchName } from "../git/actions";
import { useGit } from "../git/store";
import { gitApi, type GitBranch as Branch } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";
import { DropdownMenu, type MenuEntry } from "./Menu";
import { PromptDialog } from "./PromptDialog";
import { tooltipProps } from "./Tooltip";

/** Current branch in the title bar, with the VCS actions menu (IntelliJ's branch widget). */
export function BranchWidget() {
  const status = useGit((s) => s.status);
  const root = useWorkspace((s) => s.root);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [creating, setCreating] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open || !root) return;
    gitApi.branches(root).then(setBranches, () => setBranches([]));
  }, [open, root]);

  if (!status?.isRepo) return null;

  const label = status.detached ? `HEAD (${status.head?.slice(0, 7) ?? "detached"})` : (status.branch ?? "main");
  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote);
  const { setLeftTool } = useWorkspace.getState();

  const items: MenuEntry[] = [
    {
      label: "Update Project…",
      icon: ArrowDownToLine,
      detail: status.behind ? `${status.behind} incoming` : undefined,
      action: () => void pull(),
    },
    { label: "Commit…", icon: GitCommitHorizontal, shortcut: "Alt+0", action: () => setLeftTool("commit") },
    {
      label: "Push…",
      icon: ArrowUpFromLine,
      detail: status.ahead ? `${status.ahead} outgoing` : undefined,
      action: () => void pushBranch(),
    },
    { label: "Fetch", icon: RefreshCw, action: () => void fetchAll() },
    {
      label: "Show Git Log",
      icon: GitGraph,
      shortcut: "Alt+9",
      action: () => setLeftTool("commit"),
    },
    "separator",
    { label: "New Branch…", icon: GitBranchPlus, action: () => setCreating(true) },
  ];
  if (local.length) {
    items.push("separator", { label: "Local Branches", disabled: true, action: () => {} });
    for (const branch of local) {
      items.push({
        label: branch.name,
        icon: GitBranch,
        detail: branch.upstream ?? undefined,
        checked: branch.current,
        action: () => !branch.current && void checkout(branch.name, false),
      });
    }
  }
  if (remote.length) {
    items.push("separator", { label: "Remote Branches", disabled: true, action: () => {} });
    for (const branch of remote) {
      items.push({ label: branch.name, icon: GitBranch, action: () => void checkout(branch.name, true) });
    }
  }

  return (
    <div ref={anchorRef}>
      <button
        type="button"
        {...tooltipProps(status.upstream ? `${label} → ${status.upstream}` : label)}
        onClick={() => setOpen(!open)}
        className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover ${open ? "bg-hover" : ""}`}
      >
        <GitBranch size={15} className="shrink-0 text-fg-muted" />
        <span className="max-w-48 truncate">{label}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="text-xs text-fg-muted">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && ` ↓${status.behind}`}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0 text-fg-muted" />
      </button>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
      {creating && (
        <PromptDialog
          title="Create New Branch"
          placeholder="feature/my-change"
          validate={validateBranchName}
          onSubmit={createBranch}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
