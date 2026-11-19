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

- [ ] `registerDocumentSemanticTokensProvider` / `registerDocumentRangeSemanticTokensProvider`
      — *stub*. Clash with the TextMate colouring, which already uses Monaco's semantic
      tokens; needs merging the two token sources.
- [ ] `registerCallHierarchyProvider` — *stub* (Call Hierarchy view).
- [ ] `registerTypeHierarchyProvider` — *stub* (Type Hierarchy view).
- [ ] `registerEvaluatableExpressionProvider` — *stub* (debug hover on expressions).
- [ ] `registerInlineValuesProvider` — *stub* (variable values inline while debugging).
- [ ] `registerDocumentDropEditProvider` / `registerDocumentPasteEditProvider` — *stub*.

## Tasks

- [ ] Problem matchers: task output does not become diagnostics, and background tasks
      (watchers) used as `preLaunchTask` do not wait for their "ready" pattern.
- [ ] `terminal.integrated.automationProfile.*`: tasks always use PowerShell on Windows
      and `$SHELL` elsewhere, unless `options.shell` says otherwise.

## Authentication

- [ ] Built-in `github` and `microsoft` providers (VS Code ships them as built-in
      extensions; most sign-ins use them). Options: a `github` provider using
      `gh auth token` / Git Credential Manager / a personal access token, or an OAuth
      app owned by PowerCode (device flow).
- [ ] "Sign in requested" badge: `getSession` without `createIfNone` for an account the
      extension may not use returns `undefined` with no way to grant access later.

## Source control, testing, comments

- [x] `scm.createSourceControl` (and `inputBox`) — shown in the Commit tool window under
      the built-in Git. Missing: `quickDiffProvider` (gutter), `inputBox.validateInput`
      messages in the UI, `statusBarCommands` in the status bar, `scm/inputBox` menu.
      Extensions built on the `vscode.git` extension's API (GitLens) still need that
      built-in extension.
- [ ] `tests.createTestController` — not implemented (Testing view).
- [ ] `comments.createCommentController` — not implemented (review comments, e.g.
      GitHub Pull Requests).

## AI and chat

- [ ] `chat.createChatParticipant` — not implemented.
- [ ] `lm.*` — not implemented: `selectChatModels`, `registerLanguageModelChatProvider`,
      `registerTool`, `invokeTool`, `tools`, `onDidChangeChatModels`,
      `registerMcpServerDefinitionProvider`.

## Notebooks

- [ ] The `notebooks` namespace and notebook documents/editors (`workspace.notebookDocuments`,
      `window.activeNotebookEditor`, serializers, controllers, renderers) — not implemented.

## Env

- [ ] `env.createTelemetryLogger` — *stub*.
- [ ] `env.isAppPortable` — not implemented.
