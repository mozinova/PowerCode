//! AI assistants installed on the computer (Claude Code, Codex, OpenCode, Antigravity), driven
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
    Antigravity,
}

const KINDS: [Kind; 4] = [Kind::Claude, Kind::Codex, Kind::OpenCode, Kind::Antigravity];

impl Kind {
    fn parse(id: &str) -> CmdResult<Kind> {
        KINDS.into_iter().find(|k| k.id() == id).ok_or_else(|| format!("Unknown AI provider {id}"))
    }

    fn id(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
            Kind::OpenCode => "opencode",
            Kind::Antigravity => "antigravity",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Claude => "Claude Code",
            Kind::Codex => "Codex",
            Kind::OpenCode => "OpenCode",
            Kind::Antigravity => "Antigravity",
        }
    }

    /// The command-line program's name.
    fn program(self) -> &'static str {
        match self {
            Kind::Antigravity => "agy",
            other => other.id(),
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
        for relative in [".local/bin", ".claude/local", ".bun/bin", ".opencode/bin", ".agy/bin", ".npm-global/bin", ".volta/bin", ".cargo/bin"] {
            dirs.push(home.join(relative));
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    // Antigravity's CLI installs itself there.
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("agy").join("bin"));
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
        Kind::OpenCode | Kind::Antigravity => None,
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
    let (path, bundled_copy) = match configured.or_else(|| find_program(kind.program(), dirs)) {
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

/// `agy models` prints `id<TAB>name` lines (after a "Fetching..." line).
fn antigravity_models(output: &str) -> Vec<AiModel> {
    output
        .lines()
        .filter_map(|line| {
            let (id, name) = line.trim().split_once('\t')?;
            (!id.is_empty() && !id.contains(' ')).then(|| model(id.trim(), name.trim(), None))
        })
        .collect()
}

/// `gemini-3.8-flash-low`, as `agy models` lists it, is refused as `--model`; the base
/// model with `--effort low` is taken.
fn split_effort(model: &str) -> Option<(&str, &str)> {
    let (base, effort) = model.rsplit_once('-')?;
    ["low", "medium", "high", "xhigh", "max"].contains(&effort).then_some((base, effort))
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
        Kind::Antigravity => output_within(Path::new(&path), &["models"], Duration::from_secs(60)).map(|o| antigravity_models(&o)).unwrap_or_default(),
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
    /// Images (and other non-text files) attached, by absolute path; text files come inline in the prompt.
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    /// The program's conversation id, to continue it.
    Session { id: String },
    /// Answer text; `start` begins a new paragraph block instead of extending the last.
    Text { text: String, start: bool },
    /// The assistant used a tool (read a file, ran a command, edited ...): `input` is what it
    /// was given (JSON, or the command), `id` matches the `ToolOutput` that follows.
    Tool { id: Option<String>, title: String, detail: Option<String>, input: Option<String> },
    /// What a tool returned (or its error).
    ToolOutput { id: String, output: String, error: bool },
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
            // Attachments outside the project: Claude reads them (images too) with its Read tool.
            for dir in attachment_dirs(request) {
                push(&["--add-dir", &dir]);
            }
        }
        Kind::Codex => {
            // `-c sandbox_mode`: `exec resume` takes no `--sandbox`.
            let sandbox = if request.agent && !request.one_shot { "workspace-write" } else { "read-only" };
            push(&["exec", "-c", &format!("sandbox_mode=\"{sandbox}\""), "--skip-git-repo-check"]);
            if let Some(session) = &request.session {
                push(&["resume", session]);
            }
            for image in request.attachments.iter().filter(|a| is_image(a)) {
                push(&[&format!("--image={image}")]);
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
            for file in &request.attachments {
                push(&[&format!("--file={file}")]);
            }
        }
        Kind::Antigravity => {
            // The prompt comes on stdin as a stream-json message: `-p` takes it as an
            // argument, which Windows limits to about 32k characters.
            push(&["--output-format", "stream-json", "--input-format", "stream-json"]);
            match model.map(|m| (m, split_effort(m))) {
                Some((_, Some((base, effort)))) => push(&["--model", base, "--effort", effort]),
                Some((model, None)) => push(&["--model", model]),
                None => {}
            }
            if request.agent && !request.one_shot {
                // Headless mode cannot ask: commands are allowed up front, edits by the mode.
                push(&["--mode", "accept-edits", "--settings", r#"{"permissions":{"allow":["command(*)"]}}"#]);
            } else {
                // Antigravity has no read-only mode: plan, with commands refused. It may still
                // write files (deny rules do not cover them); the Ask switch says so.
                push(&["--mode", "plan", "--settings", r#"{"permissions":{"deny":["command(*)"]}}"#]);
            }
            if let Some(session) = &request.session {
                push(&["--conversation", session]);
            }
            for dir in attachment_dirs(request) {
                push(&["--add-dir", &dir]);
            }
        }
    }
    args
}

fn is_image(path: &str) -> bool {
    let lower = path.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|ext| lower.ends_with(ext))
}

/// The folders of the attachments, once each, for programs that only read inside allowed folders.
fn attachment_dirs(request: &AiRequest) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    for file in &request.attachments {
        if let Some(dir) = Path::new(file).parent().map(|d| d.to_string_lossy().into_owned()) {
            if !dir.is_empty() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// Saves an image pasted into the AI tool window (base64) and returns its path, to attach it.
#[tauri::command(async)]
pub fn ai_save_image(app: AppHandle, data: String, extension: String) -> CmdResult<String> {
    use base64::Engine;
    let extension = extension.to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp"].contains(&extension.as_str()) {
        return Err(format!("Unsupported image type: {extension}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(err)?;
    let dir = app.path().app_data_dir().map_err(err)?.join("ai-attachments");
    std::fs::create_dir_all(&dir).map_err(err)?;
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("pasted-{stamp}-{}.{extension}", NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// What goes to the program's stdin: the prompt, or for Antigravity one stream-json message.
fn stdin_payload(kind: Kind, prompt: &str) -> String {
    match kind {
        Kind::Antigravity => format!("{}\n", serde_json::json!({ "event": "user", "message": { "content": prompt } })),
        _ => prompt.to_string(),
    }
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
    [
        "file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description", "filePath",
        // Antigravity's parameters.
        "Path", "AbsolutePath", "TargetFile", "CommandLine", "Query", "SearchPath", "Url",
    ]
        .iter()
        .find_map(|key| input.get(key).and_then(Value::as_str))
        .map(|s| truncate(s, 200))
}

/// Antigravity's tool names, as the other programs call them (and the UI has icons for).
fn antigravity_tool(name: &str) -> &str {
    match name {
        "read_file" | "view_file" => "Read",
        "write_file" | "write_to_file" => "Write",
        "edit_file" | "replace_file_content" | "multi_replace_file_content" => "Edit",
        "run_command" => "Run",
        "grep_search" => "Grep",
        "find_by_name" | "list_dir" => "Glob",
        "search_web" => "Search the web",
        other => other,
    }
}

const MAX_TOOL_INPUT: usize = 20_000;
const MAX_TOOL_OUTPUT: usize = 50_000;

/// `text` up to `max` bytes (on a character boundary), saying when it was cut.
fn cap(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes)", &text[..end], text.len() - end)
}

/// A tool's input as text: a string as it is, anything else as pretty JSON.
fn tool_input(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(cap(text, MAX_TOOL_INPUT)),
        Value::Object(map) if map.is_empty() => None,
        other => serde_json::to_string_pretty(other).ok().map(|t| cap(&t, MAX_TOOL_INPUT)),
    }
}

/// A tool's output as text: a string, text blocks (`[{type: "text", text}]`), or JSON.
fn tool_output(value: &Value) -> Option<String> {
    let text = match value {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        Value::Array(blocks) if blocks.iter().all(|b| b["text"].is_string()) => {
            blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
        }
        other => serde_json::to_string_pretty(other).ok()?,
    };
    Some(cap(&text, MAX_TOOL_OUTPUT))
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
    /// Claude: tokens of the last request of the main conversation (prompt, then its answer);
    /// Antigravity: of its last step.
    context: u64,
    /// Antigravity: the step the text came from, so a new step starts a new block.
    step: Option<i64>,
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
            Some(Kind::Antigravity) => self.antigravity(&json, &mut events),
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
                            id: block["id"].as_str().map(str::to_string),
                            title: block["name"].as_str().unwrap_or("Tool").into(),
                            detail: tool_detail(&block["input"]),
                            input: tool_input(&block["input"]),
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
            // Tool results come back as the user's turn.
            Some("user") => {
                for block in json["message"]["content"].as_array().into_iter().flatten() {
                    if let (Some("tool_result"), Some(id)) = (block["type"].as_str(), block["tool_use_id"].as_str()) {
                        events.push(AiEvent::ToolOutput {
                            id: id.into(),
                            output: tool_output(&block["content"]).unwrap_or_default(),
                            error: block["is_error"].as_bool() == Some(true),
                        });
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
        let id = item["id"].as_str().map(str::to_string);
        match (json["type"].as_str(), item["type"].as_str()) {
            (Some("thread.started"), _) => self.session(json["thread_id"].as_str(), events),
            (Some("item.started"), Some("command_execution")) => {
                let command = item["command"].as_str().map(unwrap_shell);
                events.push(AiEvent::Tool {
                    id,
                    title: "Run".into(),
                    detail: command.as_deref().map(|c| truncate(c, 200)),
                    input: command,
                })
            }
            (Some("item.completed"), Some("command_execution")) => {
                if let Some(id) = id {
                    let exit = item["exit_code"].as_i64();
                    events.push(AiEvent::ToolOutput {
                        id,
                        output: tool_output(&item["aggregated_output"]).unwrap_or_default(),
                        error: exit.is_some_and(|code| code != 0),
                    });
                }
            }
            (Some("item.completed"), Some("agent_message")) => {
                if let Some(text) = item["text"].as_str() {
                    events.push(AiEvent::Text { text: text.into(), start: true });
                }
            }
            (Some("item.completed"), Some("file_change")) => {
                let changes: Vec<(&str, &str)> = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| Some((c["kind"].as_str().unwrap_or("change"), c["path"].as_str()?)))
                    .collect();
                let paths: Vec<&str> = changes.iter().map(|(_, path)| *path).collect();
                events.push(AiEvent::Tool { id: id.clone(), title: "Edit".into(), detail: Some(truncate(&paths.join(", "), 300)).filter(|s| !s.is_empty()), input: None });
                if let Some(id) = id {
                    let output = changes.iter().map(|(kind, path)| format!("{kind} {path}")).collect::<Vec<_>>().join("\n");
                    events.push(AiEvent::ToolOutput { id, output, error: item["status"] == "failed" });
                }
            }
            (Some("item.completed"), Some("mcp_tool_call")) => {
                events.push(AiEvent::Tool {
                    id: id.clone(),
                    title: format!("{}: {}", item["server"].as_str().unwrap_or("MCP"), item["tool"].as_str().unwrap_or("tool")),
                    detail: None,
                    input: tool_input(&item["arguments"]),
                });
                let (output, error) = match tool_output(&item["error"]) {
                    Some(error) => (Some(error), true),
                    None => (tool_output(&item["result"]), false),
                };
                if let (Some(id), Some(output)) = (id, output) {
                    events.push(AiEvent::ToolOutput { id, output, error });
                }
            }
            (Some("item.completed"), Some("web_search")) => events.push(AiEvent::Tool {
                id,
                title: "Search the web".into(),
                detail: item["query"].as_str().map(|q| truncate(q, 200)),
                input: item["query"].as_str().map(str::to_string),
            }),
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

    fn antigravity(&mut self, json: &Value, events: &mut Vec<AiEvent>) {
        match json["event"].as_str() {
            Some("init") => self.session(json["conversation_id"].as_str(), events),
            Some("step_update") => {
                let step = &json["step_update"];
                self.session(step["conversation_id"].as_str(), events);
                match step["step_type"].as_str() {
                    Some("agent_response") => {
                        if let Some(text) = step["text_delta"].as_str().filter(|t| !t.is_empty()) {
                            let index = step["step_index"].as_i64();
                            let start = self.step != index;
                            self.step = index;
                            events.push(AiEvent::Text { text: text.into(), start });
                        }
                        let usage = &step["usage"];
                        if step["state"] == "DONE" && usage.is_object() {
                            self.context = ["input_tokens", "cache_read_tokens", "output_tokens"].iter().map(|k| usage[k].as_u64().unwrap_or(0)).sum();
                        }
                    }
                    Some("tool") => {
                        let name = antigravity_tool(step["tool_name"].as_str().unwrap_or("Tool"));
                        let info = &step["tool_info"];
                        // A tool is one step: its index ties the call to its result.
                        let id = step["step_index"].as_i64().map(|i| format!("step-{i}"));
                        match step["state"].as_str() {
                            Some("ACTIVE") => events.push(AiEvent::Tool {
                                id,
                                title: name.into(),
                                detail: tool_detail(&info["parameters"]),
                                input: tool_input(&info["parameters"]),
                            }),
                            Some("DONE") => {
                                if let Some(id) = id {
                                    events.push(AiEvent::ToolOutput { id, output: tool_output(&info["output"]).unwrap_or_default(), error: false });
                                }
                            }
                            Some("ERROR") => {
                                let message = info["error"]["message"].as_str().unwrap_or("");
                                if let Some(id) = id {
                                    events.push(AiEvent::ToolOutput { id, output: cap(message, MAX_TOOL_OUTPUT), error: true });
                                }
                                if message.contains("denied") || message.contains("permission") {
                                    let first = message.lines().next().unwrap_or(message);
                                    events.push(AiEvent::Notice { text: format!("{name} was not allowed: {}", truncate(first, 300)) });
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            Some("result") => {
                let result = &json["result"];
                self.session(result["conversation_id"].as_str(), events);
                if self.context > 0 {
                    events.push(AiEvent::Usage { used: self.context, window: None });
                }
                if result["status"] == "ERROR" {
                    self.error = Some(result["error"].as_str().unwrap_or("The request failed").to_string());
                }
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
            Some("tool_use") => {
                let state = &part["state"];
                let id = part["callID"].as_str().map(str::to_string);
                events.push(AiEvent::Tool {
                    id: id.clone(),
                    title: part["tool"].as_str().unwrap_or("Tool").into(),
                    // The input's path is whole; OpenCode's title cuts the path's start.
                    detail: tool_detail(&state["input"]).or_else(|| state["title"].as_str().map(|t| truncate(t, 200))),
                    input: tool_input(&state["input"]),
                });
                // OpenCode reports a tool once done, with its output.
                let error = state["status"] == "error";
                if let (Some(id), Some(output)) = (id, tool_output(if error { &state["error"] } else { &state["output"] })) {
                    events.push(AiEvent::ToolOutput { id, output, error });
                }
            }
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
    let prompt = stdin_payload(kind, &request.prompt);
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
            attachments: Vec::new(),
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
                r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\thello"}]}}"#,
                r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":[{"type":"text","text":"denied"}],"is_error":true}]}}"#,
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
                AiEvent::Tool { id: None, title: "Read".into(), detail: Some("C:\\w\\a.txt".into()), input: Some("{\n  \"file_path\": \"C:\\\\w\\\\a.txt\"\n}".into()) },
                AiEvent::ToolOutput { id: "toolu_1".into(), output: "1\thello".into(), error: false },
                AiEvent::ToolOutput { id: "toolu_2".into(), output: "denied".into(), error: true },
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
                AiEvent::Tool { id: Some("item_1".into()), title: "Run".into(), detail: Some("Get-Content sample.txt".into()), input: Some("Get-Content sample.txt".into()) },
                AiEvent::ToolOutput { id: "item_1".into(), output: String::new(), error: false },
                AiEvent::Tool { id: Some("item_2".into()), title: "Edit".into(), detail: Some("src/a.ts".into()), input: None },
                AiEvent::ToolOutput { id: "item_2".into(), output: "update src/a.ts".into(), error: false },
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
                r#"{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","callID":"call_2","state":{"status":"completed","input":{"filePath":"C:\\w\\b.txt"},"output":"1: x"}}}"#,
            ],
        );
        assert_eq!(
            events,
            [
                AiEvent::Session { id: "ses_1".into() },
                AiEvent::Tool { id: None, title: "read".into(), detail: Some("src/a.ts".into()), input: None },
                AiEvent::Text { text: "It exports a.".into(), start: true },
                AiEvent::Usage { used: 10724, window: None },
                AiEvent::Tool { id: Some("call_2".into()), title: "read".into(), detail: Some("C:\\w\\b.txt".into()), input: Some("{\n  \"filePath\": \"C:\\\\w\\\\b.txt\"\n}".into()) },
                AiEvent::ToolOutput { id: "call_2".into(), output: "1: x".into(), error: false },
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
            let path = std::env::var(format!("AI_{}", kind.id().to_uppercase())).ok().map(PathBuf::from).or_else(|| find_program(kind.program(), &search_dirs()));
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
                    attachments: Vec::new(),
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
            if kind == Kind::Antigravity {
                // No read-only mode (see `arguments`): reported, not asserted.
                println!("{} wrote a file in Ask mode: {}", kind.name(), cwd.join("out.txt").exists());
                let _ = std::fs::remove_file(cwd.join("out.txt"));
            } else {
                assert!(!cwd.join("out.txt").exists(), "{}: wrote a file in Ask mode", kind.name());
            }
            let again = ask("What was the word? Reply with only the word.", session, false);
            println!("{} (continued): {:?}", kind.name(), again);
            let text: String = again.iter().filter_map(|e| if let AiEvent::Text { text, .. } = e { Some(text.as_str()) } else { None }).collect();
            assert!(text.to_lowercase().contains("pineapple"), "{}: the conversation did not continue: {text}", kind.name());
        }
    }

    #[test]
    fn attachments_reach_each_program_as_it_takes_them() {
        let mut with = request(false, None, "", false);
        with.attachments = vec!["C:\\data\\ai-attachments\\pasted-1.png".into(), "C:\\docs\\spec.pdf".into()];
        let claude = arguments(Kind::Claude, &with);
        assert!(claude.windows(2).any(|w| w == ["--add-dir", "C:\\data\\ai-attachments"]));
        assert!(claude.windows(2).any(|w| w == ["--add-dir", "C:\\docs"]));
        let codex = arguments(Kind::Codex, &with);
        // Only images, before `--json`, and the prompt still read from stdin last.
        assert_eq!(codex.iter().filter(|a| a.starts_with("--image=")).collect::<Vec<_>>(), ["--image=C:\\data\\ai-attachments\\pasted-1.png"]);
        assert!(codex.iter().position(|a| a.starts_with("--image=")) < codex.iter().position(|a| a == "--json"));
        assert_eq!(codex.last().map(String::as_str), Some("-"));
        assert_eq!(arguments(Kind::OpenCode, &with).iter().filter(|a| a.starts_with("--file=")).count(), 2);
        assert!(arguments(Kind::Antigravity, &with).windows(2).any(|w| w == ["--add-dir", "C:\\docs"]));
    }

    #[test]
    fn antigravity_arguments_input_and_models() {
        let mut ask = request(false, Some("c1"), "gemini-3.8-flash-low", false);
        ask.cwd = "C:\\w".into();
        assert_eq!(
            arguments(Kind::Antigravity, &ask),
            [
                "--output-format", "stream-json", "--input-format", "stream-json", "--model", "gemini-3.8-flash", "--effort", "low",
                "--mode", "plan", "--settings", r#"{"permissions":{"deny":["command(*)"]}}"#, "--conversation", "c1",
            ]
        );
        let agent = arguments(Kind::Antigravity, &request(true, None, "claude-sonnet-4-6", false));
        assert!(agent.windows(2).any(|w| w == ["--model", "claude-sonnet-4-6"]));
        assert!(agent.windows(2).any(|w| w == ["--mode", "accept-edits"]));
        assert_eq!(split_effort("gpt-oss-120b-medium"), Some(("gpt-oss-120b", "medium")));
        assert_eq!(split_effort("claude-opus-4-6-thinking"), None);
        assert_eq!(stdin_payload(Kind::Antigravity, "hi \"there\""), "{\"event\":\"user\",\"message\":{\"content\":\"hi \\\"there\\\"\"}}\n");
        assert_eq!(stdin_payload(Kind::Claude, "hi"), "hi");
        assert_eq!(
            antigravity_models("Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n"),
            [model("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)", None), model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", None)]
        );
    }

    #[test]
    fn antigravity_stream_becomes_text_tools_and_usage() {
        let (events, error) = parse(
            Kind::Antigravity,
            &[
                r#"{"event":"init","conversation_id":"c1","init":{"cwd":"C:\\w","tools":["read_file"]}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"C:\\w\\sample.txt"}}}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"output":"1 lines"}}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"Get-ChildItem"},"error":{"type":"TOOL_ERROR","message":"permission check failed for unsandboxed \"Get-ChildItem\": user denied permission to run command:\nGet-ChildItem"}}}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"pine"}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"apple"}}"#,
                r#"{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":2252,"output_tokens":2326,"cache_read_tokens":13763,"total_tokens":4578}}}"#,
                r#"{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"pineapple\n"}}"#,
            ],
        );
        assert_eq!(error, None);
        assert_eq!(
            events,
            [
                AiEvent::Session { id: "c1".into() },
                AiEvent::Tool { id: Some("step-2".into()), title: "Read".into(), detail: Some("C:\\w\\sample.txt".into()), input: Some("{\n  \"Path\": \"C:\\\\w\\\\sample.txt\"\n}".into()) },
                AiEvent::ToolOutput { id: "step-2".into(), output: "1 lines".into(), error: false },
                AiEvent::ToolOutput { id: "step-3".into(), output: "permission check failed for unsandboxed \"Get-ChildItem\": user denied permission to run command:\nGet-ChildItem".into(), error: true },
                AiEvent::Notice { text: "Run was not allowed: permission check failed for unsandboxed \"Get-ChildItem\": user denied permission to run command:".into() },
                AiEvent::Text { text: "pine".into(), start: true },
                AiEvent::Text { text: "apple".into(), start: false },
                AiEvent::Text { text: "\n".into(), start: false },
                AiEvent::Usage { used: 18341, window: None },
            ]
        );
        let (_, error) = parse(Kind::Antigravity, &[r#"{"event":"result","result":{"conversation_id":"","status":"ERROR","error":"invalid model selection"}}"#]);
        assert_eq!(error.as_deref(), Some("invalid model selection"));
    }

    #[test]
    fn versions_are_read_from_version_output() {
        assert_eq!(version_number("2.1.328 (Claude Code)\n").as_deref(), Some("2.1.328"));
        assert_eq!(version_number("codex-cli 0.170.0").as_deref(), Some("0.170.0"));
        assert_eq!(version_number("opencode v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(version_number("unknown"), None);
    }

    #[test]
    fn long_tool_output_is_cut_on_a_character_boundary() {
        let text = "é".repeat(30_000);
        let cut = cap(&text, MAX_TOOL_OUTPUT);
        assert!(cut.len() < text.len() && cut.ends_with("more bytes)"));
        assert_eq!(tool_output(&serde_json::json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }])).as_deref(), Some("a\nb"));
        assert_eq!(tool_input(&serde_json::json!({})), None);
    }

    #[test]
    fn shell_wrappers_are_removed_from_commands() {
        assert_eq!(unwrap_shell(r#""C:\ps.exe" -Command 'ls -la'"#), "ls -la");
        assert_eq!(unwrap_shell("/bin/bash -lc 'cargo test'"), "cargo test");
        assert_eq!(unwrap_shell("git status"), "git status");
    }
}
