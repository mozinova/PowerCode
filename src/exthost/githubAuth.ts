//! PowerCode's built-in `github` authentication provider, for extensions that sign
//! in to GitHub (GitHub Actions, Pull Requests, GitLens, ...). The extension host
//! forwards the provider's calls here (ext-host/src/authentication.ts); tokens are
//! kept in the encrypted secret storage, on this machine even for remote hosts.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import * as rpc from "./rpc";

export interface GitHubSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  /** The scopes extensions asked for (what VS Code reports as the session's scopes). */
  scopes: string[];
  /** What the token really grants; empty for fine-grained tokens (they have permissions). */
  granted: string[];
}

export interface GitHubUser {
  id: number;
  login: string;
  name?: string;
  scopes: string[];
}

const STORAGE_KEY = "powercode/github.sessions";

async function load(): Promise<GitHubSession[]> {
  const text = await invoke<string | null>("secrets_get", { key: STORAGE_KEY }).catch(() => null);
  try {
    return text ? (JSON.parse(text) as GitHubSession[]) : [];
  } catch {
    return [];
  }
}

async function save(sessions: GitHubSession[]) {
  await invoke("secrets_set", { key: STORAGE_KEY, value: JSON.stringify(sessions) });
  if (rpc.isRunning()) rpc.notify("githubAuth/changed", {});
}

/** Scopes that include others (`repo` grants `public_repo`, `admin:org` grants `read:org`, ...). */
const IMPLIED: Record<string, string[]> = {
  repo: ["repo:status", "repo_deployment", "public_repo", "repo:invite", "security_events"],
  "admin:org": ["write:org", "read:org"],
  "write:org": ["read:org"],
  "admin:public_key": ["write:public_key", "read:public_key"],
  "write:public_key": ["read:public_key"],
  "admin:repo_hook": ["write:repo_hook", "read:repo_hook"],
  "write:repo_hook": ["read:repo_hook"],
  "admin:gpg_key": ["write:gpg_key", "read:gpg_key"],
  "write:gpg_key": ["read:gpg_key"],
  user: ["read:user", "user:email", "user:follow"],
  "write:packages": ["read:packages"],
  project: ["read:project"],
};

/** The requested scopes the granted ones do not cover. */
export function missingScopes(granted: string[], requested: readonly string[]): string[] {
  // Fine-grained tokens report no scopes: what they may do is not known here.
  if (granted.length === 0) return [];
  const all = new Set(granted.flatMap((s) => [s, ...(IMPLIED[s] ?? [])]));
  return requested.filter((s) => !all.has(s));
}

// ---- Sign-in dialog ----------------------------------------------------------------

interface SignInRequest {
  scopes: string[];
  resolve: (result: { token: string; user: GitHubUser }) => void;
  reject: (error: Error) => void;
}

export const useGitHubSignIn = create<{ request: SignInRequest | null }>(() => ({ request: null }));

/** Asks the user to sign in (browser, GitHub CLI, Git, or a token); resolves with a checked token. */
function askToSignIn(scopes: string[]): Promise<{ token: string; user: GitHubUser }> {
  useGitHubSignIn.getState().request?.reject(new Error("Another sign-in started."));
  return new Promise((resolve, reject) => useGitHubSignIn.setState({ request: { scopes, resolve, reject } }));
}

export function finishSignIn(result: { token: string; user: GitHubUser } | null) {
  const request = useGitHubSignIn.getState().request;
  useGitHubSignIn.setState({ request: null });
  if (result) request?.resolve(result);
  else request?.reject(new Error("User did not consent to login."));
}

export const githubApi = {
  deviceStart: (scopes: string[]) =>
    invoke<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }>("github_device_start", { scopes }),
  deviceCheck: (deviceCode: string) =>
    invoke<{ status: "pending"; interval?: number } | { status: "done"; token: string }>("github_device_check", { deviceCode }),
  user: (token: string) => invoke<GitHubUser>("github_user", { token }),
  cliToken: () => invoke<string>("github_cli_token"),
  gitCredential: () => invoke<string>("github_git_credential"),
};

// ---- Provider (called by the extension host) ----------------------------------------------

async function getSessions(scopes?: string[]) {
  const sessions = await load();
  return scopes ? sessions.filter((s) => missingScopes(s.granted, scopes).length === 0) : sessions;
}

async function createSession(scopes: string[]): Promise<GitHubSession> {
  const sessions = await load();
  // The browser sign-in asks for everything already granted too, so one token serves all.
  const wanted = [...new Set([...sessions.flatMap((s) => s.scopes), ...scopes])].sort();
  const { token, user } = await askToSignIn(wanted);
  const previous = sessions.find((s) => s.account.id === String(user.id));
  const session: GitHubSession = {
    id: previous?.id ?? crypto.randomUUID(),
    accessToken: token,
    account: { id: String(user.id), label: user.login },
    scopes: [...new Set([...(previous?.scopes ?? []), ...scopes])],
    granted: user.scopes,
  };
  await save([...sessions.filter((s) => s.id !== session.id), session]);
  return session;
}

async function removeSession(id: string) {
  const sessions = await load();
  await save(sessions.filter((s) => s.id !== id));
  return null;
}

/** What extensions see of a session (the granted scopes stay here). */
const toApi = ({ granted: _granted, ...session }: GitHubSession) => session;

export function registerGitHubAuthHandlers() {
  rpc.onRequest("githubAuth/getSessions", async ({ scopes }) => (await getSessions(scopes ?? undefined)).map(toApi));
  rpc.onRequest("githubAuth/createSession", async ({ scopes }) => toApi(await createSession(scopes ?? [])));
  rpc.onRequest("githubAuth/removeSession", ({ id }) => removeSession(id));
}
