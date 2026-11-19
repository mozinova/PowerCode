//! The API of VS Code's built-in Git extension (`vscode.git`, `getAPI(1)`), which
//! extensions use to find repositories, remotes and changes (GitHub Actions, GitHub
//! Pull Requests, GitLens, ...). PowerCode has no such extension, so the host provides
//! it, running `git` itself: on a remote host that is where the repository is. Also
//! `vscode.git-base` (remote source providers) and the `git:` document scheme.
//! An installed `vscode.git` / `vscode.git-base` extension takes precedence.

import { execFile } from "node:child_process";
import * as path from "node:path";
import { onDidSave } from "./documents";
import * as rpc from "./rpc";
import { host } from "./state";
import { Disposable, EventEmitter, Uri } from "./types";
import * as virtual from "./virtual";

/** `Status` of git.d.ts. */
const enum Status {
  INDEX_MODIFIED = 0, INDEX_ADDED = 1, INDEX_DELETED = 2, INDEX_RENAMED = 3, INDEX_COPIED = 4,
  MODIFIED = 5, DELETED = 6, UNTRACKED = 7, IGNORED = 8, INTENT_TO_ADD = 9, INTENT_TO_RENAME = 10, TYPE_CHANGED = 11,
  ADDED_BY_US = 12, ADDED_BY_THEM = 13, DELETED_BY_US = 14, DELETED_BY_THEM = 15, BOTH_ADDED = 16, BOTH_DELETED = 17, BOTH_MODIFIED = 18,
}

/** `RefType` of git.d.ts. */
const enum RefType {
  Head = 0, RemoteHead = 1, Tag = 2,
}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Read-only commands do not take Git's index lock, so they never block the user's own Git. */
const read = (cwd: string, args: string[]) => git(cwd, ["--no-optional-locks", ...args]);

interface Change {
  uri: Uri;
  originalUri: Uri;
  renameUri: Uri | undefined;
  status: Status;
}

const INDEX_STATUS: Record<string, Status> = { M: Status.INDEX_MODIFIED, A: Status.INDEX_ADDED, D: Status.INDEX_DELETED, R: Status.INDEX_RENAMED, C: Status.INDEX_COPIED, T: Status.TYPE_CHANGED };
const WORKTREE_STATUS: Record<string, Status> = { M: Status.MODIFIED, D: Status.DELETED, A: Status.INTENT_TO_ADD, R: Status.INTENT_TO_RENAME, T: Status.TYPE_CHANGED };
const MERGE_STATUS: Record<string, Status> = {
  DD: Status.BOTH_DELETED, AU: Status.ADDED_BY_US, UD: Status.DELETED_BY_THEM, UA: Status.ADDED_BY_THEM,
  DU: Status.DELETED_BY_US, AA: Status.BOTH_ADDED, UU: Status.BOTH_MODIFIED,
};

/** `git status --porcelain=v2 --branch -z` → the parts of `RepositoryState` it holds. */
export function parseStatus(root: string, output: string) {
  const file = (p: string) => Uri.file(path.join(root, p));
  const change = (p: string, status: Status, original?: string): Change => ({
    uri: file(p),
    originalUri: file(original ?? p),
    renameUri: original ? file(p) : undefined,
    status,
  });
  const result = {
    head: { name: undefined as string | undefined, commit: undefined as string | undefined, upstream: undefined as string | undefined, ahead: 0, behind: 0 },
    indexChanges: [] as Change[],
    workingTreeChanges: [] as Change[],
    mergeChanges: [] as Change[],
  };
  const records = output.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid" && value !== "(initial)") result.head.commit = value;
      if (key === "branch.head" && value !== "(detached)") result.head.name = value;
      if (key === "branch.upstream") result.head.upstream = value;
      if (key === "branch.ab") {
        const [ahead, behind] = rest.map((n) => Math.abs(parseInt(n, 10)) || 0);
        result.head.ahead = ahead;
        result.head.behind = behind;
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?") {
      // VS Code's default (`git.untrackedChanges: mixed`): untracked files are working tree changes.
      result.workingTreeChanges.push(change(record.slice(2), Status.UNTRACKED));
    } else if (kind === "1" || kind === "2") {
      const fields = record.split(" ");
      const xy = fields[1];
      const p = fields.slice(kind === "1" ? 8 : 9).join(" ");
      const original = kind === "2" ? records[++i] : undefined;
      if (xy[0] !== "." && INDEX_STATUS[xy[0]] !== undefined) result.indexChanges.push(change(p, INDEX_STATUS[xy[0]], original));
      if (xy[1] !== "." && WORKTREE_STATUS[xy[1]] !== undefined) result.workingTreeChanges.push(change(p, WORKTREE_STATUS[xy[1]]));
    } else if (kind === "u") {
      const fields = record.split(" ");
      result.mergeChanges.push(change(fields.slice(10).join(" "), MERGE_STATUS[fields[1]] ?? Status.BOTH_MODIFIED));
    }
  }
  return result;
}

function parseRemotes(output: string) {
  const remotes = new Map<string, { name: string; fetchUrl?: string; pushUrl?: string; isReadOnly: boolean }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const remote = remotes.get(match[1]) ?? { name: match[1], isReadOnly: false };
    if (match[3] === "fetch") remote.fetchUrl = match[2];
    else remote.pushUrl = match[2];
    remotes.set(match[1], remote);
  }
  return [...remotes.values()];
}

function parseRefs(output: string) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, commit] = line.split("\0");
      if (ref.startsWith("refs/heads/")) return { type: RefType.Head, name: ref.slice(11), commit };
      if (ref.startsWith("refs/tags/")) return { type: RefType.Tag, name: ref.slice(10), commit };
      if (ref.startsWith("refs/remotes/")) {
        const name = ref.slice(13);
        return { type: RefType.RemoteHead, name, commit, remote: name.split("/")[0] };
      }
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && !r.name.endsWith("/HEAD"));
}

const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%B"].join("%x00");

function parseCommits(output: string) {
  return output
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter(Boolean)
    .map((entry) => {
      const [hash, parents, authorName, authorEmail, authorDate, commitDate, message] = entry.split("\0");
      return {
        hash,
        parents: parents ? parents.split(" ") : [],
        authorName,
        authorEmail,
        authorDate: authorDate ? new Date(authorDate) : undefined,
        commitDate: commitDate ? new Date(commitDate) : undefined,
        message: (message ?? "").trimEnd(),
      };
    });
}

// ---- Repositories -----------------------------------------------------------------------

const unsupported = (what: string) => () => Promise.reject(new Error(`${what} is not supported by PowerCode's Git API.`));

function createRepository(root: string) {
  const onDidChange = new EventEmitter<void>();
  const onDidCommit = new EventEmitter<void>();
  const relative = (p: string | Uri) => path.relative(root, typeof p === "string" ? p : p.fsPath).replace(/\\/g, "/");
  const paths = (list: (string | Uri)[]) => list.map(relative);

  const state: any = {
    HEAD: undefined,
    refs: [],
    remotes: [],
    submodules: [],
    rebaseCommit: undefined,
    mergeChanges: [],
    indexChanges: [],
    workingTreeChanges: [],
    untrackedChanges: [],
    onDidChange: onDidChange.event,
  };

  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> =>
    (refreshing ??= (async () => {
      try {
        const [status, remotes, refs] = await Promise.all([
          read(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
          read(root, ["remote", "-v"]).catch(() => ""),
          read(root, ["for-each-ref", "--format=%(refname)%00%(objectname)"]).catch(() => ""),
        ]);
        const parsed = parseStatus(root, status);
        state.remotes = parseRemotes(remotes);
        state.refs = parseRefs(refs);
        const upstream = parsed.head.upstream;
        // `origin/feature/x`: the remote is the longest known remote name it starts with.
        const remote = upstream ? state.remotes.map((r: { name: string }) => r.name).filter((n: string) => upstream.startsWith(`${n}/`)).sort((a: string, b: string) => b.length - a.length)[0] : undefined;
        state.HEAD = {
          type: RefType.Head,
          name: parsed.head.name,
          commit: parsed.head.commit,
          upstream: upstream && remote ? { remote, name: upstream.slice(remote.length + 1), commit: state.refs.find((r: { name: string }) => r.name === upstream)?.commit } : undefined,
          ahead: parsed.head.ahead,
          behind: parsed.head.behind,
        };
        state.indexChanges = parsed.indexChanges;
        state.workingTreeChanges = parsed.workingTreeChanges;
        state.mergeChanges = parsed.mergeChanges;
        onDidChange.fire();
      } catch (e) {
        rpc.notify("log", { level: "warning", message: `Git status of ${root} failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        refreshing = null;
      }
    })());

  /** Runs a command that changes the repository, then refreshes the state. */
  const change = async (args: string[], input?: string) => {
    const output = await git(root, args, input);
    await refresh();
    return output;
  };

  const repository: any = {
    rootUri: Uri.file(root),
    inputBox: { value: "" },
    state,
    ui: { selected: true, onDidChange: new EventEmitter<void>().event },
    onDidCommit: onDidCommit.event,
    onDidCheckout: new EventEmitter<void>().event,

    status: refresh,
    getConfigs: async () =>
      (await read(root, ["config", "-l"])).split("\n").filter(Boolean).map((line) => {
        const eq = line.indexOf("=");
        return { key: line.slice(0, eq), value: line.slice(eq + 1) };
      }),
    getConfig: (key: string) => read(root, ["config", "--get", key]).then((v) => v.trim(), () => ""),
    getGlobalConfig: (key: string) => read(root, ["config", "--global", "--get", key]).then((v) => v.trim(), () => ""),
    setConfig: (key: string, value: string) => git(root, ["config", "--local", key, value]).then(() => ""),
    unsetConfig: (key: string) => git(root, ["config", "--local", "--unset", key]).then(() => ""),

    show: (ref: string, p: string) => read(root, ["show", `${ref}:${relative(p)}`]),
    buffer: async (ref: string, p: string) => Buffer.from(await read(root, ["show", `${ref}:${relative(p)}`]), "utf8"),
    getObjectDetails: async (treeish: string, p: string) => {
      const line = (await read(root, ["ls-tree", "-l", treeish, "--", relative(p)])).trim();
      const [mode, , object, size] = line.split(/\s+/);
      return { mode, object, size: Number(size) || 0 };
    },
    detectObjectType: async () => ({ mimetype: "text/plain" }),
    getCommit: async (ref: string) => parseCommits(`${await read(root, ["show", "-s", `--format=${COMMIT_FORMAT}%x1e`, ref])}`)[0],
    log: async (options: { maxEntries?: number; path?: string; range?: string } = {}) => {
      const args = ["log", `-n${options.maxEntries ?? 32}`, `--format=${COMMIT_FORMAT}%x1e`];
      if (options.range) args.push(options.range);
      if (options.path) args.push("--", relative(options.path));
      return parseCommits(await read(root, args));
    },
    blame: (p: string) => read(root, ["blame", "--", relative(p)]),

    getBranch: async (name: string) => {
      await refresh();
      return state.refs.find((r: { type: RefType; name: string }) => r.name === name && r.type !== RefType.Tag);
    },
    getBranches: async (query: { remote?: boolean } = {}) => {
      await refresh();
      return state.refs.filter((r: { type: RefType }) => r.type === RefType.Head || (query.remote && r.type === RefType.RemoteHead));
    },
    getRefs: async () => {
      await refresh();
      return state.refs;
    },
    getMergeBase: (a: string, b: string) => read(root, ["merge-base", a, b]).then((v) => v.trim(), () => undefined),

    diff: (cached = false) => read(root, ["diff", ...(cached ? ["--cached"] : [])]),
    diffWithHEAD: (p?: string) => (p ? read(root, ["diff", "HEAD", "--", relative(p)]) : Promise.resolve(state.workingTreeChanges)),
    diffWith: (ref: string, p?: string) => read(root, ["diff", ref, ...(p ? ["--", relative(p)] : [])]),
    diffIndexWithHEAD: (p?: string) => (p ? read(root, ["diff", "--cached", "--", relative(p)]) : Promise.resolve(state.indexChanges)),
    diffIndexWith: (ref: string, p?: string) => read(root, ["diff", "--cached", ref, ...(p ? ["--", relative(p)] : [])]),
    diffBlobs: (a: string, b: string) => read(root, ["diff", a, b]),
    diffBetween: (a: string, b: string, p?: string) => read(root, ["diff", `${a}...${b}`, ...(p ? ["--", relative(p)] : [])]),
    hashObject: (data: string) => git(root, ["hash-object", "-w", "--stdin"], data).then((v) => v.trim()),

    add: (list: (string | Uri)[]) => change(["add", "-A", "--", ...paths(list)]).then(() => undefined),
    // As VS Code's: unstages (`reset HEAD`), the working tree stays.
    revert: (list: (string | Uri)[]) => change(["reset", "-q", "HEAD", "--", ...paths(list)]).then(() => undefined),
    clean: async (list: (string | Uri)[]) => {
      const files = paths(list);
      await git(root, ["checkout", "-q", "--", ...files]).catch(() => {});
      await change(["clean", "-f", "-q", "--", ...files]);
    },
    commit: async (message: string, opts: { all?: boolean | "tracked"; amend?: boolean; signoff?: boolean } = {}) => {
      const args = ["commit", "-m", message];
      if (opts.all) args.push("--all");
      if (opts.amend) args.push("--amend");
      if (opts.signoff) args.push("--signoff");
      await change(args);
      onDidCommit.fire();
    },
    checkout: (treeish: string) => change(["checkout", "-q", treeish]).then(() => undefined),
    createBranch: (name: string, checkout: boolean, ref?: string) =>
      change(checkout ? ["checkout", "-q", "-b", name, ...(ref ? [ref] : [])] : ["branch", name, ...(ref ? [ref] : [])]).then(() => undefined),
    deleteBranch: (name: string, force?: boolean) => change(["branch", force ? "-D" : "-d", name]).then(() => undefined),
    setBranchUpstream: (name: string, upstream: string) => change(["branch", "--set-upstream-to", upstream, name]).then(() => undefined),
    tag: (name: string, upstream: string) => change(["tag", name, upstream]).then(() => undefined),
    deleteTag: (name: string) => change(["tag", "-d", name]).then(() => undefined),
    addRemote: (name: string, url: string) => change(["remote", "add", name, url]).then(() => undefined),
    removeRemote: (name: string) => change(["remote", "remove", name]).then(() => undefined),
    renameRemote: (name: string, newName: string) => change(["remote", "rename", name, newName]).then(() => undefined),
    fetch: (options?: { remote?: string; ref?: string; all?: boolean; prune?: boolean } | string, ref?: string) => {
      const o = typeof options === "string" ? { remote: options, ref } : (options ?? {});
      return change(["fetch", ...(o.all ? ["--all"] : []), ...(o.prune ? ["--prune"] : []), ...(o.remote ? [o.remote] : []), ...(o.ref ? [o.ref] : [])]).then(() => undefined);
    },
    pull: () => change(["pull"]).then(() => undefined),
    push: (remote?: string, branch?: string, setUpstream?: boolean, force?: number) =>
      change(["push", ...(setUpstream ? ["-u"] : []), ...(force ? ["--force-with-lease"] : []), ...(remote ? [remote] : []), ...(branch ? [branch] : [])]).then(() => undefined),
    merge: (ref: string) => change(["merge", ref]).then(() => undefined),
    mergeAbort: () => change(["merge", "--abort"]).then(() => undefined),
    apply: (patch: string, reverse?: boolean) => change(["apply", ...(reverse ? ["-R"] : []), "-"], patch).then(() => undefined),
    getBranchBase: unsupported("getBranchBase"),
    applyStash: unsupported("applyStash"),
    popStash: unsupported("popStash"),
    dropStash: unsupported("dropStash"),
  };
  return { repository, refresh };
}

// ---- The API ------------------------------------------------------------------------------

const repositories = new Map<string, ReturnType<typeof createRepository>>();
const onDidOpenRepository = new EventEmitter<unknown>();
const onDidCloseRepository = new EventEmitter<unknown>();
const onDidChangeState = new EventEmitter<string>();
let apiState: "uninitialized" | "initialized" = "uninitialized";
let discovering: Promise<void> | null = null;

const key = (root: string) => (process.platform === "win32" ? root.toLowerCase() : root);

async function openRepository(folder: string) {
  const top = (await read(folder, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!top) return null;
  const root = path.normalize(top);
  const existing = repositories.get(key(root));
  if (existing) return existing.repository;
  const entry = createRepository(root);
  repositories.set(key(root), entry);
  await entry.refresh();
  onDidOpenRepository.fire(entry.repository);
  return entry.repository;
}

/** Finds the workspace's repositories, once. Git stays off in untrusted folders, as in VS Code. */
function discover() {
  discovering ??= (async () => {
    if (host.trusted) for (const folder of host.workspaceFolders) await openRepository(folder.uri.fsPath);
    apiState = "initialized";
    onDidChangeState.fire(apiState);
  })();
  return discovering;
}

function repositoryFor(uri: Uri) {
  const file = key(path.normalize(uri.fsPath));
  let best: ReturnType<typeof createRepository> | undefined;
  for (const [root, entry] of repositories) {
    if ((file === root || file.startsWith(root + path.sep)) && (!best || root.length > key(best.repository.rootUri.fsPath).length)) best = entry;
  }
  return best?.repository ?? null;
}

const api = {
  get state() {
    return apiState;
  },
  onDidChangeState: onDidChangeState.event,
  onDidPublish: new EventEmitter<unknown>().event,
  git: { path: "git" },
  get repositories() {
    return [...repositories.values()].map((e) => e.repository);
  },
  onDidOpenRepository: onDidOpenRepository.event,
  onDidCloseRepository: onDidCloseRepository.event,
  toGitUri: (uri: Uri, ref: string) => uri.with({ scheme: "git", path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) }),
  getRepository: (uri: Uri) => repositoryFor(uri),
  getRepositoryRoot: async (uri: Uri) => {
    const top = (await read(path.dirname(uri.fsPath), ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    return top ? Uri.file(path.normalize(top)) : null;
  },
  openRepository: (root: Uri) => (host.trusted ? openRepository(root.fsPath) : Promise.resolve(null)),
  init: async (root: Uri) => {
    if (!host.trusted) return null;
    await git(root.fsPath, ["init"]);
    return openRepository(root.fsPath);
  },
  registerRemoteSourcePublisher: () => new Disposable(() => {}),
  registerRemoteSourceProvider: () => new Disposable(() => {}),
  registerCredentialsProvider: () => new Disposable(() => {}),
  registerPostCommitCommandsProvider: () => new Disposable(() => {}),
  registerPushErrorHandler: () => new Disposable(() => {}),
  registerBranchProtectionProvider: () => new Disposable(() => {}),
  registerSourceControlHistoryItemDetailsProvider: () => new Disposable(() => {}),
};

/** The `exports` of the `vscode.git` extension. */
export const gitExports = {
  get enabled() {
    return host.trusted;
  },
  onDidChangeEnablement: new EventEmitter<boolean>().event,
  getAPI(version: number) {
    if (version !== 1) throw new Error(`No API version ${version} found.`);
    void discover();
    return api;
  },
};

/** The `exports` of `vscode.git-base`: remote source providers (kept, not shown anywhere yet). */
const remoteSourceProviders = new Set<unknown>();
export const gitBaseExports = {
  enabled: true,
  onDidChangeEnablement: new EventEmitter<boolean>().event,
  getAPI(version: number) {
    if (version !== 1) throw new Error(`No API version ${version} found.`);
    return {
      registerRemoteSourceProvider(provider: unknown) {
        remoteSourceProviders.add(provider);
        return new Disposable(() => remoteSourceProviders.delete(provider));
      },
      getRemoteProviders: () => [...remoteSourceProviders],
      getRemoteSourceActions: async () => [],
      pickRemoteSource: async () => undefined,
    };
  },
};

/** Extensions PowerCode provides itself, by id, unless the real one is installed. */
export const BUILTIN_EXTENSIONS: Record<string, { name: string; displayName: string; exports: unknown }> = {
  "vscode.git": { name: "git", displayName: "Git", exports: gitExports },
  "vscode.git-base": { name: "git-base", displayName: "Git Base", exports: gitBaseExports },
};

let refreshTimer: NodeJS.Timeout | undefined;

/** Refreshes every repository's state soon (several triggers in a row make one refresh). */
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const entry of repositories.values()) void entry.refresh();
  }, 300);
}

export function listen() {
  // `git:` documents (originals in diffs): the file at a revision; `ref` "" or "~" is the index.
  virtual.registerContentProvider("git", {
    async provideTextDocumentContent(uri: Uri) {
      if (!host.trusted) return "";
      const query = JSON.parse(uri.query || "{}") as { path?: string; ref?: string };
      const file = query.path ?? uri.fsPath;
      const repository = repositoryFor(Uri.file(file)) ?? (await openRepository(path.dirname(file)).catch(() => null));
      if (!repository) return "";
      const ref = !query.ref || query.ref === "~" ? "" : query.ref;
      return repository.show(ref, file).catch(() => "");
    },
  });
  // The UI's Git saw changes (it polls, and refreshes after its own commands), and saves.
  rpc.onNotification("git/changed", refreshSoon);
  onDidSave.event(refreshSoon);
}
