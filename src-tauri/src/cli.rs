//! The command line: `powercode [-n] [paths...] [-g file:line[:column]]`. Paths open
//! in the running window when there is one (see the single-instance plugin in
//! lib.rs), else in the window being started. `-n` / `--new-window` starts another
//! window: each window is its own process (own extension host, terminals, remotes).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// A file or folder to open, from the command line or the OS ("Open with").
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub is_dir: bool,
    pub exists: bool,
}

/// Requests that arrive before the UI asked for them (at startup) wait here.
pub struct CliState {
    pending: Mutex<Vec<OpenRequest>>,
    ready: Mutex<bool>,
    /// Started as an additional window: it opens empty, not the last folder.
    new_window: bool,
}

impl CliState {
    pub fn from_process() -> Self {
        let args: Vec<String> = std::env::args().collect();
        let cwd = std::env::current_dir().unwrap_or_default();
        CliState { pending: Mutex::new(parse_args(&args, &cwd)), ready: Mutex::new(false), new_window: wants_new_window(&args) }
    }
}

/// The option that starts another window instead of using the running one.
pub const NEW_WINDOW_FLAG: &str = "--new-window";

/// Whether `args` ask for a window of their own (`-n` / `--new-window`, before any `--`).
pub fn wants_new_window(args: &[String]) -> bool {
    args.iter().skip(1).take_while(|a| a.as_str() != "--").any(|a| a == NEW_WINDOW_FLAG || a == "-n")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    new_window: bool,
}

/// How this window was started.
#[tauri::command]
pub fn cli_launch_info(state: State<'_, CliState>) -> LaunchInfo {
    LaunchInfo { new_window: state.new_window }
}

/// Starts another PowerCode window (a new process), empty or with `path` open.
#[tauri::command]
pub fn cli_new_window(path: Option<String>) -> crate::error::CmdResult<()> {
    // An AppImage runs from a mount that goes away with its process: start the image itself.
    let program = match std::env::var_os("APPIMAGE") {
        Some(image) => PathBuf::from(image),
        None => std::env::current_exe().map_err(crate::error::err)?,
    };
    let mut command = std::process::Command::new(program);
    command.arg(NEW_WINDOW_FLAG);
    if let Some(path) = path {
        command.arg("--").arg(path);
    }
    command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Its own process group, with no console: it outlives this window.
        command.creation_flags(0x0000_0200 | 0x0800_0000);
    }
    command.spawn().map_err(crate::error::err)?;
    Ok(())
}

/// `file:12` or `file:12:5` (the drive colon of `C:\x` is not a position).
fn split_position(spec: &str) -> (&str, Option<u32>, Option<u32>) {
    let mut parts: Vec<&str> = spec.rsplitn(3, ':').collect();
    parts.reverse();
    let number = |s: &str| s.parse::<u32>().ok().filter(|n| *n > 0);
    match parts.as_slice() {
        [path, line, column] if number(line).is_some() && number(column).is_some() && !path.is_empty() => {
            (&spec[..path.len()], number(line), number(column))
        }
        _ => match spec.rsplit_once(':') {
            Some((path, line)) if number(line).is_some() && !path.is_empty() && !(path.len() == 1 && cfg!(windows)) => {
                (path, number(line), None)
            }
            _ => (spec, None, None),
        },
    }
}

fn resolve(path: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(path);
    let joined = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
    // Lexical, so Windows paths keep their usual form (no `\\?\`).
    std::path::absolute(&joined).unwrap_or(joined)
}

fn request(path: &str, line: Option<u32>, column: Option<u32>, cwd: &Path) -> OpenRequest {
    // A folder on an SSH host (e.g. a recent project in the jump list): opened as it is.
    if path.starts_with("ssh://") {
        return OpenRequest { path: path.to_string(), line: None, column: None, is_dir: true, exists: true };
    }
    let resolved = resolve(path, cwd);
    let metadata = std::fs::metadata(&resolved).ok();
    OpenRequest {
        path: resolved.to_string_lossy().into_owned(),
        line,
        column,
        is_dir: metadata.as_ref().is_some_and(|m| m.is_dir()),
        exists: metadata.is_some(),
    }
}

/// Parses a command line (`args[0]` is the program). Unknown options are ignored.
pub fn parse_args(args: &[String], cwd: &Path) -> Vec<OpenRequest> {
    let mut requests = Vec::new();
    let mut goto = false;
    let mut options_done = false;
    for arg in args.iter().skip(1) {
        if !options_done && arg == "--" {
            options_done = true;
        } else if !options_done && (arg == "-g" || arg == "--goto") {
            goto = true;
        } else if !options_done && arg.starts_with('-') && arg.len() > 1 {
            // e.g. `--new-window`, or flags the OS adds; nothing to open.
        } else if goto {
            let (path, line, column) = split_position(arg);
            requests.push(request(path, line, column, cwd));
        } else {
            requests.push(request(arg, None, None, cwd));
        }
    }
    requests
}

/// Paths the app was started with; afterwards they arrive as `cli-open` events.
#[tauri::command]
pub fn cli_take_pending(state: State<'_, CliState>) -> Vec<OpenRequest> {
    if let Ok(mut ready) = state.ready.lock() {
        *ready = true;
    }
    state.pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}

/// Opens `requests` in the window (or queues them until the UI is up) and brings it forward.
pub fn deliver(app: &AppHandle, requests: Vec<OpenRequest>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if requests.is_empty() {
        return;
    }
    let state = app.state::<CliState>();
    let ready = state.ready.lock().map(|r| *r).unwrap_or(false);
    if ready {
        let _ = app.emit("cli-open", requests);
    } else if let Ok(mut pending) = state.pending.lock() {
        pending.extend(requests);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_window_option() {
        let a = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(wants_new_window(&a(&["powercode", "-n"])));
        assert!(wants_new_window(&a(&["powercode", "--new-window", "--", "C:/work"])));
        assert!(!wants_new_window(&a(&["powercode", "C:/work"])));
        // After `--` it is a path named `-n`, not the option.
        assert!(!wants_new_window(&a(&["powercode", "--", "-n"])));
        // The option opens nothing itself; the paths after it still do.
        let cwd = std::env::temp_dir();
        assert_eq!(parse_args(&a(&["powercode", "--new-window", "--", "x"]), &cwd).len(), 1);
    }

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("powercode").chain(list.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn resolves_paths_against_the_working_directory() {
        let cwd = std::env::temp_dir();
        let requests = parse_args(&args(&["."]), &cwd);
        assert_eq!(requests.len(), 1);
        assert!(requests[0].is_dir && requests[0].exists);
        assert_eq!(PathBuf::from(&requests[0].path), std::path::absolute(cwd.join(".")).unwrap());
        let missing = parse_args(&args(&["no-such-file.txt"]), &cwd);
        assert!(!missing[0].exists && !missing[0].is_dir);
        assert!(missing[0].path.ends_with("no-such-file.txt"));
    }

    #[test]
    fn goto_positions() {
        assert_eq!(split_position("src/a.ts:12:5"), ("src/a.ts", Some(12), Some(5)));
        assert_eq!(split_position("src/a.ts:12"), ("src/a.ts", Some(12), None));
        assert_eq!(split_position("src/a.ts"), ("src/a.ts", None, None));
        assert_eq!(split_position(r"C:\x\a.ts:3:1"), (r"C:\x\a.ts", Some(3), Some(1)));
        assert_eq!(split_position(r"C:\x\a.ts:3"), (r"C:\x\a.ts", Some(3), None));
        if cfg!(windows) {
            assert_eq!(split_position(r"C:\x\a.ts"), (r"C:\x\a.ts", None, None));
        }
        let cwd = std::env::temp_dir();
        let requests = parse_args(&args(&["--new-window", "-g", "a.ts:7:2", "b.ts"]), &cwd);
        assert_eq!((requests[0].line, requests[0].column), (Some(7), Some(2)));
        assert!(requests[0].path.ends_with("a.ts"));
        assert_eq!(requests[1].line, None, "only the -g argument has a position");
    }
}
