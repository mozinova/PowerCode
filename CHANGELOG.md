# Changelog

All notable changes to PowerCode, newest first. One section per released tag,
taken from the Git history.

**About the version numbers:** the tags are numeric and compare numerically, so
`0.1.9` is *older* than `0.1.81`. There is no `v0.1.6` and no `v0.1.80` — the
numbering jumped (`0.1.5` → `0.1.7`, `0.1.8` → `0.1.81`). Tags with a suffix
(e.g. `v0.1.90-beta`) are pre-releases.

## [v0.1.94] - 2026-11-21

- Antigravity (`agy`) is a fourth AI assistant: found on PATH or where
  Antigravity installs it, its models from `agy models`, the prompt sent as
  stream-json on stdin, conversations continued. Agent mode accepts edits and
  allows commands; Ask plans and refuses commands, but Antigravity has no
  read-only mode and may still write files (the Ask switch says so).
- AI tool window:
  - Up/Down go through the prompts sent, as in a terminal.
  - Right-click on a message: copy it, the answer, the selection or the whole
    conversation; edit a prompt in the input or send it again.
  - Prompts sent while an answer is coming wait in a queue and go one by one.
  - Attach files from the computer, or paste images: text files go inline,
    images and other files by path (Claude `--add-dir`, Codex `--image`,
    OpenCode `--file`, Antigravity `--add-dir`).
  - Tools show what they returned; a click opens the whole input and output in
    a read-only editor tab.
- Antigravity and Gemini icons in the model picker and the settings.

## [v0.1.93] - 2026-11-20

- OpenCode gets `--dir` and `PWD`, so it no longer works in the folder PowerCode started from
- Tool detail shows the input's whole path; context usage uses the step's total tokens
- A commit message model of another program falls back to the default; switching the chat's program clears it when commit messages follow the chat
- Real-program test can pick one program (AI_ONLY) and models (AI_<PROGRAM>_MODEL)

## [v0.1.92] - 2026-11-20

- AI tool window: runs the AI assistant installed on the computer (Claude Code,
  Codex or OpenCode, found on PATH, in the usual install folders or bundled in
  their extensions) without its terminal interface. Ask (read-only) or Agent
  mode (edits files and runs commands), one model picker for all programs with
  search, @ file mentions, /model /clear /ask /agent commands, a context window
  ring, conversation shared when switching programs, and saved history per
  project.
- Commit view: writes the commit message from the diff with the chosen
  assistant; the message box takes several lines.
- Settings › AI: assistant and model for the AI window and for commit
  messages, and the programs' paths.
- Terminal: URLs and file paths (with line and column) open with Ctrl+Click.
- Completion no longer breaks when an extension contributes snippets without
  a language (e.g. Astro), which hid every suggestion, TypeScript's included.
- The built-in npm extension activates (terminal quick fix provider stub).
- Debug builds run next to the installed app instead of handing over to it.

## [v0.1.91] - 2026-11-20

- The macOS app is signed ad hoc: Apple Silicon Macs no longer say the
  downloaded app "is damaged"; it opens from System Settings > Privacy &
  Security > Open Anyway (not notarized yet).
- README: a screenshot, and the macOS first-launch steps.

## [v0.1.90-beta] - 2026-11-20 (pre-release)

- README for the public repository and the MIT license; package metadata
  (description, author, license) filled in.
- Tags also build macOS (.dmg for Apple Silicon, and Intel cross-compiled on
  the Apple Silicon runner); not signed yet.
- A tag with a suffix (v1.2.0-beta) makes a pre-release.

## [v0.1.90] - 2026-11-20

- The GitHub token lookup through Git's credential helper never runs an
  askpass program (GIT_ASKPASS, core.askPass, SSH_ASKPASS): without a stored
  credential it fails quietly (#5).
- Tab and Project view changes still on their save delay are written when the
  window closes, reloads or loses focus, and before another folder opens, so
  reopening the folder shows the tabs as they were left (#6).

## [v0.1.89] - 2026-11-20

- Saving checks the file is still as it was read (#2): when an AI agent, git
  or another editor changed it, nothing is written and the user chooses
  Compare (disk next to the edits), Overwrite or Revert. Auto save asks once
  per outside change.
- Outside changes are detected with auto save off too, and when the window
  gets focus (#3); a file with unsaved edits asks instead of being skipped.
- File watchers on Linux (WSL, SSH) watch each folder once, outside
  node_modules packages and .git: the TypeScript server no longer exhausts the
  inotify limit or stalls the extension host, so language servers' completions
  work in WSL projects again.
- Stand-ins for proposed APIs the GitHub extension calls
  (registerCanonicalUriProvider, registerShareProvider).
- PowerCode's menu no longer takes over text fields; the tests are type-checked.

## [v0.1.88] - 2026-11-20

- Monaco's TypeScript, CSS and HTML modes read their settings once, so turning
  them off when an extension registered did nothing and their errors ("Cannot
  find module" on every import) came back. Now their diagnostics are turned off
  at once, and languages an extension serves start without the built-in
  service from the next session on; uninstalling the extension brings it back.
- Reload Window reopens the window's own folder (kept per window), not the one
  another window opened last.

## [v0.1.87] - 2026-11-20

- On startup, the extensions listed in vscode-builtins.json that are missing
  are installed from Open VSX in the background (three at a time), with one
  progress notification and a summary.
- Each is installed once: one the user uninstalls is not brought back. One
  not found on Open VSX is not asked for again; network errors retry on the
  next start.
- Left out: vscode.git, vscode.git-base and vscode.github-authentication
  (PowerCode provides them), vscode.microsoft-authentication (needs
  registerUriHandler) and vscode.tunnel-forwarding (needs VS Code's tunnel CLI).
- The extension host restarts once after a batch of installs, not after each.

## [v0.1.86] - 2026-11-20

- Extensions' semantic tokens are drawn over the TextMate colouring, styled by
  the theme's semanticTokenColors or the TextMate scope of each token type.
- Hierarchy tool window: Show Call Hierarchy (Shift+Alt+H) and Show Type
  Hierarchy, from the language's extension.
- While paused: inline values at the end of lines, and the debug hover
  evaluates the expression the extension points to.
- Drop and paste edit providers (e.g. a Markdown link for a dropped image);
  files can be dragged from the Project view into an editor.
- Document selectors match scheme and pattern as in VS Code: a workflow-only
  YAML server no longer reports errors in every file.
- Command arguments JSON cannot carry stay in the extension host: TypeScript
  completions work again.
- Monaco's built-in TypeScript, JSON, CSS and HTML services give way to an
  extension serving the same language.
- The main menu shows the app version.
- Also in this release: remote signatures handling and folder listing stability
  fixed; long branch lists scroll in the Git menu and Git log; README and
  workflow updates.

## [v0.1.85] - 2026-11-19

- Right-clicking PowerCode on the Windows taskbar or Start menu shows
  "New Window" and the recent projects; clicking one opens it.
- The process uses the installer shortcut's AppUserModelID, so the window,
  the pinned icon and the jump list belong together.
- The window title is "<project> - PowerCode" (with the remote, e.g.
  "[WSL: Ubuntu]"), as seen on the taskbar and in Alt+Tab.
- `powercode ssh://host/path` opens a folder on an SSH host.

## [v0.1.84] - 2026-11-19

- "New Window" (main menu, project selector, command palette) starts another
  PowerCode window, empty. Each window is its own process, with its own
  extension host, terminals and remote sessions.
- `powercode -n` / `--new-window` opens a new window from the command line.
- `powercode <folder>` opens the folder in the running window when it has none,
  in a new window when another folder is open; files still open in the running window.

## [v0.1.83] - 2026-11-19

- The `vscode.git` extension's API (`getAPI(1)`) is built into the extension host,
  running git where the repository is: repositories, HEAD/upstream, remotes, refs,
  changes, `git:` documents, log/show/config and the usual commands. Also
  `vscode.git-base`. Off in untrusted folders. GitHub Actions, GitHub Pull Requests
  and vscode.github find their repository again.
- Installing an extension also installs its `extensionDependencies` and
  `extensionPack`. An extension whose dependency is missing does not activate; it
  says so and offers to install it, and at startup missing dependencies are offered.
- `TextEditor.visibleRanges` reflects the editor and
  `onDidChangeTextEditorVisibleRanges` fires on scroll (the Markdown preview failed
  on an empty list).
- AGENTS.md: guide for AI agents working on the repository; CLAUDE.md and
  GEMINI.md point to it.

## [v0.1.82] - 2026-11-19

- Terminal: Ctrl+Shift+C/V, Ctrl+Insert/Shift+Insert, and on Windows Ctrl+C with
  a selection and Ctrl+V; pasting is bracketed. Right-click menu: Copy, Paste,
  Select All, Clear Terminal, New Terminal, Kill Terminal.
- Editor: PowerCode's own right-click menu (Monaco's does not show in the app's
  webview): navigation, rename, format, cut/copy/paste, extensions'
  `editor/context` items and the command palette.
- Clipboard through tauri-plugin-clipboard-manager (reading it from the webview
  is unreliable in WebView2).

## [v0.1.81] - 2026-11-19

- With auto save on, open files and the Project view's expanded folders are
  checked every `files.autoSaveDelay` (one batched stat; remote paths in one
  command per host): files changed outside the app (AI agents, git) reload when
  they have no unsaved edits, changed folders are listed again, Git refreshes.
- Webview messages keep binary data (ArrayBuffer, typed arrays, views with an
  offset) through the JSON RPC in both directions, which broke Codex's webview (#1).
  First TypeScript tests: `bun run test`.
- Extension install progress is a ring with the percentage.
- The open editors menu scrolls its list of tabs.

## [v0.1.8] - 2026-11-19

- Adds a built-in `github` authentication provider, as VS Code ships one:
  browser sign-in with PowerCode's OAuth App (device flow), or the GitHub CLI
  token, Git Credential Manager's stored credential, or a personal access token.
  Tokens are checked against the GitHub API (owner and scopes) and kept in the
  encrypted secret storage on the local machine, also for remote hosts.
- A silent `getSession` for a provider that does not exist now returns no
  session instead of throwing, so extensions such as GitHub Actions activate
  signed out instead of failing (their sign-in commands then exist).

## [v0.1.7] - 2026-11-19

- `tests.createTestController`: Testing tool window (shown once an extension has
  tests) with discovery, run/debug per test or all, results, failure messages and
  a "Test Results" output channel.
- `comments.createCommentController`: threads under their lines in the editor, a
  reply box with the extension's buttons, and a gutter "+" on commenting ranges.
- `lm.*`: language model providers, `selectChatModels`/`sendRequest` (consent once
  per extension), `countTokens`, tools with their confirmation, MCP definitions
  accepted.
- `chat.createChatParticipant`: Chat tool window (right sidebar, Ctrl+Alt+I) with
  `@participant`, `/command`, model picker, streamed answers, buttons, references,
  follow-ups, history and cancel.
- Extensions view: the Installed, Disabled and Popular/Results lists collapse.

## [v0.1.5] - 2026-11-19

- Implements `scm.createSourceControl` and `scm.inputBox`. Each provider shows in
  the Commit tool window under the built-in Git: input box (Ctrl+Enter accepts),
  accept button, `scm/title` actions, resource groups with decorations, and the
  `scm/resourceGroup/context` and `scm/resourceState/context` menus. Commands run
  in the extension host with their original arguments.
- Also shows the `navigation` group of `editor/title` as toolbar icons, as VS Code does.

## [v0.1.4] - 2026-11-19

- The project name in the toolbar opens a menu with the last 5 folders opened
  (local, WSL and SSH) and "Browse…" at the end, instead of the folder dialog.
  Folders that no longer exist leave the list when picked.
- Keeps the extension install progress label on one line in narrow rows.

## [v0.1.3] - 2026-11-19

- Add state restore to the editor.
- Version bump to 0.1.3.

## [v0.1.2] - 2026-11-18

- Extension enable/disable and download size estimation.
- Secret storage and account management.
- Task management with support for tasks.json and extension providers.
- Terminal management and integration with extensions.
- Workspace symbol search and inline completion.
- File operations and save participants for extensions.
- Virtual document handling and tab management; diagnostics track unimplemented
  API members.
- Workspace Trust, similar to VS Code.
- WSL support for file operations and git commands; webview messaging and error
  logging improvements.
- Git status optimised; ignored files handling updated.
- Release workflow simplified (macOS removed at this point).

## [v0.1.1] - 2026-11-18

- GitHub Actions workflow for automated releases on tag push.

## [v0.1.0] - 2026-11-18

First release: the initial codebase, including:

- VSIX extraction and download from Open VSX, with error handling.
- Extension host communication and state management; async commands for
  extensions, terminal profiles, TextMate tokenisation.
- Remote extension host support for SSH and WSL.
- Debugging: breakpoints, launch configurations, session management.
- Command palette, auto-save, settings page and user settings.
- Terminal with background support; layout and "Islands" theme for tool windows.
- Git integration (progress handling, lock file removal).
- Command line integration and shell command support; 64x64 PNG icon.
