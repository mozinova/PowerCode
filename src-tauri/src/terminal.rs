use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{err, CmdResult};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output(String),
    Exit,
}

/// The shell for a terminal opened in `cwd`: on the SSH host or in the WSL
/// distribution for remote workspaces, otherwise the local shell.
/// A program to run in the terminal instead of a shell (a debugger's `runInTerminal`).
#[derive(Deserialize)]
pub struct Program {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    /// Variables to set; `null` removes one, as in the Debug Adapter Protocol.
    #[serde(default)]
    env: HashMap<String, Option<String>>,
}

/// `cd <dir> && exec env -u A B=1 <command> <args>`: the program as a shell line on a remote.
fn remote_program_line(dir: &str, program: &Program) -> String {
    use crate::remote::quote;
    let mut env = Vec::new();
    for (key, value) in &program.env {
        match value {
            Some(value) => env.push(quote(&format!("{key}={value}"))),
            None => env.push(format!("-u {}", quote(key))),
        }
    }
    let command: Vec<String> = std::iter::once(&program.command).chain(&program.args).map(|a| quote(a)).collect();
    format!("cd {} && exec env {} {}", quote(dir), env.join(" "), command.join(" "))
}

fn program_command(cwd: Option<&str>, program: &Program) -> CommandBuilder {
    // In remote workspaces the program runs on the remote (e.g. a debugger's `runInTerminal`).
    if let Some((host, dir)) = cwd.and_then(crate::remote::parse) {
        let mut cmd = CommandBuilder::new("ssh");
        cmd.args(["-t", host, &remote_program_line(&dir, program)]);
        return cmd;
    }
    if let Some((distro, dir)) = cwd.and_then(crate::wsl::parse_share) {
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.args(["-d", &distro, "--exec", "sh", "-c", &remote_program_line(&dir, program)]);
        return cmd;
    }
    let mut cmd = CommandBuilder::new(&program.command);
    cmd.args(&program.args);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    for (key, value) in &program.env {
        match value {
            Some(value) => cmd.env(key, value),
            None => cmd.env_remove(key),
        }
    }
    cmd
}

fn shell_command(cwd: Option<&str>, profile: Option<&str>) -> CommandBuilder {
    if let Some((host, dir)) = cwd.and_then(crate::remote::parse) {
        let mut cmd = CommandBuilder::new("ssh");
        // A real TTY, so passwords and interactive programs work as in any terminal.
        let start = format!("cd {} 2>/dev/null; exec \"$SHELL\" -l", crate::remote::quote(&dir));
        cmd.args(["-t", host, &start]);
        return cmd;
    }
    if let Some((distro, dir)) = cwd.and_then(crate::wsl::parse_share) {
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.args(["-d", &distro, "--cd", &dir]);
        return cmd;
    }
    let mut cmd = crate::profiles::resolve(profile).map_or_else(local_shell, |p| p.command());
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd
}

fn local_shell() -> CommandBuilder {
    if cfg!(windows) {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        cmd
    } else {
        // The user's login shell from $SHELL, so PATH matches a regular terminal.
        CommandBuilder::new_default_prog()
    }
}

/// Drains the longest valid UTF-8 prefix from `pending`, keeping an incomplete
/// trailing sequence for the next read.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => {
            let text = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            return text;
        }
    };
    let rest = pending.split_off(valid);
    let text = std::mem::replace(pending, rest);
    String::from_utf8(text).unwrap_or_default()
}

#[tauri::command(async)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Terminals>,
    cwd: Option<String>,
    profile: Option<String>,
    cols: u16,
    rows: u16,
    program: Option<Program>,
    on_event: Channel<TerminalEvent>,
) -> CmdResult<u32> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;

    let mut cmd = match &program {
        Some(program) => program_command(cwd.as_deref(), program),
        None => shell_command(cwd.as_deref(), profile.as_deref()),
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let killer = child.clone_killer();

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.lock().map_err(err)?.insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    let output = on_event.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() && output.send(TerminalEvent::Output(text)).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // On Windows the ConPTY reader only ends once the master is dropped, so the
    // session is torn down when the child exits rather than on reader EOF.
    std::thread::spawn(move || {
        let _ = child.wait();
        if let Ok(mut sessions) = app.state::<Terminals>().sessions.lock() {
            sessions.remove(&id);
        }
        let _ = on_event.send(TerminalEvent::Exit);
    });

    Ok(id)
}

#[tauri::command(async)]
pub fn terminal_write(state: State<'_, Terminals>, id: u32, data: String) -> CmdResult<()> {
    let mut sessions = state.sessions.lock().map_err(err)?;
    let session = sessions.get_mut(&id).ok_or("Terminal not found.")?;
    session.writer.write_all(data.as_bytes()).map_err(err)?;
    session.writer.flush().map_err(err)
}

#[tauri::command(async)]
pub fn terminal_resize(state: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> CmdResult<()> {
    let sessions = state.sessions.lock().map_err(err)?;
    let session = sessions.get(&id).ok_or("Terminal not found.")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)
}

#[tauri::command(async)]
pub fn terminal_kill(state: State<'_, Terminals>, id: u32) -> CmdResult<()> {
    if let Some(mut session) = state.sessions.lock().map_err(err)?.remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_programs_run_as_quoted_shell_lines() {
        let program = Program {
            command: "python3".into(),
            args: vec!["-m".into(), "debugpy".into(), "it's.py".into()],
            env: HashMap::from([("PYTHONUNBUFFERED".to_string(), Some("1".to_string()))]),
        };
        assert_eq!(
            remote_program_line("/home/me/my app", &program),
            r"cd '/home/me/my app' && exec env 'PYTHONUNBUFFERED=1' 'python3' '-m' 'debugpy' 'it'\''s.py'"
        );
    }
}
