# AGENTS.md

Guide for AI agents (Claude, Codex, Gemini, ...) working on this repository.
`CLAUDE.md` and `GEMINI.md` point here.

## Working with the maintainer

- **Reply in Portuguese** (Mozambican/European spelling: "actualizar", "projecto"),
  whatever language the request or the tool output is in.
- **Everything in the repository is in English**: code, comments, UI strings,
  commit messages, docs like this one. Only the chat is Portuguese.
- **"Avance" / "continue"** means: go on with the next planned step. Work in
  packages (one coherent feature or API area). Finish each one with the checks
  below, then report and stop.
- **Never commit, push or tag unless asked.** When asked: commit only the files of
  the change (leave unrelated or unknown files out and say so), push `main`, tag
  `vX.Y.Z`, push the tag. A tag push starts the release build (see Releases).
- **Bump the version after every significant change**, as part of the change (see
  Versioning). Small cosmetic fixes ride along with the next significant change.
- **Report honestly.** Say what was verified and how (type checks, build, tests,
  probes, headless browser) and what was *not* verified (e.g. "not tried in the
  app"). Never claim a UI works if you only type-checked it.
- Ask before decisions that are the maintainer's (product choices, external
  accounts, publishing). Otherwise pick sensible defaults, say which, and proceed.

## What PowerCode is

A lightweight desktop IDE: **Tauri 2 + Rust** backend, **React 19 + TypeScript +
Tailwind v4** UI, **Monaco** editor, IntelliJ "New UI" dark look. It runs **VS Code
extensions from Open VSX**, including their JavaScript, through its own extension
host (a bundled Node.js sidecar implementing the `vscode` API). Windows and Linux
are released; macOS builds but is not released. Package manager: **bun**.

## Layout

| Path | What |
|---|---|
| `src/` | The UI (React). |
| `src/components/` | Views and widgets: `EditorArea`, `ProjectView`, `CommitView`, `TerminalPanel`, `ExtensionsView`, `ChatView`, `TestingView`, `Menu`, ... |
| `src/editor/` | Monaco integration: `models.ts` (open files), `comments.tsx`, `contextMenu.tsx`, `externalChanges.ts`, themes, TextMate. |
| `src/exthost/` | UI side of the extension host: `host.ts` (lifecycle, handlers), `rpc.ts`, `languages.ts` (providers → Monaco), `webviews.ts`, `views.ts`, `remoteUris.ts`, one module per API area (`scm`, `testing`, `comments`, `chat`, `githubAuth`, `tasks`, `terminals`, ...). |
| `src/state/` | zustand stores: `workspace` (groups, tabs, tools), `trust`, `session`, `recentProjects`, `settings`, ... |
| `src/extensions/` | Installing extensions and their declarative parts (themes, grammars, snippets, icon themes). |
| `src/git`, `src/terminal`, `src/debug`, `src/search`, `src/settings` | Built-in features. |
| `ext-host/src/` | The extension host (Node). `api.ts` builds the `vscode` module; `types.ts` holds API classes; one module per area (`views`, `providers`, `debug`, `tasks`, `scm`, `testing`, `comments`, `chat`, `lm`, `authentication`, `virtual`, `tabs`, `terminals`, `files`, ...). |
| `ext-host/src/surface.ts` | Generated from `@types/vscode` (`bun run gen:vscode-surface`): every API member, so missing ones are filled with inert stand-ins and extensions still activate. |
| `ext-host/test/` | TypeScript tests (`bun run test`). |
| `src-tauri/src/` | Rust commands: `fs`, `git`, `terminal` (portable-pty), `search`, `extensions` (Open VSX), `exthost` (spawns the host), `remote` + `wsl` + `remote_exthost` (SSH/WSL), `secrets` (AES-GCM + OS keyring), `github_auth` (device flow), `webview` (webview protocol), `cli`, `system`. Unit tests live in each file (`#[cfg(test)]`). |
| `todo.md` | VS Code API gaps. Tick items you implement, note what is still missing. |
| `.github/workflows/release.yml` | Release build on tag push. |
| `.github/workflows/windows-build.yml` | Windows build on branch push, as artifacts only. |

### How the pieces talk

- **UI ↔ Rust:** Tauri commands (`invoke`). Commands doing I/O must be `async`
  (`#[tauri::command(async)]` or `async fn`) so they never block the UI thread.
- **UI ↔ extension host:** JSON lines prefixed `\u0001PC ` over stdio, with
  requests and notifications. Calls that are expensive or hold real objects (e.g.
  command arguments, `SourceControl`) run on the host side; the UI gets plain
  data. Values that JSON would mangle travel encoded (`$uri`, `$treeItem`, `$scm`,
  `$comment`, binary as `$pcBytes`).
- **Remote folders:** SSH (`ssh://host/path`) and WSL (`\\wsl.localhost\distro\...`).
  The extension host then runs *on the remote*. `src/exthost/remoteUris.ts`
  translates paths and URIs in known keys. Remote work goes through persistent
  shell sessions in batches (one command per tick, never one per file): WSL
  and SSH round trips are what made the app freeze in the past.
- **Webviews** are served from the `pcwebview` protocol; messages are wrapped in
  an envelope and re-posted by the page's bootstrap (`src/exthost/webviews.ts`).
- **Workspace Trust:** new folders start pending or restricted. Git, debugging
  and extensions without restricted-mode support stay off until trusted.

## Conventions

- Match the surrounding code: naming, idioms, comment density. Files start with a
  `//!` header saying what the module is for. Comments explain *why*, not what.
- UI text in English, short, sentence case, like VS Code / IntelliJ.
- Follow VS Code's behaviour for the `vscode` API: same defaults, events and
  errors. When PowerCode deviates on purpose, say so in a comment.
- Untrusted content is sanitized (markdown → `DOMPurify`). Secrets go to the
  encrypted secret storage, never to plain files. Ask the user for consent where VS Code does.
- Keep dependencies minimal. Prefer official Tauri plugins over hand-rolled
  WebView2 workarounds (for example, the clipboard uses `tauri-plugin-clipboard-manager`).
- Persist small UI preferences in `localStorage` (wrapped in try/catch); durable
  data goes through Rust.

## Checks before reporting a change

Run what applies, from the repository root:

```sh
bun x tsc --noEmit -p .          # UI types
bun x tsc -p ext-host            # extension host types
bun x tsc -p ext-host/test       # test types (bun:test)
bun run build:exthost            # bundle the host (src-tauri/resources/ext-host.cjs)
bun run test                     # TypeScript tests (ext-host/test)
bun run build                    # UI build (tsc + vite)
cd src-tauri && cargo test --lib # Rust tests; `-- --include-ignored` adds WSL/keyring ones
```

For `vscode` API work, also test the host end to end with a **probe**: a small
Node script that writes a test extension, spawns `src-tauri/resources/ext-host.cjs`,
plays the UI's side of the RPC (answering requests, sending notifications), and
prints what happened. Keep probes in your scratch space, not in the repo. Rerun
the earlier probes after changing shared code. Turn what is worth keeping into
`ext-host/test/` tests.

For **UI behaviour**, serve `dist/` and drive it with headless Edge
(`msedge --headless=new --dump-dom --virtual-time-budget=...`). Inject a stand-in
for `window.__TAURI_INTERNALS__` that answers the needed `invoke` commands, and
seed `localStorage` with the folder, trust and session. This found real bugs
that type checks could not.

## Versioning and releases

- The version lives in **four places**: `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`. Refresh the last one with
  `cargo update -p powercode --offline`.
- Bump the **patch** number. The maintainer moved from 0.1.8 to 0.1.81 and
  0.1.82, so continue from the current value (0.1.82 → 0.1.83). Versions compare
  numerically: 0.1.9 would be *older* than 0.1.81, so never go back to it.
- Tags are `vX.Y.Z`. Pushing one runs `release.yml`, which builds Windows (.exe,
  .msi) and Linux (.deb, .rpm, .AppImage) and attaches them to a **draft** release.
  The maintainer publishes it.
- Every push to a branch runs `windows-build.yml`: Windows installers only, kept
  as workflow artifacts for 14 days, never released. Markdown-only pushes skip it.
- Commit messages: `feat: ... (vX.Y.Z)` / `fix: ...` / `chore: ...`, with a short
  body listing the user-visible changes. Reference issues as `#N`; use "Fixes #N"
  only when the maintainer wants the issue closed. Agents add their own
  co-author trailer.

## Environment gotchas (Windows dev machine)

- The shell is Git Bash on Windows (PowerShell is available too). Inline scripts
  and heredocs **mangle backslashes, quotes and `$`**. For multi-line or
  path-heavy edits, use the editor tool, or write a small Python script and run
  it with `python -I`.
- Some files use **CRLF** (e.g. `src-tauri/src/lib.rs`). Preserve line endings
  when editing them programmatically (`newline=""` in Python).
- A WSL distribution is installed. Use it for WSL tests:
  `cargo test -- --include-ignored`.
- `gh` is authenticated for `mozinova/PowerCode`; use it for issues, runs and releases.
- Do not run the installed PowerCode or `tauri dev` on the maintainer's desktop
  without asking. The app is single-instance, and a dev run hands over to the
  running app.

## Where things stand

`todo.md` lists the `vscode` APIs still missing, among them notebooks,
`registerUriHandler`, file decorations, MCP servers, and the
`microsoft` / GitHub Enterprise sign-in. Check it before starting API work, and
update it after.
