//! Terminal profiles: the shells installed on this machine, as VS Code lists
//! them in its "new terminal" menu.

use portable_pty::CommandBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    /// Stable identifier the frontend stores, e.g. `powershell` or `wsl:Ubuntu`.
    pub id: String,
    pub name: String,
    #[serde(skip)]
    program: String,
    #[serde(skip)]
    args: Vec<String>,
}

impl TerminalProfile {
    fn new(id: &str, name: &str, program: impl Into<String>, args: &[&str]) -> Self {
        TerminalProfile {
            id: id.to_string(),
            name: name.to_string(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    pub fn command(&self) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.program);
        cmd.args(&self.args);
        cmd
    }
}

/// Finds `program` on PATH.
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) { &["", ".exe"] } else { &[""] };
    std::env::split_paths(&path)
        .flat_map(|dir| extensions.iter().map(move |ext| dir.join(format!("{program}{ext}"))))
        .find(|candidate| candidate.is_file())
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

#[cfg(windows)]
fn detect() -> Vec<TerminalProfile> {
    let mut profiles = vec![TerminalProfile::new("powershell", "Windows PowerShell", "powershell.exe", &["-NoLogo"])];

    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| "C:\\Program Files".into());
    if let Some(pwsh) = which("pwsh").or_else(|| first_existing(&[program_files.join("PowerShell\\7\\pwsh.exe")])) {
        profiles.push(TerminalProfile::new("pwsh", "PowerShell", pwsh.to_string_lossy(), &["-NoLogo"]));
    }
    profiles.push(TerminalProfile::new("cmd", "Command Prompt", "cmd.exe", &[]));

    // Git Bash lives next to git: `<Git>\cmd\git.exe` -> `<Git>\bin\bash.exe`.
    let git_root = which("git").and_then(|git| git.parent()?.parent().map(Path::to_path_buf));
    let bash_candidates: Vec<PathBuf> = git_root
        .into_iter()
        .chain([program_files.join("Git")])
        .map(|root| root.join("bin\\bash.exe"))
        .collect();
    if let Some(bash) = first_existing(&bash_candidates) {
        profiles.push(TerminalProfile::new("git-bash", "Git Bash", bash.to_string_lossy(), &["--login", "-i"]));
    }

    for distro in crate::wsl::distributions() {
        profiles.push(TerminalProfile::new(&format!("wsl:{distro}"), &format!("{distro} (WSL)"), "wsl.exe", &["-d", &distro]));
    }
    profiles
}

#[cfg(not(windows))]
fn detect() -> Vec<TerminalProfile> {
    let mut shells: Vec<String> = Vec::new();
    // The login shell first: it is the natural default.
    if let Ok(shell) = std::env::var("SHELL") {
        shells.push(shell);
    }
    if let Ok(list) = std::fs::read_to_string("/etc/shells") {
        for line in list.lines().map(str::trim).filter(|l| l.starts_with('/')) {
            let name = Path::new(line).file_name().map(|n| n.to_string_lossy().into_owned());
            let duplicate = shells.iter().any(|s| Path::new(s).file_name().map(|n| n.to_string_lossy().into_owned()) == name);
            if !duplicate && Path::new(line).is_file() {
                shells.push(line.to_string());
            }
        }
    }
    shells
        .iter()
        .map(|shell| {
            let name = Path::new(shell).file_name().map_or(shell.clone(), |n| n.to_string_lossy().into_owned());
            // Login shells, so PATH matches a regular terminal.
            TerminalProfile::new(&name, &name, shell.clone(), &["-l"])
        })
        .collect()
}

/// The last detection; detecting runs `wsl.exe`, which can take a while.
static DETECTED: Mutex<Option<Vec<TerminalProfile>>> = Mutex::new(None);

fn detect_and_cache() -> Vec<TerminalProfile> {
    let profiles = detect();
    if let Ok(mut cache) = DETECTED.lock() {
        *cache = Some(profiles.clone());
    }
    profiles
}

/// Detects the profiles afresh (shells may have been installed since).
#[tauri::command]
pub async fn terminal_profiles() -> Result<Vec<TerminalProfile>, String> {
    tauri::async_runtime::spawn_blocking(detect_and_cache)
        .await
        .map_err(|e| e.to_string())
}

/// The profile with `id`, or the first (default) one, from the last detection.
pub fn resolve(id: Option<&str>) -> Option<TerminalProfile> {
    let cached = DETECTED.lock().ok().and_then(|c| c.clone());
    let profiles = cached.unwrap_or_else(detect_and_cache);
    id.and_then(|id| profiles.iter().find(|p| p.id == id).cloned())
        .or_else(|| profiles.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_shell_with_unique_ids() {
        let profiles = detect();
        for p in &profiles {
            eprintln!("{} -> {} {:?}", p.id, p.program, p.args);
        }
        assert!(!profiles.is_empty());
        let mut ids: Vec<_> = profiles.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), profiles.len());
        assert_eq!(resolve(Some("does-not-exist")).map(|p| p.id), profiles.first().map(|p| p.id.clone()));
    }
}
