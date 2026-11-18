import { Channel, invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export const fsApi = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  /** Paths relative to `root`, honouring `.gitignore`. */
  listProjectFiles: (root: string) => invoke<string[]>("list_project_files", { root }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  /** Moves `path` to the OS trash. */
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
};

export type TerminalEvent = { event: "output"; data: string } | { event: "exit" };

export interface TerminalProfile {
  /** e.g. `powershell`, `git-bash`, `wsl:Ubuntu`. */
  id: string;
  name: string;
}

export interface TerminalProgram {
  command: string;
  args: string[];
  /** `null` removes a variable. */
  env: Record<string, string | null>;
}

export const terminalApi = {
  /**
   * `profile` null uses the default shell; remote workspaces always use the remote shell.
   * With `program`, that program runs instead of a shell (e.g. a debugger's `runInTerminal`).
   */
  spawn: (
    cwd: string | null,
    profile: string | null,
    cols: number,
    rows: number,
    onEvent: (e: TerminalEvent) => void,
    program?: TerminalProgram,
  ) => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("terminal_spawn", { cwd, profile, cols, rows, program: program ?? null, onEvent: channel });
  },
  profiles: () => invoke<TerminalProfile[]>("terminal_profiles"),
  write: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  resize: (id: number, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  kill: (id: number) => invoke<void>("terminal_kill", { id }),
};

export interface OpenVsxEntry {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  downloadCount?: number;
  verified?: boolean;
  files: { icon?: string; download?: string };
}

export interface InstalledExtension {
  /** `publisher.name`, lower-cased; also the directory name. */
  id: string;
  path: string;
  manifest: ExtensionManifest;
}

export interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  description?: string;
  icon?: string;
  /** Entry point of extensions with code, run by the extension host. */
  main?: string;
  contributes?: {
    commands?: { command: string; title: string | { value: string }; category?: string | { value: string } }[];
    languages?: {
      id: string;
      extensions?: string[];
      filenames?: string[];
      aliases?: string[];
      configuration?: string;
    }[];
    grammars?: {
      language?: string;
      scopeName: string;
      path: string;
      embeddedLanguages?: Record<string, string>;
      injectTo?: string[];
    }[];
    themes?: { id?: string; label: string; uiTheme: string; path: string }[];
    snippets?: { language: string; path: string }[];
    iconThemes?: { id: string; label?: string; path: string }[];
  };
}

/** The parts of Open VSX's extension metadata used by the details page. */
export interface OpenVsxMetadata {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  verified?: boolean;
  downloadCount?: number;
  averageRating?: number;
  reviewCount?: number;
  timestamp?: string;
  license?: string;
  repository?: string;
  homepage?: string;
  categories?: string[];
  files?: { icon?: string };
}

export interface ExtensionDetails {
  metadata: OpenVsxMetadata;
  readme: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** Null when the server did not report the size. */
  total: number | null;
}

export const extensionsApi = {
  search: (query: string) => invoke<OpenVsxEntry[]>("openvsx_search", { query }),
  details: (namespace: string, name: string) =>
    invoke<ExtensionDetails>("openvsx_details", { namespace, name }),
  list: () => invoke<InstalledExtension[]>("extensions_list"),
  /**
   * Latest Open VSX version of each installed `publisher.name` id, and whether the
   * installed package is for another platform; unknown ids are left out.
   */
  latestVersions: (ids: string[]) =>
    invoke<Record<string, { version: string; wrongPlatform: boolean }>>("openvsx_latest_versions", { ids }),
  install: (namespace: string, name: string, onProgress: (progress: DownloadProgress) => void) => {
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<InstalledExtension>("extensions_install", { namespace, name, onProgress: channel });
  },
  uninstall: (id: string) => invoke<void>("extensions_uninstall", { id }),
  readFile: (id: string, relative: string) =>
    invoke<string>("extensions_read_file", { id, relative }),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs. */
  include: string;
  exclude: string;
}

export interface LineMatch {
  line: number;
  /** 1-based UTF-16 columns of the first match, as Monaco uses. */
  column: number;
  endColumn: number;
  preview: string;
  /** `[start, end)` UTF-16 offsets of each match within `preview`. */
  ranges: [number, number][];
}

export interface FileMatches {
  path: string;
  relative: string;
  matches: LineMatch[];
}

export type SearchEvent =
  | { event: "file"; data: FileMatches }
  | { event: "done"; data: { files: number; matches: number; truncated: boolean } };

export const searchApi = {
  /** Starting a search cancels the previous one. */
  search: (root: string, options: SearchOptions, onEvent: (e: SearchEvent) => void) => {
    const channel = new Channel<SearchEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("search_in_files", { root, options, onEvent: channel });
  },
};

export interface GitFile {
  path: string;
  /** Staged status letter (`M`, `A`, `D`, `R`, ...), empty when unchanged. */
  index: string;
  /** Unstaged status letter, empty when unchanged. */
  worktree: string;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
  origPath: string | null;
}

export interface GitStatus {
  isRepo: boolean;
  top: string | null;
  /** Commit id of HEAD; null before the first commit. */
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the Unix epoch. */
  date: number;
  subject: string;
  /** e.g. `HEAD -> main`, `origin/main`, `tag: v1.0`. */
  refs: string[];
}

export interface CommitFile {
  path: string;
  /** `A`, `M`, `D`, `R`, `C` or `T`. */
  status: string;
  origPath: string | null;
}

export interface CommitDetails {
  message: string;
  files: CommitFile[];
}

export const gitApi = {
  status: (root: string) => invoke<GitStatus>("git_status", { root }),
  /** The file's content at HEAD, or null if it is not committed. */
  showHead: (root: string, path: string) => invoke<string | null>("git_show_head", { root, path }),
  stage: (root: string, paths: string[]) => invoke<string>("git_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => invoke<string>("git_unstage", { root, paths }),
  discard: (root: string, paths: string[]) => invoke<string>("git_discard", { root, paths }),
  commit: (root: string, message: string, amend: boolean) =>
    invoke<string>("git_commit", { root, message, amend }),
  init: (root: string) => invoke<string>("git_init", { root }),
  branches: (root: string) => invoke<GitBranch[]>("git_branches", { root }),
  checkout: (root: string, branch: string, remote: boolean) =>
    invoke<string>("git_checkout", { root, branch, remote }),
  createBranch: (root: string, name: string, start?: string) =>
    invoke<string>("git_create_branch", { root, name, start: start ?? null }),
  /** `revision` null lists all branches. */
  log: (root: string, revision: string | null, skip: number, limit: number) =>
    invoke<GitCommit[]>("git_log", { root, revision, skip, limit }),
  commitDetails: (root: string, hash: string) => invoke<CommitDetails>("git_commit_details", { root, hash }),
  /** The file at `revision` (e.g. `abc123^`), or null if it did not exist there. */
  showAt: (root: string, revision: string, path: string) =>
    invoke<string | null>("git_show_at", { root, revision, path }),
  checkoutRevision: (root: string, hash: string) => invoke<string>("git_checkout_revision", { root, hash }),
  fetch: (root: string) => invoke<string>("git_fetch", { root }),
  pull: (root: string) => invoke<string>("git_pull", { root }),
  push: (root: string) => invoke<string>("git_push", { root }),
};

export interface SshHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: string | null;
}

export interface RemoteHosts {
  ssh: SshHost[];
  /** Installed WSL distributions (Windows only). */
  wsl: string[];
  /** Path of the user's ssh config file. */
  sshConfig: string;
}

export interface NewSshHost {
  alias: string;
  hostName: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export const remoteApi = {
  hosts: () => invoke<RemoteHosts>("remote_hosts"),
  /** Appends the host to ~/.ssh/config. */
  addSshHost: (host: NewSshHost) => invoke<void>("remote_add_ssh_host", { ...host }),
  /** The remote user's home folder, as a workspace path. */
  home: (kind: "ssh" | "wsl", target: string) => invoke<string>("remote_home", { kind, target }),
  /** Ends the SSH session with `host`. */
  disconnect: (host: string) => invoke<void>("remote_disconnect", { host }),
};
