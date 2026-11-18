//! Runs the extension host (ext-host/, bundled to resources/ext-host.cjs) in
//! the Node.js binary shipped with the app, and relays its messages: the host
//! and the UI speak JSON-RPC to each other; this side only moves the lines.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::error::{err, CmdResult};

/// Protocol lines start with this; anything else on stdout is an extension printing.
const PREFIX: &str = "\u{1}PC ";

#[derive(Default)]
pub struct ExtensionHost {
    process: Mutex<Option<(Child, ChildStdin)>>,
}

impl ExtensionHost {
    fn stop(&self) {
        if let Ok(mut process) = self.process.lock() {
            if let Some((mut child, _)) = process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// The bundled Node sidecar (placed next to the app's executable), or `node` on PATH.
fn node_binary() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// Windows paths without the `\\?\` (extended-length) prefix Tauri's path resolver adds:
/// Node cannot resolve its main module from such a path.
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// The bundled host script. Development builds read it from the source tree, so
/// `bun run build:exthost` plus "Restart Extension Host" applies host changes
/// without rebuilding the app (resources are only copied by the Rust build).
fn host_script(app: &AppHandle) -> CmdResult<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ext-host.cjs");
        if source.is_file() {
            return Ok(source);
        }
    }
    let resource = app
        .path()
        .resolve("resources/ext-host.cjs", BaseDirectory::Resource)
        .map_err(err)?;
    Ok(without_verbatim_prefix(resource))
}

/// A log message for the UI, in the protocol's own shape.
fn log_line(level: &str, message: &str) -> String {
    serde_json::json!({ "method": "log", "params": { "level": level, "message": message } }).to_string()
}

/// Starts (or restarts) the host; its messages arrive on `on_message` as JSON strings.
#[tauri::command(async)]
pub fn exthost_start(app: AppHandle, state: State<'_, ExtensionHost>, on_message: Channel<String>) -> CmdResult<()> {
    state.stop();
    let script = host_script(&app)?;
    let mut command = Command::new(node_binary());
    command
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start the extension host ({}): {e}", node_binary().display()))?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    let messages = on_message.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let message = match line.strip_prefix(PREFIX) {
                Some(json) => json.to_string(),
                None => log_line("info", &line),
            };
            if messages.send(message).is_err() {
                break;
            }
        }
        // The host is gone (crash, kill or restart): the UI drops its registrations.
        let _ = messages.send(serde_json::json!({ "method": "exit" }).to_string());
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if on_message.send(log_line("error", &line)).is_err() {
                break;
            }
        }
    });

    *state.process.lock().map_err(err)? = Some((child, stdin));
    Ok(())
}

/// Sends one JSON-RPC message to the host.
#[tauri::command(async)]
pub fn exthost_send(state: State<'_, ExtensionHost>, message: String) -> CmdResult<()> {
    let mut process = state.process.lock().map_err(err)?;
    let (_, stdin) = process.as_mut().ok_or("The extension host is not running.")?;
    stdin.write_all(message.as_bytes()).map_err(err)?;
    stdin.write_all(b"\n").map_err(err)?;
    stdin.flush().map_err(err)
}

#[tauri::command(async)]
pub fn exthost_stop(state: State<'_, ExtensionHost>) {
    state.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_verbatim_prefix() {
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\C:\app\resources\ext-host.cjs")),
            PathBuf::from(r"C:\app\resources\ext-host.cjs")
        );
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\x.cjs")),
            PathBuf::from(r"\\server\share\x.cjs")
        );
        assert_eq!(without_verbatim_prefix(PathBuf::from("/opt/app/x.cjs")), PathBuf::from("/opt/app/x.cjs"));
    }
}
