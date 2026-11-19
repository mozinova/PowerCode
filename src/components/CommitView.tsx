import {
  ArrowDownUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Group as PanelGroup, Panel, Separator } from "react-resizable-panels";
import { commit, initRepository, openDiff, rollback, stage, unstage } from "../git/actions";
import { GIT_COLORS, GIT_LETTERS, fileState, refreshGit, useGit } from "../git/store";
import type { GitFile } from "../lib/ipc";
import { basename, isWithin, parentDir } from "../lib/paths";
import { showTrustDialog, useTrust } from "../state/trust";
import { useWorkspace } from "../state/workspace";
import { FileIcon } from "./FileIcon";
import { GitGraphSection } from "./GitGraph";
import { DropdownMenu, type MenuEntry } from "./Menu";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";
import { ExtensionSourceControls } from "./SourceControlView";

function RowAction({ icon: Icon, title, onClick }: { icon: typeof Plus; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      {...tooltipProps(title)}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
    >
      <Icon size={14} />
    </button>
  );
}

function FileRow({ file, actions }: { file: GitFile; actions: ReactNode }) {
  const root = useWorkspace((s) => s.root);
  const state = fileState(file);
  const dir = parentDir(file.path);
  const relativeDir = root && isWithin(dir, root) && dir !== root ? dir.slice(root.length + 1) : "";
  return (
    <div
      role="treeitem"
      onClick={() => openDiff(file.path)}
      {...tooltipProps(file.path)}
      className="group mx-1 flex h-7 cursor-default items-center gap-1.5 rounded pr-1 pl-7 hover:bg-hover/50"
    >
      <FileIcon name={basename(file.path)} size={16} />
      <span className="shrink-0" style={{ color: GIT_COLORS[state] }}>
        {basename(file.path)}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{relativeDir}</span>
      <span className="hidden items-center group-hover:flex">{actions}</span>
      <span className="w-4 shrink-0 text-center text-xs font-semibold" style={{ color: GIT_COLORS[state] }}>
        {GIT_LETTERS[state]}
      </span>
    </div>
  );
}

function Group({
  title,
  files,
  actions,
  rowActions,
}: {
  title: string;
  files: GitFile[];
  actions: ReactNode;
  rowActions: (file: GitFile) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;
  return (
    <div role="group">
      <div
        onClick={() => setOpen(!open)}
        className="group mx-1 flex h-7 cursor-default items-center gap-1 rounded pr-1 pl-1.5 hover:bg-hover/50"
      >
        {open ? <ChevronDown size={15} className="text-fg-muted" /> : <ChevronRight size={15} className="text-fg-muted" />}
        <span className="font-medium">{title}</span>
        <span className="ml-1 flex-1 text-xs text-fg-subtle">{files.length}</span>
        <span className="hidden items-center group-hover:flex">{actions}</span>
      </div>
      {open && files.map((file) => <FileRow key={file.path} file={file} actions={rowActions(file)} />)}
    </div>
  );
}

function NotARepository() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-fg-muted">
      <p>This folder is not a Git repository.</p>
      <button
        type="button"
        onClick={() => void initRepository()}
        className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover"
      >
        Initialize Repository
      </button>
    </div>
  );
}

type CommitAction = "commit" | "push" | "sync" | "amend";

/** "Commit" with a dropdown of the other ways to commit, as a split button. */
function CommitButton({
  busy,
  hasMessage,
  onSubmit,
}: {
  busy: boolean;
  hasMessage: boolean;
  onSubmit: (action: CommitAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const items: MenuEntry[] = [
    { label: "Commit", icon: Check, shortcut: "Enter", disabled: !hasMessage, action: () => onSubmit("commit") },
    { label: "Commit and Push", icon: ArrowUpFromLine, disabled: !hasMessage, action: () => onSubmit("push") },
    { label: "Commit and Sync", icon: ArrowDownUp, disabled: !hasMessage, action: () => onSubmit("sync") },
    "separator",
    {
      label: "Amend Last Commit",
      icon: Pencil,
      detail: hasMessage ? undefined : "keeps its message",
      action: () => onSubmit("amend"),
    },
  ];
  const base = "flex h-7 items-center bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent";

  return (
    <div ref={anchorRef} className="flex w-full">
      <button
        type="button"
        disabled={busy || !hasMessage}
        onClick={() => onSubmit("commit")}
        {...tooltipProps("Commit", "Enter")}
        className={`${base} flex-1 justify-center gap-1.5 rounded-l-md px-3 font-medium`}
      >
        {busy && <Loader2 size={13} className="animate-spin" />}
        Commit
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label="More commit actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`${base} rounded-r-md border-l border-white/25 px-1.5`}
      >
        <ChevronDown size={14} />
      </button>
      {open && <DropdownMenu items={items} anchorRef={anchorRef} onClose={close} />}
    </div>
  );
}

export function CommitView() {
  const status = useGit((s) => s.status);
  const root = useWorkspace((s) => s.root);
  const trust = useTrust((s) => s.state);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const files = status?.files.filter((f) => !f.ignored) ?? [];
  const staged = files.filter((f) => f.index && !f.conflicted);
  const changes = files.filter((f) => (f.worktree || f.conflicted) && !f.untracked);
  const untracked = files.filter((f) => f.untracked);

  const submit = async (action: CommitAction) => {
    const amend = action === "amend";
    // Amending without a message keeps the previous one.
    if (!message.trim() && !amend) return;
    setBusy(true);
    try {
      const after = action === "push" ? "push" : action === "sync" ? "sync" : "none";
      if (await commit(message.trim(), amend, after)) setMessage("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Commit">
        <IconButton icon={RefreshCw} title="Refresh" onClick={() => void refreshGit()} className="size-7" size={14} />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("commit")} className="size-7" />
      </ToolWindowHeader>

      {!root ? (
        <p className="px-3 text-fg-muted">No folder is open.</p>
      ) : trust !== "trusted" ? (
        <div className="flex flex-col gap-2 px-3 text-fg-muted">
          <p>Git is off in Restricted Mode: a repository's settings can run commands, so PowerCode does not run Git in folders you have not trusted.</p>
          <button
            type="button"
            onClick={() => showTrustDialog(root)}
            className="h-7 w-fit rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover"
          >
            Manage Workspace Trust
          </button>
        </div>
      ) : !status?.isRepo ? (
        <NotARepository />
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 pb-1.5 text-xs text-fg-muted">
            <GitBranch size={13} />
            <span className="truncate">{status.branch ?? "detached HEAD"}</span>
            {status.upstream && <span className="truncate text-fg-subtle">→ {status.upstream}</span>}
          </div>
          {/* As in VS Code: message and commit button on top, then changes and the graph. */}
          <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit("commit");
                }
              }}
              placeholder={`Message (Enter to commit on "${status.branch ?? "HEAD"}")`}
              spellCheck={false}
              autoComplete="off"
              className="h-8 w-full rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <CommitButton
              busy={busy}
              hasMessage={message.trim().length > 0}
              onSubmit={(action) => void submit(action)}
            />
          </div>

          <Sections
            changes={
              <ChangesTree
                files={files}
                staged={staged}
                changes={changes}
                untracked={untracked}
              />
            }
          />
        </>
      )}
      {/* Extensions' own source control (Perforce, SVN, ...), when any is registered. */}
      {root && <ExtensionSourceControls />}
    </div>
  );
}

function ChangesTree({
  files,
  staged,
  changes,
  untracked,
}: {
  files: GitFile[];
  staged: GitFile[];
  changes: GitFile[];
  untracked: GitFile[];
}) {
  const paths = (list: GitFile[]) => list.map((f) => f.path);
  return (
    <div role="tree" className="h-full overflow-y-auto pb-2">
      {files.length === 0 && <p className="px-3 py-2 text-fg-muted">No changes.</p>}
      <Group
        title="Staged"
        files={staged}
        actions={<RowAction icon={Minus} title="Unstage All" onClick={() => void unstage(paths(staged))} />}
        rowActions={(f) => <RowAction icon={Minus} title="Unstage" onClick={() => void unstage([f.path])} />}
      />
      <Group
        title="Changes"
        files={changes}
        actions={
          <>
            <RowAction icon={Undo2} title="Rollback All" onClick={() => void rollback(changes)} />
            <RowAction icon={Plus} title="Stage All" onClick={() => void stage(paths(changes))} />
          </>
        }
        rowActions={(f) => (
          <>
            <RowAction icon={Undo2} title="Rollback" onClick={() => void rollback([f])} />
            <RowAction icon={Plus} title="Stage" onClick={() => void stage([f.path])} />
          </>
        )}
      />
      <Group
        title="Unversioned Files"
        files={untracked}
        actions={<RowAction icon={Plus} title="Stage All" onClick={() => void stage(paths(untracked))} />}
        rowActions={(f) => <RowAction icon={Plus} title="Stage" onClick={() => void stage([f.path])} />}
      />
    </div>
  );
}

function SectionHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-7 w-full shrink-0 items-center gap-1 border-t border-line px-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase hover:text-fg"
    >
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      {title}
    </button>
  );
}

/** The Changes and Graph sections, collapsible and resizable against each other. */
function Sections({ changes }: { changes: ReactNode }) {
  const [changesOpen, setChangesOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const changesHeader = (
    <SectionHeader title="Changes" open={changesOpen} onToggle={() => setChangesOpen(!changesOpen)} />
  );
  const graphHeader = <SectionHeader title="Graph" open={graphOpen} onToggle={() => setGraphOpen(!graphOpen)} />;

  if (changesOpen && graphOpen) {
    return (
      <PanelGroup orientation="vertical" className="min-h-0 flex-1">
        <Panel id="commit-changes" minSize={80} className="flex flex-col">
          {changesHeader}
          <div className="min-h-0 flex-1">{changes}</div>
        </Panel>
        <Separator />
        <Panel id="commit-graph" defaultSize="45" minSize={80} className="flex flex-col">
          {graphHeader}
          <div className="min-h-0 flex-1 pt-1.5">
            <GitGraphSection />
          </div>
        </Panel>
      </PanelGroup>
    );
  }
  // With a section collapsed, the open one takes the space and the closed header sits in place.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {changesHeader}
      {changesOpen && <div className="min-h-0 flex-1">{changes}</div>}
      {graphHeader}
      {graphOpen && (
        <div className="min-h-0 flex-1 pt-1.5">
          <GitGraphSection />
        </div>
      )}
    </div>
  );
}
