//! The GitHub sign-in an extension asked for: in the browser with a one-time code
//! (PowerCode's OAuth App), or with a token the machine already has (GitHub CLI,
//! Git Credential Manager), or a pasted personal access token.

import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, KeyRound, Loader2, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { finishSignIn, githubApi, missingScopes, useGitHubSignIn, type GitHubUser } from "../exthost/githubAuth";
import { errorMessage } from "../lib/ipc";

type Step =
  | { kind: "choose" }
  | { kind: "device"; userCode: string; verificationUri: string; copied: boolean }
  | { kind: "token" }
  | { kind: "checking"; what: string };

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-7 shrink-0 fill-current" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GitHubSignIn() {
  const request = useGitHubSignIn((s) => s.request);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  /** Bumped to stop a device sign-in that is waiting (cancel, or another way chosen). */
  const attempt = useRef(0);

  useEffect(() => {
    setStep({ kind: "choose" });
    setError(null);
    setToken("");
    attempt.current++;
  }, [request]);

  if (!request) return null;
  const scopes = request.scopes;

  const cancel = () => {
    attempt.current++;
    finishSignIn(null);
  };

  /** Checks a token with GitHub (owner, scopes) and signs in with it. */
  const signInWithToken = async (value: string, what: string) => {
    setError(null);
    setStep({ kind: "checking", what });
    try {
      const user: GitHubUser = await githubApi.user(value);
      const missing = missingScopes(user.scopes, scopes);
      if (missing.length > 0) {
        throw new Error(`This token lacks the access the extension needs: ${missing.join(", ")}. Sign in with the browser, or use a token with these scopes.`);
      }
      finishSignIn({ token: value.trim(), user });
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "choose" });
    }
  };

  const fromSource = async (load: () => Promise<string>, what: string) => {
    setError(null);
    setStep({ kind: "checking", what });
    try {
      await signInWithToken(await load(), what);
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "choose" });
    }
  };

  const signInWithBrowser = async () => {
    const mine = ++attempt.current;
    setError(null);
    setStep({ kind: "checking", what: "Contacting GitHub…" });
    try {
      const code = await githubApi.deviceStart(scopes);
      if (mine !== attempt.current) return;
      setStep({ kind: "device", userCode: code.userCode, verificationUri: code.verificationUri, copied: false });
      let interval = code.interval;
      const deadline = Date.now() + code.expiresIn * 1000;
      while (mine === attempt.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (mine !== attempt.current) return;
        const check = await githubApi.deviceCheck(code.deviceCode);
        if (check.status === "done") {
          if (mine === attempt.current) await signInWithToken(check.token, "Signing in…");
          return;
        }
        if (check.interval) interval = check.interval;
      }
      if (mine === attempt.current) throw new Error("The code expired. Sign in again.");
    } catch (e) {
      if (mine !== attempt.current) return;
      setError(errorMessage(e));
      setStep({ kind: "choose" });
    }
  };

  const copyAndOpen = async (userCode: string, uri: string) => {
    await navigator.clipboard.writeText(userCode).catch(() => {});
    setStep((s) => (s.kind === "device" ? { ...s, copied: true } : s));
    await openUrl(uri);
  };

  return (
    <div className="fixed inset-0 z-[960] flex items-start justify-center bg-black/40 pt-[14vh]">
      <div role="dialog" aria-label="Sign in to GitHub" className="w-[480px] rounded-lg border border-line-soft bg-panel p-5 shadow-2xl shadow-black/50">
        <div className="flex items-start gap-3">
          <GitHubMark />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Sign in to GitHub</h2>
            <p className="mt-1 text-xs text-fg-muted">Access requested: {scopes.length ? scopes.join(", ") : "your public profile"}</p>
          </div>
          <button type="button" aria-label="Cancel" onClick={cancel} className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg">
            <X size={14} />
          </button>
        </div>

        {error && <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}

        {step.kind === "choose" && (
          <div className="mt-4 flex flex-col gap-2">
            <button type="button" onClick={() => void signInWithBrowser()} className="h-9 rounded-md bg-accent font-medium text-white hover:bg-accent-hover">
              Sign in with your browser
            </button>
            <p className="mt-2 text-xs text-fg-subtle">Or use a token this computer already has:</p>
            <div className="flex flex-col gap-1">
              <button type="button" onClick={() => void fromSource(githubApi.cliToken, "Asking the GitHub CLI…")} className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
                <Terminal size={14} className="text-fg-muted" /> GitHub CLI account (gh)
              </button>
              <button type="button" onClick={() => void fromSource(githubApi.gitCredential, "Asking Git…")} className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
                <KeyRound size={14} className="text-fg-muted" /> Git's stored credential (Git Credential Manager)
              </button>
              <button type="button" onClick={() => setStep({ kind: "token" })} className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-hover">
                <KeyRound size={14} className="text-fg-muted" /> Personal access token…
              </button>
            </div>
          </div>
        )}

        {step.kind === "device" && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <p className="text-center text-[13px] text-fg-muted">Enter this code on GitHub to authorize PowerCode:</p>
            <div className="rounded-md bg-input px-4 py-2 font-code text-2xl tracking-[0.2em] select-all">{step.userCode}</div>
            <button
              type="button"
              onClick={() => void copyAndOpen(step.userCode, step.verificationUri)}
              className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-4 font-medium text-white hover:bg-accent-hover"
            >
              {step.copied ? <Check size={14} /> : <Copy size={14} />}
              {step.copied ? "Copied — open GitHub again" : "Copy code and open GitHub"}
            </button>
            <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <Loader2 size={12} className="animate-spin" /> Waiting for you to authorize on GitHub…
            </p>
            <button type="button" onClick={() => { attempt.current++; setStep({ kind: "choose" }); }} className="text-xs text-fg-muted hover:text-fg hover:underline">
              Use another way
            </button>
          </div>
        )}

        {step.kind === "token" && (
          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) void signInWithToken(token, "Checking the token…");
            }}
          >
            <p className="text-[13px] text-fg-muted">
              Create a token on GitHub (Settings → Developer settings → Personal access tokens) with: {scopes.join(", ") || "no scopes"}.
            </p>
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… or github_pat_…"
              spellCheck={false}
              autoComplete="off"
              className="h-8 rounded-md border border-input-border bg-input px-2 font-code text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep({ kind: "choose" })} className="h-8 rounded-md px-3 text-fg-muted hover:bg-hover">
                Back
              </button>
              <button type="submit" disabled={!token.trim()} className="h-8 rounded-md bg-accent px-4 font-medium text-white hover:bg-accent-hover disabled:opacity-50">
                Sign In
              </button>
            </div>
          </form>
        )}

        {step.kind === "checking" && (
          <p className="mt-4 flex items-center justify-center gap-2 text-[13px] text-fg-muted">
            <Loader2 size={14} className="animate-spin" /> {step.what}
          </p>
        )}
      </div>
    </div>
  );
}
