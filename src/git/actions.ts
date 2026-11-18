import { ask } from "@tauri-apps/plugin-dialog";
import { reloadCleanModels } from "../editor/models";
import { fsApi, gitApi, type GitFile } from "../lib/ipc";
import { basename } from "../lib/paths";
import { commitDiffTabPath, commitDiffTabTitle, diffTabPath, diffTabTitle } from "../lib/virtualTabs";
import { notify, withProgress } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { refreshGit, useGit } from "./store";

function root(): string {
  const root = useWorkspace.getState().root;
  if (!root) throw new Error("No folder is open.");
  return root;
}

/** After git rewrote files on disk: reload open files, the tree and the status. */
async function afterWorkingTreeChange() {
  await reloadCleanModels();
  useWorkspace.getState().filesChanged();
  await refreshGit();
}

export function openDiff(path: string) {
  useWorkspace.getState().openFile(diffTabPath(path), diffTabTitle(path));
}

export async function stage(paths: string[]) {
  if (paths.length === 0) return;
  await withProgress("Stage", () => gitApi.stage(root(), paths));
  await refreshGit();
}

export async function unstage(paths: string[]) {
  if (paths.length === 0) return;
  await withProgress("Unstage", () => gitApi.unstage(root(), paths));
  await refreshGit();
}

/** Rolls back changes: tracked files are restored, untracked ones moved to the trash. */
export async function rollback(files: GitFile[]) {
  if (files.length === 0) return;
  const names = files.length === 1 ? `"${basename(files[0].path)}"` : `${files.length} files`;
  const confirmed = await ask(`Roll back the changes in ${names}? Unstaged changes will be lost.`, {
    title: "Rollback",
    kind: "warning",
    okLabel: "Rollback",
    cancelLabel: "Cancel",
  });
  if (!confirmed) return;
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  await withProgress("Rollback", async () => {
    if (tracked.length) await gitApi.discard(root(), tracked);
    for (const path of untracked) await fsApi.deletePath(path);
  });
  await afterWorkingTreeChange();
}

/** What to do once the commit is made: nothing, push it, or pull then push (sync). */
export type AfterCommit = "none" | "push" | "sync";

/** Commits staged changes; with nothing staged, offers to stage everything first. */
export async function commit(message: string, amend: boolean, after: AfterCommit = "none"): Promise<boolean> {
  const files = useGit.getState().status?.files ?? [];
  const staged = files.filter((f) => f.index && !f.ignored);
  if (staged.length === 0 && !amend) {
    const changed = files.filter((f) => !f.ignored);
    if (changed.length === 0) {
      notify("info", "Nothing to commit");
      return false;
    }
    const stageAll = await ask("No changes are staged. Stage all changes and commit them?", {
      title: "Commit",
      kind: "info",
      okLabel: "Stage All and Commit",
      cancelLabel: "Cancel",
    });
    if (!stageAll) return false;
    await gitApi.stage(root(), changed.map((f) => f.path));
  }

  const committed = await withProgress(
    amend ? "Amend commit" : "Commit",
    () => gitApi.commit(root(), message, amend),
    () => ({ title: amend ? "Commit amended" : "Committed", message: message.split("\n")[0] }),
  );
  await refreshGit();
  if (committed === undefined) return false;
  if (after === "sync") await pull();
  if (after !== "none") await pushBranch();
  return true;
}

export async function pushBranch() {
  await withProgress("Push", () => gitApi.push(root()), () => ({ title: "Pushed" }));
  await refreshGit();
}

export async function pull() {
  await withProgress("Update project", () => gitApi.pull(root()), (out) => ({
    title: "Project updated",
    message: out.trim() || undefined,
  }));
  await afterWorkingTreeChange();
}

export async function fetchAll() {
  await withProgress("Fetch", () => gitApi.fetch(root()), () => ({ title: "Fetched" }));
  await refreshGit();
}

export async function checkout(branch: string, remote: boolean) {
  await withProgress(`Checkout ${branch}`, () => gitApi.checkout(root(), branch, remote), () => ({
    title: `Checked out ${remote ? branch.slice(branch.indexOf("/") + 1) : branch}`,
  }));
  await afterWorkingTreeChange();
}

/** Creates and switches to a branch, at HEAD or at the `start` commit. */
export async function createBranch(name: string, start?: string) {
  await gitApi.createBranch(root(), name, start);
  notify("success", `Created branch ${name}`);
  await afterWorkingTreeChange();
}

export function openCommitDiff(hash: string, path: string) {
  useWorkspace.getState().openFile(commitDiffTabPath(hash, path), commitDiffTabTitle(hash, path));
}

/** Checks out a commit with a detached HEAD. */
export async function checkoutRevision(hash: string) {
  await withProgress(`Checkout ${hash.slice(0, 8)}`, () => gitApi.checkoutRevision(root(), hash), () => ({
    title: `Checked out ${hash.slice(0, 8)}`,
    message: "HEAD is now detached; create a branch to keep new commits.",
  }));
  await afterWorkingTreeChange();
}

export async function initRepository() {
  await withProgress("Initialize repository", () => gitApi.init(root()), () => ({
    title: "Git repository created",
  }));
  await refreshGit();
}

/** Rough check of git's ref name rules, for early feedback in the UI. */
export function validateBranchName(name: string): string | null {
  if (!name) return "Name cannot be empty.";
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(name)) return "Not a valid branch name.";
  return null;
}
