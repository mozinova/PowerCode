# TODO: missing VS Code APIs

What the extension host (`ext-host/`) still lacks. Members marked *stub* exist so
extensions activate, but do nothing (they log "not supported yet" when used).
To re-check: run the API gaps probe, which reads `globalThis.__powercodeUnimplemented`
and the surface generated from `@types/vscode` (`bun run gen:vscode-surface`).

## Window

- [ ] `window.registerUriHandler` — *stub*. Needs the `powercode://` protocol registered
      with the OS (deep links back from OAuth sign-ins; used by Claude Code, Prisma, Go).
- [ ] `window.registerFileDecorationProvider` — *stub*. Badges and colours in the Project
      view and tabs (git status from extensions, errors per file).
- [ ] `window.registerTerminalLinkProvider` — *stub*. Clickable links in terminal output.
- [ ] `window.registerTerminalProfileProvider` — *stub*. Terminal profiles from extensions.
- [ ] `window.registerWebviewPanelSerializer` — *stub*. Restoring webview panels when the
      window reopens.
- [ ] Terminal shell integration — not implemented: `Terminal.shellIntegration`,
      `onDidChangeTerminalShellIntegration`, `onDidStartTerminalShellExecution`,
      `onDidEndTerminalShellExecution`.
- [ ] `window.onDidChangeTextEditorViewColumn` — never fires.
- [ ] `window.withScmProgress` — not implemented.

## Workspace

- [ ] `workspace.updateWorkspaceFolders` — *stub*: PowerCode opens one folder at a time
      (multi-root workspaces).
- [ ] `workspace.decode` / `workspace.encode` — not implemented (text encodings).
- [ ] `workspace.registerTimelineProvider` — not implemented (Timeline view).

## Languages

- [x] `registerDocumentSemanticTokensProvider` / `registerDocumentRangeSemanticTokensProvider`
      — merged over the TextMate colouring (`src/editor/semanticTokens.ts`), styled by the
      theme's `semanticTokenColors` or the TextMate scope of the type. Not yet: delta
      results (`provideDocumentSemanticTokensEdits`; the full result is asked instead) and
      range requests for the visible part only (range providers are asked for the whole file).
- [x] `registerCallHierarchyProvider` / `registerTypeHierarchyProvider` — Hierarchy tool
      window (Show Call Hierarchy, Shift+Alt+H; Show Type Hierarchy).
- [x] `registerEvaluatableExpressionProvider` — decides what the debug hover evaluates.
- [x] `registerInlineValuesProvider` — values at the end of lines while paused.
- [x] `registerDocumentDropEditProvider` / `registerDocumentPasteEditProvider` — through
      Monaco's drop and paste controllers (`src/editor/monacoInternals.ts`). Not yet: the
      "Paste As…" / "Drop As…" choice widget's commands in PowerCode's menus.

## Tasks

- [ ] Problem matchers: task output does not become diagnostics, and background tasks
      (watchers) used as `preLaunchTask` do not wait for their "ready" pattern.
- [ ] `terminal.integrated.automationProfile.*`: tasks always use PowerShell on Windows
      and `$SHELL` elsewhere, unless `options.shell` says otherwise.

## Authentication

- [x] Built-in `github` provider: browser sign-in (device flow, PowerCode's OAuth App),
      GitHub CLI token, Git Credential Manager, or a personal access token; tokens in the
      encrypted secret storage, scopes checked against the API. A silent `getSession` for a
      provider that does not exist now returns `undefined` instead of failing activation.
- [ ] `github-enterprise` provider (same flow, needs an OAuth App on each server, or a token).
- [ ] Built-in `microsoft` provider (MSAL / Azure sign-in).
- [ ] "Sign in requested" badge: `getSession` without `createIfNone` for an account the
      extension may not use returns `undefined` with no way to grant access later.

## Source control, testing, comments

- [x] The `vscode.git` extension's API (`getAPI(1)`), built into the extension host:
      repositories, HEAD/upstream, remotes, refs, index/working tree/merge changes, `git:`
      documents, log/show/config, add/commit/checkout/branch/fetch/pull/push and more;
      `vscode.git-base` too. Missing: stash, rebase state, submodules, remote source
      pickers, credential/push-error providers (accepted, not used).
- [x] `scm.createSourceControl` (and `inputBox`) — shown in the Commit tool window under
      the built-in Git. Missing: `quickDiffProvider` (gutter), `inputBox.validateInput`
      messages in the UI, `statusBarCommands` in the status bar, `scm/inputBox` menu.
- [x] `tests.createTestController` — Testing tool window (shown once an extension has
      tests): discovery, run/debug per test or all, results, failure messages, output in
      "Test Results". Missing: coverage, continuous runs, test gutter icons in the editor,
      tags, `TestRunRequest.exclude` from the UI.
- [x] `comments.createCommentController` — threads under their lines in the editor, reply
      box with the extension's `comments/commentThread/context` buttons, gutter "+" on
      commenting ranges. Missing: reactions, editing a comment in place (`CommentMode.Editing`),
      a Comments panel listing every thread, file-level comments.

## AI and chat

- [x] `chat.createChatParticipant` — Chat tool window (right sidebar, Ctrl+Alt+I, shown
      once an extension declares a participant): `@participant`, `/command`, model picker,
      streamed markdown, progress, buttons, references, file trees, follow-ups, history,
      cancel. Missing: `#file` / selection references in requests, tool calling by the
      chat itself (agent mode), inline chat in the editor, feedback (👍/👎), saved sessions.
- [x] `lm.*` — `registerLanguageModelChatProvider`, `selectChatModels`, `sendRequest`
      (consent once per extension), `countTokens`, `onDidChangeChatModels`, `registerTool`,
      `invokeTool` (with the tool's confirmation), `tools`.
- [ ] `lm.registerMcpServerDefinitionProvider` — accepted, but PowerCode does not start
      MCP servers or offer their tools yet.
- [ ] A built-in language model provider (the user's Anthropic/OpenAI key, or Ollama):
      without an extension providing models, participants have nothing to answer with.

## Notebooks

- [ ] The `notebooks` namespace and notebook documents/editors (`workspace.notebookDocuments`,
      `window.activeNotebookEditor`, serializers, controllers, renderers) — not implemented.

## Env

- [ ] `env.createTelemetryLogger` — *stub*.
- [ ] `env.isAppPortable` — not implemented.
