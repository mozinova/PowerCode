//! AI assistants installed on the computer (Claude Code, Codex, OpenCode), driven
//! through their command-line programs in non-interactive mode: no terminal UI,
//! the prompt goes in on stdin and the JSON lines they stream are turned into
//! a few plain events (text, tool use, session, done) for the AI tool window and
//! the commit message generator.
//!
//! The programs are found on PATH, in the usual install folders, or bundled in
//! the extensions that ship them (Claude Code's and Codex's VS Code extensions).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::error::{err, CmdResult};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Claude,
    Codex,
    OpenCode,
}

const KINDS: [Kind; 3] = [Kind::Claude, Kind::Codex, Kind::OpenCode];

impl Kind {
    fn parse(id: &str) -> CmdResult<Kind> {
        KINDS.into_iter().find(|k| k.id() == id).ok_or_else(|| format!("Unknown AI provider {id}"))
    }

    fn id(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
            Kind::OpenCode => "opencode",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Claude => "Claude Code",
            Kind::Codex => "Codex",
            Kind::OpenCode => "OpenCode",
        }
    }
}

// ---- Detection ---------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    id: String,
    name: String,
    path: String,
    version: Option<String>,
    /// Found inside an installed extension rather than installed on its own.
    bundled: bool,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// The user's PATH as stored in the registry: a program installed after PowerCode
/// started is on it, but not yet on this process's PATH.
#[cfg(windows)]
fn registry_path() -> Vec<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    let Ok(env) = winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") else { return vec![] };
    let Ok(raw) = env.get_value::<String, _>("Path") else { return vec![] };
    raw.split(';')
        .filter(|e| !e.is_empty())
        .map(|entry| {
            // `%USERPROFILE%\bin` and the like.
            let mut expanded = entry.to_string();
            while let Some(start) = expanded.find('%') {
                let Some(len) = expanded[start + 1..].find('%') else { break };
                let name = &expanded[start + 1..start + 1 + len];
                let value = std::env::var(name).unwrap_or_default();
                expanded.replace_range(start..start + len + 2, &value);
            }
            PathBuf::from(expanded)
        })
        .collect()
}

/// Folders to look in: PATH first, then where the installers put these programs.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    #[cfg(windows)]
    dirs.extend(registry_path());
    if let Some(home) = home() {
        for relative in [".local/bin", ".claude/local", ".bun/bin", ".opencode/bin", ".npm-global/bin", ".volta/bin", ".cargo/bin"] {
            dirs.push(home.join(relative));
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    #[cfg(not(windows))]
    {
        // A GUI app on macOS does not get the shell's PATH.
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    dirs
}

fn find_program(program: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    // npm installs `.cmd` shims on Windows.
    let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    dirs.iter()
        .flat_map(|dir| extensions.iter().map(move |ext| dir.join(format!("{program}{ext}"))))
        .find(|candidate| candidate.is_file())
}

/// The program inside an installed extension that ships it.
fn bundled(kind: Kind, extensions: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    match kind {
        Kind::Claude => Some(extensions.join("anthropic.claude-code/resources/native-binary").join(format!("claude{exe}"))).filter(|p| p.is_file()),
        // `bin/<platform>/codex`.
        Kind::Codex => std::fs::read_dir(extensions.join("openai.chatgpt/bin"))
            .ok()?
            .flatten()
            .map(|entry| entry.path().join(format!("codex{exe}")))
            .find(|p| p.is_file()),
        Kind::OpenCode => None,
    }
}

fn program_command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Runs `path args` and returns its stdout, giving up after `timeout`.
fn output_within(path: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = program_command(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = send.send(text);
    });
    match receive.recv_timeout(timeout) {
        Ok(text) => {
            let _ = child.wait();
            Some(text)
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

/// The version in `--version` output: "2.1.328 (Claude Code)", "codex-cli 0.170.0".
fn version_number(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| word.trim_start_matches('v').starts_with(|c: char| c.is_ascii_digit()))
        .map(|word| word.trim_start_matches('v').trim_end_matches([',', ')', '(']).to_string())
}

fn detect_one(kind: Kind, configured: Option<String>, dirs: &[PathBuf], extensions: Option<&Path>) -> Option<AiProvider> {
    let configured = configured.filter(|p| !p.trim().is_empty()).map(PathBuf::from).filter(|p| p.is_file());
    let (path, bundled_copy) = match configured.or_else(|| find_program(kind.id(), dirs)) {
        Some(path) => (path, false),
        None => (extensions.and_then(|e| bundled(kind, e))?, true),
    };
    let version = output_within(&path, &["--version"], Duration::from_secs(15)).and_then(|text| version_number(&text));
    Some(AiProvider {
        id: kind.id().into(),
        name: kind.name().into(),
        path: path.to_string_lossy().into_owned(),
        version,
        bundled: bundled_copy,
    })
}

/// The AI programs found; `paths` are the ones the user set (by provider id), which win.
#[tauri::command(async)]
pub fn ai_detect(app: AppHandle, paths: HashMap<String, String>) -> Vec<AiProvider> {
    let dirs = search_dirs();
    let extensions = app.path().app_data_dir().ok().map(|d| d.join("extensions"));
    std::thread::scope(|scope| {
        let handles: Vec<_> = KINDS
            .into_iter()
            .map(|kind| {
                let (dirs, extensions, configured) = (&dirs, extensions.as_deref(), paths.get(kind.id()).cloned());
                scope.spawn(move || detect_one(kind, configured, dirs, extensions))
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
}

// ---- Models ------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    /// Passed as `--model`; empty for the program's own default.
    id: String,
    name: String,
    description: Option<String>,
    /// Tokens the model can take in, when known before a run.
    context_window: Option<u64>,
}

fn model(id: &str, name: &str, description: Option<&str>) -> AiModel {
    AiModel { id: id.into(), name: name.into(), description: description.map(str::to_string), context_window: None }
}

/// Claude Code has no command listing models: its aliases (which follow the latest
/// models) and the current full names.
fn claude_models() -> Vec<AiModel> {
    vec![
        model("opus", "Opus", Some("Latest Opus (alias)")),
        model("sonnet", "Sonnet", Some("Latest Sonnet (alias)")),
        model("haiku", "Haiku", Some("Latest Haiku (alias): fast")),
        model("claude-fable-5-2", "Fable 5.2", None),
        model("claude-opus-5-5", "Opus 5.5", None),
        model("claude-sonnet-5-5", "Sonnet 5.5", None),
        model("claude-haiku-5-5", "Haiku 5.5", None),
    ]
}

/// Codex keeps the models of the signed-in account in `models_cache.json`.
fn codex_models(cache: &str) -> Vec<AiModel> {
    let Ok(json) = serde_json::from_str::<Value>(cache) else { return vec![] };
    let mut models: Vec<(i64, AiModel)> = json["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str().is_none_or(|v| v == "list"))
        .filter_map(|m| {
            let slug = m["slug"].as_str()?;
            let name = m["display_name"].as_str().unwrap_or(slug);
            // Codex keeps part of the window for itself (`effective_context_window_percent`).
            let window = m["context_window"].as_u64().map(|w| w * m["effective_context_window_percent"].as_u64().unwrap_or(100) / 100);
            Some((m["priority"].as_i64().unwrap_or(i64::MAX), AiModel { context_window: window, ..model(slug, name, m["description"].as_str()) }))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    models.into_iter().map(|(_, m)| m).collect()
}

/// `opencode models` prints one `provider/model` per line.
fn opencode_models(output: &str) -> Vec<AiModel> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains(char::is_whitespace) && l.contains('/'))
        .map(|l| model(l, l, None))
        .collect()
}

#[tauri::command(async)]
pub fn ai_models(provider: String, path: String) -> CmdResult<Vec<AiModel>> {
    let mut models = vec![model("", "Default", Some("The program's own default"))];
    models.extend(match Kind::parse(&provider)? {
        Kind::Claude => claude_models(),
        Kind::Codex => {
            let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".codex")));
            dir.and_then(|d| std::fs::read_to_string(d.join("models_cache.json")).ok()).map(|c| codex_models(&c)).unwrap_or_default()
        }
        Kind::OpenCode => output_within(Path::new(&path), &["models"], Duration::from_secs(30)).map(|o| opencode_models(&o)).unwrap_or_default(),
    });
    Ok(models)
}

// ---- Running -----------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    provider: String,
    path: String,
    /// Empty or absent: the program's default.
    model: Option<String>,
    prompt: String,
    cwd: String,
    /// May edit files (and, for Codex, run commands in its sandbox); otherwise read-only.
    agent: bool,
    /// Continues this conversation of the program.
    session: Option<String>,
    /// A one-off answer: no tools, nothing saved (commit messages).
    one_shot: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    /// The program's conversation id, to continue it.
    Session { id: String },
    /// Answer text; `start` begins a new paragraph block instead of extending the last.
    Text { text: String, start: bool },
    /// The assistant used a tool (read a file, ran a command, edited ...).
    Tool { title: String, detail: Option<String> },
    /// Something the user should know, e.g. a change refused in Ask mode.
    Notice { text: String },
    /// How full the conversation's context is: tokens in it, and the model's window when the program says.
    Usage { used: u64, window: Option<u64> },
    Done { error: Option<String> },
}

fn arguments(kind: Kind, request: &AiRequest) -> Vec<String> {
    let model = request.model.as_deref().filter(|m| !m.is_empty());
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    match kind {
        Kind::Claude => {
            push(&["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
            if let Some(model) = model {
                push(&["--model", model]);
            }
            if request.one_shot {
                push(&["--tools", "", "--no-session-persistence"]);
            } else if request.agent {
                // Edits, and shell commands (Bash, or PowerShell where Claude Code has it on
                // Windows): print mode cannot ask, so Agent allows them up front.
                push(&["--permission-mode", "acceptEdits", "--allowedTools", "Bash,PowerShell"]);
            }
            if let Some(session) = &request.session {
                push(&["--resume", session]);
            }
        }
        Kind::Codex => {
            // `-c sandbox_mode`: `exec resume` takes no `--sandbox`.
            let sandbox = if request.agent && !request.one_shot { "workspace-write" } else { "read-only" };
            push(&["exec", "-c", &format!("sandbox_mode=\"{sandbox}\""), "--skip-git-repo-check"]);
            if let Some(session) = &request.session {
                push(&["resume", session]);
            }
            push(&["--json"]);
            if request.one_shot {
                push(&["--ephemeral"]);
            }
            if let Some(model) = model {
                push(&["-m", model]);
            }
            // The prompt comes on stdin.
            push(&["-"]);
        }
        Kind::OpenCode => {
            // `--dir`: OpenCode takes its folder from `PWD` before the process's own.
            push(&["run", "--format", "json", "--dir", &request.cwd, "--agent", if request.agent && !request.one_shot { "build" } else { "plan" }]);
            if let Some(model) = model {
                push(&["-m", model]);
            }
            if let Some(session) = &request.session {
                push(&["--session", session]);
            }
        }
    }
    args
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text.to_string(),
    }
}

/// What a tool call was about, from its input: a file, a command, a search.
fn tool_detail(input: &Value) -> Option<String> {
    ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description", "filePath"]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))
        .map(|s| truncate(s, 200))
}

/// Codex shows commands wrapped in the shell it ran them with.
fn unwrap_shell(command: &str) -> String {
    for marker in [" -Command '", " -lc '", " -c '"] {
        if let Some(at) = command.find(marker) {
            return command[at + marker.len()..].trim_end_matches('\'').to_string();
        }
    }
    command.to_string()
}

/// Turns one line of a program's output into events.
#[derive(Default)]
pub struct Parser {
    kind: Option<Kind>,
    session: Option<String>,
    /// Claude: the current message's text arrived as deltas (its full text then repeats).
    streamed: bool,
    /// Claude: the next delta starts a new text block.
    block_start: bool,
    /// OpenCode: plain (non-JSON) output already started.
    plain: bool,
    /// Claude: tokens of the last request of the main conversation (prompt, then its answer).
    context: u64,
    error: Option<String>,
}

impl Parser {
    fn new(kind: Kind) -> Parser {
        Parser { kind: Some(kind), ..Parser::default() }
    }

    fn session(&mut self, id: Option<&str>, events: &mut Vec<AiEvent>) {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            if self.session.as_deref() != Some(id) {
                self.session = Some(id.to_string());
                events.push(AiEvent::Session { id: id.to_string() });
            }
        }
    }

    pub fn line(&mut self, line: &str) -> Vec<AiEvent> {
        let mut events = Vec::new();
        let line = line.trim();
        if line.is_empty() {
            return events;
        }
        let Ok(json) = serde_json::from_str::<Value>(line) else {
            // Plain output (an older OpenCode, or a program printing text).
            if self.kind == Some(Kind::OpenCode) {
                events.push(AiEvent::Text { text: format!("{line}\n"), start: !self.plain });
                self.plain = true;
            }
            return events;
        };
        match self.kind {
            Some(Kind::Claude) => self.claude(&json, &mut events),
            Some(Kind::Codex) => self.codex(&json, &mut events),
            Some(Kind::OpenCode) => self.opencode(&json, &mut events),
            None => {}
        }
        events
    }

    fn claude(&mut self, json: &Value, events: &mut Vec<AiEvent>) {
        match json["type"].as_str() {
            Some("system") => match json["subtype"].as_str() {
                Some("init") => self.session(json["session_id"].as_str(), events),
                Some("permission_denied") => events.push(AiEvent::Notice {
                    text: format!(
                        "{} was not allowed{}",
                        json["tool_name"].as_str().unwrap_or("A tool"),
                        json["message"].as_str().map(|m| format!(": {}", truncate(m, 300))).unwrap_or_default()
                    ),
                }),
                _ => {}
            },
            Some("stream_event") => {
                let event = &json["event"];
                // Subagents' requests are not the conversation's context.
                let main = json["parent_tool_use_id"].is_null();
                match event["type"].as_str() {
                    Some("message_start") => {
                        self.streamed = false;
                        if main {
                            let usage = &event["message"]["usage"];
                            self.context = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                                .iter()
                                .map(|k| usage[k].as_u64().unwrap_or(0))
                                .sum();
                        }
                    }
                    Some("message_delta") if main => self.context += event["usage"]["output_tokens"].as_u64().unwrap_or(0),
                    Some("content_block_start") if event["content_block"]["type"] == "text" => self.block_start = true,
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        if let Some(text) = event["delta"]["text"].as_str() {
                            self.streamed = true;
                            events.push(AiEvent::Text { text: text.into(), start: std::mem::take(&mut self.block_start) });
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                for block in json["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("tool_use") => events.push(AiEvent::Tool {
                            title: block["name"].as_str().unwrap_or("Tool").into(),
                            detail: tool_detail(&block["input"]),
                        }),
                        // Without partial messages (older versions) the text only comes here.
                        Some("text") if !self.streamed => {
                            if let Some(text) = block["text"].as_str() {
                                events.push(AiEvent::Text { text: text.into(), start: true });
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("result") => {
                self.session(json["session_id"].as_str(), events);
                if self.context > 0 {
                    let window = json["modelUsage"].as_object().and_then(|models| models.values().filter_map(|m| m["contextWindow"].as_u64()).max());
                    events.push(AiEvent::Usage { used: self.context, window });
                }
                if json["is_error"].as_bool() == Some(true) {
                    let message = json["result"].as_str().or(json["subtype"].as_str()).unwrap_or("The request failed");
                    self.error = Some(message.to_string());
                }
            }
            _ => {}
        }
    }

    fn codex(&mut self, json: &Value, events: &mut Vec<AiEvent>) {
        let item = &json["item"];
        match (json["type"].as_str(), item["type"].as_str()) {
            (Some("thread.started"), _) => self.session(json["thread_id"].as_str(), events),
            (Some("item.started"), Some("command_execution")) => events.push(AiEvent::Tool {
                title: "Run".into(),
                detail: item["command"].as_str().map(|c| truncate(&unwrap_shell(c), 200)),
            }),
            (Some("item.completed"), Some("agent_message")) => {
                if let Some(text) = item["text"].as_str() {
                    events.push(AiEvent::Text { text: text.into(), start: true });
                }
            }
            (Some("item.completed"), Some("file_change")) => {
                let paths: Vec<&str> = item["changes"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str()).collect();
                events.push(AiEvent::Tool { title: "Edit".into(), detail: Some(truncate(&paths.join(", "), 300)).filter(|s| !s.is_empty()) });
            }
            (Some("item.completed"), Some("mcp_tool_call")) => events.push(AiEvent::Tool {
                title: format!("{}: {}", item["server"].as_str().unwrap_or("MCP"), item["tool"].as_str().unwrap_or("tool")),
                detail: None,
            }),
            (Some("item.completed"), Some("web_search")) => {
                events.push(AiEvent::Tool { title: "Search the web".into(), detail: item["query"].as_str().map(|q| truncate(q, 200)) })
            }
            // The turn's total: with several requests in a turn, more than the context holds.
            (Some("turn.completed"), _) => {
                let usage = &json["usage"];
                let used = usage["input_tokens"].as_u64().unwrap_or(0) + usage["output_tokens"].as_u64().unwrap_or(0);
                if used > 0 {
                    events.push(AiEvent::Usage { used, window: None });
                }
            }
            (Some("error"), _) => self.error = json["message"].as_str().map(str::to_string),
            (Some("turn.failed"), _) => {
                self.error = json["error"]["message"].as_str().map(str::to_string).or_else(|| Some("The request failed".into()))
            }
            _ => {}
        }
    }

    fn opencode(&mut self, json: &Value, events: &mut Vec<AiEvent>) {
        self.session(json["sessionID"].as_str().or(json["part"]["sessionID"].as_str()), events);
        let part = &json["part"];
        match json["type"].as_str() {
            Some("text") => {
                if let Some(text) = part["text"].as_str() {
                    events.push(AiEvent::Text { text: text.into(), start: true });
                }
            }
            Some("tool_use") => events.push(AiEvent::Tool {
                title: part["tool"].as_str().unwrap_or("Tool").into(),
                // The input's path is whole; OpenCode's title cuts the path's start.
                detail: tool_detail(&part["state"]["input"]).or_else(|| part["state"]["title"].as_str().map(|t| truncate(t, 200))),
            }),
            Some("step_finish") => {
                // Each step is one request: its total is what the context holds.
                let tokens = &part["tokens"];
                let used = tokens["total"].as_u64().unwrap_or_else(|| {
                    ["input", "output"].iter().map(|k| tokens[k].as_u64().unwrap_or(0)).sum::<u64>()
                        + tokens["cache"]["read"].as_u64().unwrap_or(0)
                        + tokens["cache"]["write"].as_u64().unwrap_or(0)
                });
                if used > 0 {
                    events.push(AiEvent::Usage { used, window: None });
                }
            }
            Some("error") => {
                let error = &json["error"];
                self.error = error["data"]["message"]
                    .as_str()
                    .or(error["message"].as_str())
                    .or(error["name"].as_str())
                    .map(str::to_string)
                    .or_else(|| Some("The request failed".into()));
            }
            _ => {}
        }
    }
}

/// Runs in progress, by id: their process ids, to stop them.
#[derive(Default)]
pub struct AiRuns {
    next: AtomicU32,
    running: Mutex<HashMap<u32, (u32, Arc<std::sync::atomic::AtomicBool>)>>,
}

/// Ends a process and what it started (npm's `.cmd` shims start node).
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(0x0800_0000).status();
    }
    #[cfg(not(windows))]
    {
        // The run is its own process group (see `ai_run`).
        let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
    }
}

/// Starts a request; its events arrive on `on_event`, ending with `done`. Returns the run id.
#[tauri::command]
pub fn ai_run(runs: State<'_, Arc<AiRuns>>, request: AiRequest, on_event: Channel<AiEvent>) -> CmdResult<u32> {
    start(runs.inner().clone(), request, move |event| {
        let _ = on_event.send(event);
    })
}

/// Starts the program for `request`; `send` gets its events, `done` last.
fn start(runs: Arc<AiRuns>, request: AiRequest, send: impl Fn(AiEvent) + Send + 'static) -> CmdResult<u32> {
    let kind = Kind::parse(&request.provider)?;
    if crate::remote::parse(&request.cwd).is_some() || crate::wsl::parse_share(&request.cwd).is_some() {
        return Err("AI assistants run on local folders only for now.".into());
    }
    let mut command = program_command(Path::new(&request.path));
    command
        .args(arguments(kind, &request))
        .current_dir(&request.cwd)
        // Programs that read `PWD` (OpenCode) would otherwise get the folder PowerCode was
        // started from, e.g. the terminal's in a `tauri dev` run.
        .env("PWD", &request.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Claude Code refuses to start inside another Claude Code session.
        .env_remove("CLAUDECODE");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("Could not start {}: {e}", kind.name()))?;
    let id = runs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    runs.running.lock().map_err(err)?.insert(id, (child.id(), stopped.clone()));

    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let prompt = request.prompt.clone();
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
        // Dropped: end of input, the program starts.
    });
    let stderr = child.stderr.take().ok_or("No stderr")?;
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });
    let stdout = child.stdout.take().ok_or("No stdout")?;
    std::thread::spawn(move || {
        let mut parser = Parser::new(kind);
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            for event in parser.line(&line) {
                send(event);
            }
        }
        let status = child.wait();
        let stderr = errors.join().unwrap_or_default();
        if let Ok(mut running) = runs.running.lock() {
            running.remove(&id);
        }
        let error = if stopped.load(Ordering::Relaxed) {
            None
        } else if let Some(error) = parser.error {
            Some(error)
        } else {
            match status {
                Ok(status) if status.success() => None,
                Ok(status) => {
                    let tail: String = stderr.trim().chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
                    Some(if tail.is_empty() { format!("{} exited with {status}", kind.name()) } else { tail })
                }
                Err(e) => Some(e.to_string()),
            }
        };
        send(AiEvent::Done { error });
    });
    Ok(id)
}

#[tauri::command]
pub fn ai_cancel(runs: State<'_, Arc<AiRuns>>, id: u32) {
    let entry = runs.running.lock().ok().and_then(|r| r.get(&id).cloned());
    if let Some((pid, stopped)) = entry {
        stopped.store(true, Ordering::Relaxed);
        std::thread::spawn(move || kill_tree(pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(agent: bool, session: Option<&str>, model: &str, one_shot: bool) -> AiRequest {
        AiRequest {
            provider: String::new(),
            path: String::new(),
            model: Some(model.into()),
            prompt: String::new(),
            cwd: String::new(),
            agent,
            session: session.map(str::to_string),
            one_shot,
        }
    }

    fn parse(kind: Kind, lines: &[&str]) -> (Vec<AiEvent>, Option<String>) {
        let mut parser = Parser::new(kind);
        let events = lines.iter().flat_map(|l| parser.line(l)).collect();
        (events, parser.error)
    }

    #[test]
    fn arguments_follow_the_mode_session_and_model() {
        assert_eq!(
            arguments(Kind::Claude, &request(true, Some("s1"), "opus", false)),
            ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "opus", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,PowerShell", "--resume", "s1"]
        );
        // Ask mode: Claude's default permissions refuse changes in print mode.
        assert!(!arguments(Kind::Claude, &request(false, None, "", false)).iter().any(|a| a == "--permission-mode" || a == "--model"));
        assert_eq!(
            arguments(Kind::Codex, &request(false, Some("t1"), "gpt-x", false)),
            ["exec", "-c", "sandbox_mode=\"read-only\"", "--skip-git-repo-check", "resume", "t1", "--json", "-m", "gpt-x", "-"]
        );
        assert!(arguments(Kind::Codex, &request(true, None, "", false)).contains(&"sandbox_mode=\"workspace-write\"".to_string()));
        let mut in_folder = request(false, Some("ses_1"), "", false);
        in_folder.cwd = "C:\\w".into();
        assert_eq!(arguments(Kind::OpenCode, &in_folder), ["run", "--format", "json", "--dir", "C:\\w", "--agent", "plan", "--session", "ses_1"]);
        // A one-off answer is read-only and saves nothing, whatever the mode.
        let one_shot = arguments(Kind::Claude, &request(true, None, "haiku", true));
        assert!(one_shot.contains(&"--no-session-persistence".to_string()) && !one_shot.contains(&"acceptEdits".to_string()));
        assert!(arguments(Kind::Codex, &request(true, None, "", true)).contains(&"--ephemeral".to_string()));
    }

    #[test]
    fn claude_stream_becomes_text_tools_and_session() {
        let (events, error) = parse(
            Kind::Claude,
            &[
                r#"{"type":"system","subtype":"init","session_id":"abc"}"#,
                r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi "}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi there"}]}}"#,
                r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:\\w\\a.txt"}}]}}"#,
                r#"{"type":"system","subtype":"permission_denied","tool_name":"Write","message":"Claude requested permissions to write"}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500}}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":"toolu_sub","event":{"type":"message_start","message":{"usage":{"input_tokens":90000}}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_delta","usage":{"output_tokens":40}}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"hi there","session_id":"abc","modelUsage":{"claude-haiku-5-5":{"contextWindow":200000}}}"#,
            ],
        );
        assert_eq!(error, None);
        assert_eq!(
            events,
            [
                AiEvent::Session { id: "abc".into() },
                AiEvent::Text { text: "hi ".into(), start: true },
                AiEvent::Text { text: "there".into(), start: false },
                AiEvent::Tool { title: "Read".into(), detail: Some("C:\\w\\a.txt".into()) },
                AiEvent::Notice { text: "Write was not allowed: Claude requested permissions to write".into() },
                AiEvent::Usage { used: 1542, window: Some(200000) },
            ]
        );
        let (_, error) = parse(Kind::Claude, &[r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Credit balance is too low"}"#]);
        assert_eq!(error.as_deref(), Some("Credit balance is too low"));
    }

    #[test]
    fn codex_items_become_text_and_tools() {
        let (events, error) = parse(
            Kind::Codex,
            &[
                r#"{"type":"thread.started","thread_id":"t1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Reading it."}}"#,
                r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"\"C:\\\\powershell.exe\" -Command 'Get-Content sample.txt'","status":"in_progress"}}"#,
                r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"x","exit_code":0}}"#,
                r#"{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}]}}"#,
                r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1000,"output_tokens":30}}"#,
            ],
        );
        assert_eq!(error, None);
        assert_eq!(
            events,
            [
                AiEvent::Session { id: "t1".into() },
                AiEvent::Text { text: "Reading it.".into(), start: true },
                AiEvent::Tool { title: "Run".into(), detail: Some("Get-Content sample.txt".into()) },
                AiEvent::Tool { title: "Edit".into(), detail: Some("src/a.ts".into()) },
                AiEvent::Text { text: "Done.".into(), start: true },
                AiEvent::Usage { used: 1230, window: None },
            ]
        );
        let (_, error) = parse(Kind::Codex, &[r#"{"type":"turn.failed","error":{"message":"usage limit reached"}}"#]);
        assert_eq!(error.as_deref(), Some("usage limit reached"));
    }

    #[test]
    fn opencode_json_and_plain_output() {
        let (events, _) = parse(
            Kind::OpenCode,
            &[
                r#"{"type":"tool_use","sessionID":"ses_1","part":{"tool":"read","state":{"status":"completed","title":"src/a.ts"}}}"#,
                r#"{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"It exports a."}}"#,
                r#"{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"total":10724,"input":224,"output":4,"reasoning":0,"cache":{"write":0,"read":10496}},"cost":0}}"#,
                r#"{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"C:\\w\\b.txt"}}}}"#,
            ],
        );
        assert_eq!(
            events,
            [
                AiEvent::Session { id: "ses_1".into() },
                AiEvent::Tool { title: "read".into(), detail: Some("src/a.ts".into()) },
                AiEvent::Text { text: "It exports a.".into(), start: true },
                AiEvent::Usage { used: 10724, window: None },
                AiEvent::Tool { title: "read".into(), detail: Some("C:\\w\\b.txt".into()) },
            ]
        );
        let (events, _) = parse(Kind::OpenCode, &["plain one", "plain two"]);
        assert_eq!(events, [AiEvent::Text { text: "plain one\n".into(), start: true }, AiEvent::Text { text: "plain two\n".into(), start: false }]);
    }

    #[test]
    fn models_from_codex_cache_and_opencode_list() {
        let cache = r#"{"models":[{"slug":"b","display_name":"B","priority":2,"visibility":"list","context_window":1000,"effective_context_window_percent":95},{"slug":"hidden","priority":0,"visibility":"hide"},{"slug":"a","display_name":"A","description":"Fast","priority":1}]}"#;
        assert_eq!(codex_models(cache), [model("a", "A", Some("Fast")), AiModel { context_window: Some(950), ..model("b", "B", None) }]);
        assert_eq!(opencode_models("anthropic/claude-x\nopenai/gpt-y\n\nSome banner text\n"), [model("anthropic/claude-x", "anthropic/claude-x", None), model("openai/gpt-y", "openai/gpt-y", None)]);
    }

    /// The real programs, when installed: `cargo test --lib ai::tests::real -- --ignored --nocapture`.
    /// Paths come from AI_CLAUDE / AI_CODEX / AI_OPENCODE (else detection on PATH), models from
    /// AI_<PROGRAM>_MODEL; AI_ONLY=opencode (for example) tests one program.
    #[test]
    #[ignore]
    fn real_programs_answer_and_continue() {
        for kind in KINDS {
            if std::env::var("AI_ONLY").is_ok_and(|only| only != kind.id()) {
                continue;
            }
            let path = std::env::var(format!("AI_{}", kind.id().to_uppercase())).ok().map(PathBuf::from).or_else(|| find_program(kind.id(), &search_dirs()));
            let Some(path) = path else {
                println!("{}: not installed", kind.name());
                continue;
            };
            let cwd = std::env::temp_dir().join(format!("powercode-ai-{}", kind.id()));
            std::fs::create_dir_all(&cwd).unwrap();
            std::fs::write(cwd.join("sample.txt"), "pineapple").unwrap();
            let ask = |prompt: &str, session: Option<String>, agent: bool| {
                let runs = Arc::new(AiRuns::default());
                let (tx, rx) = std::sync::mpsc::channel();
                let request = AiRequest {
                    provider: kind.id().into(),
                    path: path.to_string_lossy().into(),
                    model: std::env::var(format!("AI_{}_MODEL", kind.id().to_uppercase())).ok().or_else(|| (kind == Kind::Claude).then(|| "haiku".into())),
                    prompt: prompt.into(),
                    cwd: cwd.to_string_lossy().into(),
                    agent,
                    session,
                    one_shot: false,
                };
                start(runs, request, move |e| tx.send(e).unwrap()).unwrap();
                let mut events = Vec::new();
                while let Ok(event) = rx.recv_timeout(Duration::from_secs(240)) {
                    let done = matches!(event, AiEvent::Done { .. });
                    events.push(event);
                    if done {
                        break;
                    }
                }
                events
            };
            let first = ask("Read sample.txt and reply with only the word in it.", None, false);
            println!("{}: {:?}", kind.name(), first);
            let session = first.iter().find_map(|e| match e {
                AiEvent::Session { id } => Some(id.clone()),
                _ => None,
            });
            let text: String = first.iter().filter_map(|e| if let AiEvent::Text { text, .. } = e { Some(text.as_str()) } else { None }).collect();
            assert!(text.to_lowercase().contains("pineapple"), "{}: {text}", kind.name());
            assert_eq!(first.last(), Some(&AiEvent::Done { error: None }));
            // Ask mode changes nothing.
            let refused = ask("Create a file named out.txt containing x. If you cannot, say so.", session.clone(), false);
            println!("{} (ask, write): {:?}", kind.name(), refused);
            assert!(!cwd.join("out.txt").exists(), "{}: wrote a file in Ask mode", kind.name());
            let again = ask("What was the word? Reply with only the word.", session, false);
            println!("{} (continued): {:?}", kind.name(), again);
            let text: String = again.iter().filter_map(|e| if let AiEvent::Text { text, .. } = e { Some(text.as_str()) } else { None }).collect();
            assert!(text.to_lowercase().contains("pineapple"), "{}: the conversation did not continue: {text}", kind.name());
        }
    }

    #[test]
    fn versions_are_read_from_version_output() {
        assert_eq!(version_number("2.1.328 (Claude Code)\n").as_deref(), Some("2.1.328"));
        assert_eq!(version_number("codex-cli 0.170.0").as_deref(), Some("0.170.0"));
        assert_eq!(version_number("opencode v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(version_number("unknown"), None);
    }

    #[test]
    fn shell_wrappers_are_removed_from_commands() {
        assert_eq!(unwrap_shell(r#""C:\ps.exe" -Command 'ls -la'"#), "ls -la");
        assert_eq!(unwrap_shell("/bin/bash -lc 'cargo test'"), "cargo test");
        assert_eq!(unwrap_shell("git status"), "git status");
    }
}
