//! SSH workspaces. Paths look like `ssh://<host>/<absolute path>`, where
//! `<host>` is an alias or host name the system `ssh` understands, so the
//! user's `~/.ssh/config`, agent, keys and known hosts all apply.
//!
//! Each host gets one long-lived `ssh <host> sh` process. Commands are sent to
//! that remote shell with their output base64-encoded and followed by an end
//! marker carrying the exit status, which keeps binary content and arbitrary
//! output intact over the pipe.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::error::{err, CmdResult};

const SCHEME: &str = "ssh://";
const WSL_SESSION_PREFIX: &str = "wsl:";

/// The session name of a WSL distribution (sessions of SSH hosts are named by the host).
pub fn wsl_session(distro: &str) -> String {
    format!("{WSL_SESSION_PREFIX}{distro}")
}

/// Splits `ssh://host/path` into the host and the remote absolute path.
pub fn parse(path: &str) -> Option<(&str, String)> {
    let rest = path.strip_prefix(SCHEME)?;
    let (host, remote) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    (!host.is_empty()).then(|| (host, format!("/{remote}")))
}

pub fn join(host: &str, remote: &str) -> String {
    format!("{SCHEME}{host}{}", if remote.starts_with('/') { remote.to_string() } else { format!("/{remote}") })
}

/// Quotes `s` for a POSIX shell.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn ssh_command() -> Command {
    let mut cmd = Command::new("ssh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

pub struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: Arc<Mutex<String>>,
    next: u64,
}

impl Session {
    fn connect(host: &str) -> CmdResult<Self> {
        // A WSL distribution: one long-lived shell instead of a `wsl.exe` per command
        // (each costs ~200 ms), used for git, the file index and search in WSL folders.
        if let Some(distro) = host.strip_prefix(WSL_SESSION_PREFIX) {
            return Self::start(crate::wsl::command(distro, "/", "sh"), &format!("WSL: {distro}"));
        }
        let mut ssh = ssh_command();
        ssh.args([
            "-T",
            // Fail instead of prompting: there is no terminal to type a password into.
            "-o",
            "BatchMode=yes",
            // Trust a host on first contact, but still refuse a changed key.
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=30",
            host,
            "sh",
        ]);
        Self::start(ssh, host)
    }

    /// Starts the protocol over `command`, a process running a POSIX shell on its stdin.
    fn start(mut command: Command, host: &str) -> CmdResult<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "OpenSSH (ssh) is not installed or not on PATH.".to_string()
                } else {
                    e.to_string()
                }
            })?;

        let stderr = Arc::new(Mutex::new(String::new()));
        let mut pipe = BufReader::new(child.stderr.take().ok_or("No stderr")?);
        let sink = stderr.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            while pipe.read_line(&mut line).unwrap_or(0) > 0 {
                if let Ok(mut s) = sink.lock() {
                    s.push_str(&line);
                }
                line.clear();
            }
        });

        let mut session = Session {
            stdin: child.stdin.take().ok_or("No stdin")?,
            stdout: BufReader::new(child.stdout.take().ok_or("No stdout")?),
            child,
            stderr,
            next: 0,
        };
        // A file for each command's exit status, which a pipeline would otherwise hide.
        session.send("PC_RC=$(mktemp 2>/dev/null || echo /tmp/powercode-rc-$$)\n")?;
        session.exec("true").map_err(|e| {
            if e.is_empty() {
                format!("Could not connect to {host}.")
            } else {
                format!("Could not connect to {host}:\n{e}")
            }
        })?;
        Ok(session)
    }

    fn send(&mut self, text: &str) -> CmdResult<()> {
        self.stdin.write_all(text.as_bytes()).map_err(err)?;
        self.stdin.flush().map_err(err)
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn connection_error(&self) -> String {
        let stderr = self.stderr.lock().map(|s| s.trim().to_string()).unwrap_or_default();
        if stderr.is_empty() { "The SSH connection was closed.".into() } else { stderr }
    }

    /// Runs `script` in the remote shell; returns its output, or its output as
    /// the error when it exits with a non-zero status.
    pub fn exec(&mut self, script: &str) -> CmdResult<Vec<u8>> {
        self.next += 1;
        let marker = format!("__PC_END_{}__", self.next);
        // The command's stdin is /dev/null so it cannot swallow later commands;
        // heredocs inside `script` still provide their own input.
        let wrapped = format!(
            "{{ {{ {script}\n}} </dev/null 2>&1; echo $? > \"$PC_RC\"; }} | base64; printf '\\n%s %s\\n' {marker} \"$(cat \"$PC_RC\")\"\n"
        );
        if self.send(&wrapped).is_err() {
            return Err(self.connection_error());
        }

        let mut encoded = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            if self.stdout.read_line(&mut line).map_err(err)? == 0 {
                return Err(self.connection_error());
            }
            let trimmed = line.trim_end();
            if let Some(status) = trimmed.strip_prefix(&marker) {
                let output = BASE64.decode(encoded.as_bytes()).map_err(err)?;
                return match status.trim() {
                    "0" => Ok(output),
                    _ => Err(String::from_utf8_lossy(&output).trim().to_string()),
                };
            }
            encoded.push_str(trimmed);
        }
    }

}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// The SSH sessions, one per host. Clones share them (see `shared`).
#[derive(Default, Clone)]
pub struct Remotes {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
}

/// The app's sessions, for code that runs outside a Tauri command (e.g. git).
pub fn shared() -> Remotes {
    static SHARED: std::sync::OnceLock<Remotes> = std::sync::OnceLock::new();
    SHARED.get_or_init(Remotes::default).clone()
}

impl Remotes {
    /// Runs `script` on `host`, blocking; for callers already off the async runtime.
    pub fn exec_blocking(&self, host: &str, script: &str) -> CmdResult<Vec<u8>> {
        let session = self.session_blocking(host)?;
        let mut session = session.lock().map_err(err)?;
        session.exec(script)
    }

    fn session_blocking(&self, host: &str) -> CmdResult<Arc<Mutex<Session>>> {
        let existing = self.sessions.lock().map_err(err)?.get(host).cloned();
        if let Some(session) = existing {
            if session.lock().map(|mut s| s.alive()).unwrap_or(false) {
                return Ok(session);
            }
        }
        let session = Arc::new(Mutex::new(Session::connect(host)?));
        self.sessions.lock().map_err(err)?.insert(host.to_string(), session.clone());
        Ok(session)
    }

    /// Runs `script` on `host` off the async runtime, connecting (or reconnecting) as needed.
    pub async fn exec(remotes: &Remotes, host: &str, script: String) -> CmdResult<Vec<u8>> {
        let session = remotes.session_async(host).await?;
        tauri::async_runtime::spawn_blocking(move || session.lock().map_err(err)?.exec(&script))
            .await
            .map_err(err)?
    }

    async fn session_async(&self, host: &str) -> CmdResult<Arc<Mutex<Session>>> {
        // Connecting blocks on the network, so it must not run on an async worker.
        let existing = self.sessions.lock().map_err(err)?.get(host).cloned();
        if let Some(session) = existing {
            let alive = tauri::async_runtime::spawn_blocking({
                let session = session.clone();
                move || session.lock().map(|mut s| s.alive()).unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            if alive {
                return Ok(session);
            }
        }
        let host_owned = host.to_string();
        let session = tauri::async_runtime::spawn_blocking(move || Session::connect(&host_owned))
            .await
            .map_err(err)??;
        let session = Arc::new(Mutex::new(session));
        self.sessions.lock().map_err(err)?.insert(host.to_string(), session.clone());
        Ok(session)
    }
}

// ---- File operations ------------------------------------------------------

pub async fn list_dir(remotes: &Remotes, host: &str, dir: &str) -> CmdResult<Vec<(String, bool)>> {
    // `*`, `.[!.]*` and `..?*` together match every entry but `.` and `..`.
    let script = format!(
        "cd -- {} && for f in * .[!.]* ..?*; do if [ -d \"$f\" ]; then printf 'd/%s\\n' \"$f\"; elif [ -e \"$f\" ] || [ -L \"$f\" ]; then printf 'f/%s\\n' \"$f\"; fi; done",
        quote(dir)
    );
    let output = String::from_utf8_lossy(&Remotes::exec(remotes, host, script).await?).into_owned();
    Ok(output
        .lines()
        .filter_map(|line| {
            let (kind, name) = line.split_once('/')?;
            Some((name.to_string(), kind == "d"))
        })
        .collect())
}

pub async fn read_file(remotes: &Remotes, host: &str, path: &str) -> CmdResult<Vec<u8>> {
    Remotes::exec(remotes, host, format!("cat -- {}", quote(path))).await
}

pub async fn write_file(remotes: &Remotes, host: &str, path: &str, contents: &[u8]) -> CmdResult<()> {
    let encoded = BASE64.encode(contents);
    // Wrapped like `base64` output, so no line gets unreasonably long.
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect();
    let script = format!("base64 -d > {} <<'__PC_EOF__'\n{}\n__PC_EOF__", quote(path), lines.join("\n"));
    Remotes::exec(remotes, host, script).await.map(drop)
}

fn exists_guard(path: &str) -> String {
    format!("if [ -e {p} ] || [ -L {p} ]; then echo {msg} >&2; false; else ", p = quote(path), msg = quote(&format!("'{path}' already exists.")))
}

pub async fn create_file(remotes: &Remotes, host: &str, path: &str) -> CmdResult<()> {
    let script = format!("{}mkdir -p -- \"$(dirname -- {p})\" && : > {p}; fi", exists_guard(path), p = quote(path));
    Remotes::exec(remotes, host, script).await.map(drop)
}

pub async fn create_dir(remotes: &Remotes, host: &str, path: &str) -> CmdResult<()> {
    let script = format!("{}mkdir -p -- {}; fi", exists_guard(path), quote(path));
    Remotes::exec(remotes, host, script).await.map(drop)
}

pub async fn rename(remotes: &Remotes, host: &str, from: &str, to: &str) -> CmdResult<()> {
    let script = format!("{}mv -- {} {}; fi", exists_guard(to), quote(from), quote(to));
    Remotes::exec(remotes, host, script).await.map(drop)
}

/// Remote hosts have no trash; the entry is deleted for good.
pub async fn delete(remotes: &Remotes, host: &str, path: &str) -> CmdResult<()> {
    Remotes::exec(remotes, host, format!("rm -rf -- {}", quote(path))).await.map(drop)
}

/// Files under `root`, relative to it: tracked and untracked-but-not-ignored
/// files in a Git repository, otherwise everything outside `.git` and `node_modules`.
pub async fn list_files(remotes: &Remotes, host: &str, root: &str, limit: usize) -> CmdResult<Vec<String>> {
    let script = format!(
        "cd -- {} && {{ git ls-files -co --exclude-standard 2>/dev/null || find . -type f ! -path '*/.git/*' ! -path '*/node_modules/*' | sed 's|^\\./||'; }} | head -n {limit}",
        quote(root)
    );
    let output = String::from_utf8_lossy(&Remotes::exec(remotes, host, script).await?).into_owned();
    Ok(output.lines().filter(|l| !l.is_empty()).map(String::from).collect())
}

pub async fn home(remotes: &Remotes, host: &str) -> CmdResult<String> {
    let output = Remotes::exec(remotes, host, "printf %s \"$HOME\"".into()).await?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

// ---- Hosts ----------------------------------------------------------------

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    alias: String,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHosts {
    ssh: Vec<SshHost>,
    wsl: Vec<String>,
    ssh_config: String,
}

fn ssh_config_path() -> CmdResult<std::path::PathBuf> {
    Ok(dirs::home_dir().ok_or("No home directory.")?.join(".ssh").join("config"))
}

/// Concrete `Host` entries of an ssh config (patterns like `*` are skipped).
fn parse_ssh_config(text: &str) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once(|c: char| c.is_whitespace() || c == '=')
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim_start_matches([' ', '\t', '=']).trim().to_string()))
            .unwrap_or((line.to_ascii_lowercase(), String::new()));
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    current.push(hosts.len());
                    hosts.push(SshHost { alias: alias.to_string(), ..Default::default() });
                }
            }
            "match" => current.clear(),
            "hostname" => current.iter().for_each(|&i| hosts[i].host_name = Some(value.clone())),
            "user" => current.iter().for_each(|&i| hosts[i].user = Some(value.clone())),
            "port" => current.iter().for_each(|&i| hosts[i].port = Some(value.clone())),
            _ => {}
        }
    }
    hosts
}

#[tauri::command]
pub async fn remote_hosts() -> CmdResult<RemoteHosts> {
    tauri::async_runtime::spawn_blocking(|| {
        let config = ssh_config_path()?;
        let ssh = std::fs::read_to_string(&config).map(|t| parse_ssh_config(&t)).unwrap_or_default();
        Ok(RemoteHosts {
            ssh,
            wsl: crate::wsl::distributions(),
            ssh_config: config.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(err)?
}

fn valid_value(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\n', '\r'])
}

/// Appends a `Host` entry to `~/.ssh/config`, so the host also works from any terminal.
#[tauri::command(async)]
pub fn remote_add_ssh_host(
    alias: String,
    host_name: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
) -> CmdResult<()> {
    if !valid_value(&alias) || alias.contains(char::is_whitespace) || alias.contains(['*', '?', '/']) {
        return Err("The host name may not contain spaces, '/', '*' or '?'.".into());
    }
    if !valid_value(&host_name) {
        return Err("Enter the server's address.".into());
    }
    let path = ssh_config_path()?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if parse_ssh_config(&existing).iter().any(|h| h.alias == alias) {
        return Err(format!("A host named '{alias}' already exists."));
    }

    let mut entry = format!("\nHost {alias}\n    HostName {host_name}\n");
    if let Some(user) = user.filter(|u| valid_value(u)) {
        entry.push_str(&format!("    User {user}\n"));
    }
    if let Some(port) = port {
        entry.push_str(&format!("    Port {port}\n"));
    }
    if let Some(identity) = identity_file.filter(|i| valid_value(i)) {
        // Quoted, as Windows paths often contain spaces.
        entry.push_str(&format!("    IdentityFile \"{identity}\"\n"));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&path, format!("{existing}{separator}{entry}")).map_err(err)
}

/// Ends the host's SSH session; dropping it kills the `ssh` process. The next
/// file operation on the host would connect again.
#[tauri::command(async)]
pub fn remote_disconnect(remotes: State<'_, Remotes>, host: String) -> CmdResult<()> {
    remotes.sessions.lock().map_err(err)?.remove(&host);
    Ok(())
}

/// The folder to suggest when opening a host: the remote user's home.
#[tauri::command]
pub async fn remote_home(remotes: State<'_, Remotes>, kind: String, target: String) -> CmdResult<String> {
    match kind.as_str() {
        "ssh" => Ok(join(&target, &home(&remotes, &target).await?)),
        "wsl" => tauri::async_runtime::spawn_blocking(move || crate::wsl::home(&target)).await.map_err(err)?,
        _ => Err(format!("Unknown remote kind: {kind}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_paths() {
        assert_eq!(parse("ssh://box/home/me/proj"), Some(("box", "/home/me/proj".into())));
        assert_eq!(parse("ssh://box"), Some(("box", "/".into())));
        assert_eq!(parse("ssh:///x"), None);
        assert_eq!(parse("/home/me"), None);
        assert_eq!(join("box", "/srv"), "ssh://box/srv");
    }

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(quote("it's here"), r"'it'\''s here'");
    }

    #[test]
    fn parses_hosts_from_ssh_config() {
        let config = "Host *\n  ForwardAgent yes\n\nHost web web2\n  HostName 10.0.0.5\n  User deploy\n  Port=2222\n# comment\nHost db\n    hostname db.example.com\n";
        let hosts = parse_ssh_config(config);
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, vec!["web", "web2", "db"]);
        assert_eq!(hosts[1].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[0].port.as_deref(), Some("2222"));
        assert_eq!(hosts[2].host_name.as_deref(), Some("db.example.com"));
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    /// The protocol only needs a POSIX shell, so a local `sh` stands in for the SSH host.
    fn local_session() -> Option<Session> {
        let probe = Command::new("sh").args(["-c", "command -v base64 && command -v mktemp"]).output().ok()?;
        if !probe.status.success() {
            return None;
        }
        Some(Session::start(Command::new("sh"), "local").expect("local session"))
    }

    #[test]
    fn runs_commands_and_round_trips_files() {
        let Some(mut session) = local_session() else {
            eprintln!("skipped: no POSIX sh with base64 available");
            return;
        };
        assert_eq!(session.exec("printf 'a\nb'").unwrap(), b"a\nb");
        // A failing command reports its output as the error, and the session survives it.
        assert!(session.exec("echo nope >&2; false").unwrap_err().contains("nope"));
        // `cat` without arguments must not swallow the commands that follow.
        assert_eq!(session.exec("cat").unwrap(), b"");

        let dir = session.exec("mktemp -d").map(|o| String::from_utf8(o).unwrap().trim().to_string()).unwrap();
        let file = format!("{dir}/it's a file.txt");
        // Content with a trailing newline, NUL, quotes and a line that looks like the heredoc end.
        let content = b"line 1\n__PC_EOF__\n'quoted' \"double\" $HOME\0end\n\n".to_vec();
        let encoded = BASE64.encode(&content);
        let lines: Vec<&str> = encoded.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect();
        session
            .exec(&format!("base64 -d > {} <<'__PC_EOF__'\n{}\n__PC_EOF__", quote(&file), lines.join("\n")))
            .unwrap();
        assert_eq!(session.exec(&format!("cat -- {}", quote(&file))).unwrap(), content);

        let guard = format!("{}mkdir -p -- {}; fi", exists_guard(&file), quote(&file));
        assert!(session.exec(&guard).unwrap_err().contains("already exists"));

        session.exec(&format!("mkdir -- {}/.hidden {}/sub", quote(&dir), quote(&dir))).unwrap();
        let listing = String::from_utf8(
            session
                .exec(&format!(
                    "cd -- {} && for f in * .[!.]* ..?*; do if [ -d \"$f\" ]; then printf 'd/%s\n' \"$f\"; elif [ -e \"$f\" ] || [ -L \"$f\" ]; then printf 'f/%s\n' \"$f\"; fi; done",
                    quote(&dir)
                ))
                .unwrap(),
        )
        .unwrap();
        let mut entries: Vec<&str> = listing.lines().collect();
        entries.sort();
        assert_eq!(entries, vec!["d/.hidden", "d/sub", "f/it's a file.txt"]);

        session.exec(&format!("rm -rf -- {}", quote(&dir))).unwrap();
    }

    /// Timing of the WSL session on a real project (machine-specific): `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn wsl_session_is_fast() {
        let Some(distro) = crate::wsl::distributions().into_iter().next() else { return };
        let project = "/home/daniel/deepseek-harness";
        let remotes = Remotes::default();
        let host = wsl_session(&distro);
        let started = std::time::Instant::now();
        remotes.exec_blocking(&host, "true").unwrap();
        println!("session start: {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let files = tauri::async_runtime::block_on(list_files(&remotes, &host, project, 50_000)).unwrap();
        println!("file index: {} files in {:?}", files.len(), started.elapsed());
        let started = std::time::Instant::now();
        for _ in 0..5 {
            remotes.exec_blocking(&host, &crate::git::ssh_git_script(project, &["status".into(), "--porcelain=v2".into(), "-z".into()])).unwrap();
        }
        println!("5 git status: {:?}", started.elapsed());
        assert!(!files.is_empty());
    }

    #[test]
    fn runs_git_through_the_session() {
        let Some(mut session) = local_session() else { return };
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("powercode-ssh-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let posix = dir.to_string_lossy().replace('\\', "/");
        let git = |session: &mut Session, args: &[&str]| {
            let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            session.exec(&crate::git::ssh_git_script(&posix, &args))
        };

        git(&mut session, &["init", "-q"]).unwrap();
        std::fs::write(dir.join("ünïcode file.txt"), "x").unwrap();
        // Only git's stdout comes back: `status` output, with the path unquoted.
        let status = String::from_utf8(git(&mut session, &["status", "--porcelain=v2", "-z"]).unwrap()).unwrap();
        assert_eq!(status, "? ünïcode file.txt ");
        // A failing command reports git's stderr, and the shared shell survives its `exit`.
        let error = git(&mut session, &["rev-parse", "--verify", "no-such-ref"]).unwrap_err();
        assert!(error.contains("no-such-ref") || error.contains("fatal"), "{error}");
        assert!(session.alive());
        let top = String::from_utf8(git(&mut session, &["rev-parse", "--show-toplevel"]).unwrap()).unwrap();
        assert!(!top.trim().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
