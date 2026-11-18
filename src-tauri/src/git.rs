//! Git integration through the system `git` executable, so the user's config,
//! credential helpers, SSH setup and hooks all apply.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

use crate::error::{err, CmdResult};

fn git_command(cwd: &str) -> Command {
    // In a WSL share, Linux git runs inside the distribution: it sees the files
    // natively (permissions, line endings) and uses the distribution's config.
    let mut cmd = if let Some((distro, dir)) = crate::wsl::parse_share(cwd) {
        crate::wsl::command(&distro, &dir, "git")
    } else {
        let mut cmd = Command::new("git");
        cmd.current_dir(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    };
    // `--no-optional-locks`: the status PowerCode polls must not take `.git/index.lock`,
    // or a `pull` (here or in a terminal) running at that moment fails (as in VS Code).
    // Report non-ASCII paths verbatim instead of quoting them.
    cmd.args(["--no-optional-locks", "-c", "core.quotepath=false"])
        // Never block waiting for a password on a terminal nobody sees.
        .env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// The shell script running git in `dir` on an SSH host. It runs in a subshell
/// (an `exit` must not end the shared remote shell) and keeps stderr apart, so
/// warnings never mix into the output git commands parse; on failure the
/// script prints stderr, which becomes the error.
pub(crate) fn ssh_git_script(dir: &str, args: &[String]) -> String {
    use crate::remote::quote;
    let args: Vec<String> = args.iter().map(|a| quote(a)).collect();
    format!(
        concat!(
            "(cd -- {dir} || exit 1; err=$(mktemp) || exit 1; ",
            "GIT_TERMINAL_PROMPT=0 git --no-optional-locks -c core.quotepath=false {args} 2>\"$err\"; rc=$?; ",
            "if [ $rc -ne 0 ]; then cat \"$err\"; fi; rm -f \"$err\"; exit $rc)"
        ),
        dir = quote(dir),
        args = args.join(" "),
    )
}

/// Runs git on the SSH host of `cwd` (an `ssh://host/path`), through the workspace's session.
fn run_ssh(host: &str, dir: &str, args: &[&str]) -> CmdResult<String> {
    // Arguments that are workspace paths become paths on the host.
    let args: Vec<String> = args
        .iter()
        .map(|a| crate::remote::parse(a).map_or_else(|| a.to_string(), |(_, remote)| remote))
        .collect();
    let output = crate::remote::shared().exec_blocking(host, &ssh_git_script(dir, &args))?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// Runs git and returns stdout, or stderr as the error.
fn run(cwd: &str, args: &[&str]) -> CmdResult<String> {
    if let Some((host, dir)) = crate::remote::parse(cwd) {
        return run_ssh(host, &dir, args);
    }
    // In a WSL share, git runs in the distribution's session (no `wsl.exe` start per command).
    if let Some((distro, dir)) = crate::wsl::parse_share(cwd) {
        let args: Vec<String> = args
            .iter()
            .map(|a| crate::wsl::parse_share(a).map_or_else(|| a.to_string(), |(_, linux)| linux))
            .collect();
        let output = crate::remote::shared().exec_blocking(&crate::remote::wsl_session(&distro), &ssh_git_script(&dir, &args))?;
        return Ok(String::from_utf8_lossy(&output).into_owned());
    }
    // Git inside WSL needs Linux paths for any share paths passed as arguments.
    let args: Vec<String> = match crate::wsl::parse_share(cwd) {
        Some(_) => args
            .iter()
            .map(|a| crate::wsl::parse_share(a).map_or_else(|| a.to_string(), |(_, linux)| linux))
            .collect(),
        None => args.iter().map(|a| a.to_string()).collect(),
    };
    let output = git_command(cwd).args(&args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Git is not installed or not on PATH.".to_string()
        } else {
            e.to_string()
        }
    })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if stderr.trim().is_empty() { stdout } else { stderr };
        Err(message.trim().to_string())
    }
}

/// Runs git off the async runtime; network commands can take a while.
async fn run_async(cwd: String, args: Vec<String>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&cwd, &args)
    })
    .await
    .map_err(err)?
}

/// The workspace path of `relative` (as git prints it) in the repository at `top`.
fn absolute(top: &str, relative: &str) -> String {
    let joined = format!("{top}/{relative}");
    // SSH paths are POSIX paths on the host, whatever the local OS.
    if top.starts_with("ssh://") { joined } else { native(&joined) }
}

/// Git prints `/`-separated paths; the rest of the app uses native ones.
fn native(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// Repository roots by folder: the status polled every few seconds would otherwise
/// ask git for it each time (a second command, slow on WSL and SSH).
fn toplevels() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn toplevel(root: &str) -> CmdResult<String> {
    if let Some(top) = toplevels().lock().ok().and_then(|cache| cache.get(root).cloned()) {
        return Ok(top);
    }
    let top = find_toplevel(root)?;
    if let Ok(mut cache) = toplevels().lock() {
        cache.insert(root.to_string(), top.clone());
    }
    Ok(top)
}

/// Forgets `root`'s repository (it failed: e.g. `.git` was removed or moved).
fn forget_toplevel(root: &str) {
    if let Ok(mut cache) = toplevels().lock() {
        cache.remove(root);
    }
}

fn find_toplevel(root: &str) -> CmdResult<String> {
    let top = run(root, &["rev-parse", "--show-toplevel"])?;
    // Git inside WSL answers with a Linux path; the app uses the share path.
    if let Some((host, _)) = crate::remote::parse(root) {
        return Ok(crate::remote::join(host, top.trim()));
    }
    Ok(match crate::wsl::parse_share(root) {
        Some((distro, _)) => crate::wsl::to_share(&distro, top.trim()),
        None => native(top.trim()),
    })
}

/// `path` relative to the repository, `/`-separated, as git expects in specs.
fn repo_relative(top: &str, path: &str) -> CmdResult<String> {
    let outside = || format!("'{path}' is outside the repository.");
    if top.starts_with("ssh://") {
        let prefix = format!("{}/", top.trim_end_matches('/'));
        return path.strip_prefix(&prefix).map(str::to_string).ok_or_else(outside);
    }
    if cfg!(windows) {
        // Windows paths are case-insensitive; the UI and git may disagree on case.
        let prefix = top.trim_end_matches('\\');
        let matches = path.len() > prefix.len()
            && path.is_char_boundary(prefix.len())
            && path[..prefix.len()].eq_ignore_ascii_case(prefix)
            && path[prefix.len()..].starts_with('\\');
        if !matches {
            return Err(outside());
        }
        return Ok(path[prefix.len() + 1..].replace('\\', "/"));
    }
    let relative = Path::new(path).strip_prefix(top).map_err(|_| outside())?;
    Ok(relative.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    /// Index (staged) status letter, e.g. `M`, `A`, `D`, `R`; empty when unchanged.
    index: String,
    /// Working tree status letter; empty when unchanged.
    worktree: String,
    untracked: bool,
    ignored: bool,
    conflicted: bool,
    orig_path: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    is_repo: bool,
    top: Option<String>,
    /// Commit id of HEAD; None before the first commit.
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    files: Vec<GitFile>,
}

fn status_letter(c: char) -> String {
    if c == '.' { String::new() } else { c.to_string() }
}

/// Parses `git status --porcelain=v2 --branch -z`.
fn parse_status(top: &str, output: &str) -> GitStatus {
    let mut status = GitStatus {
        is_repo: true,
        top: Some(top.to_string()),
        ..Default::default()
    };
    let absolute = |p: &str| absolute(top, p.trim_end_matches('/'));
    let mut records = output.split('\0').filter(|r| !r.is_empty());

    while let Some(record) = records.next() {
        let (kind, rest) = record.split_once(' ').unwrap_or((record, ""));
        match kind {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                    "branch.head" if value == "(detached)" => status.detached = true,
                    "branch.head" => status.branch = Some(value.to_string()),
                    "branch.upstream" => status.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        for part in value.split(' ') {
                            if let Some(n) = part.strip_prefix('+') {
                                status.ahead = n.parse().unwrap_or(0);
                            } else if let Some(n) = part.strip_prefix('-') {
                                status.behind = n.parse().unwrap_or(0);
                            }
                        }
                    }
                    _ => {}
                }
            }
            // Ordinary, renamed/copied and unmerged entries; the path is the last field.
            "1" | "2" | "u" => {
                let fields = match kind {
                    "1" => 8,
                    "2" => 9,
                    _ => 10,
                };
                let parts: Vec<&str> = rest.splitn(fields, ' ').collect();
                let Some(path) = parts.last() else { continue };
                let xy: Vec<char> = parts[0].chars().collect();
                let orig_path = if kind == "2" { records.next().map(absolute) } else { None };
                status.files.push(GitFile {
                    path: absolute(path),
                    index: status_letter(xy[0]),
                    worktree: status_letter(xy[1]),
                    untracked: false,
                    ignored: false,
                    conflicted: kind == "u",
                    orig_path,
                });
            }
            "?" | "!" => status.files.push(GitFile {
                path: absolute(rest),
                index: String::new(),
                worktree: String::new(),
                untracked: kind == "?",
                ignored: kind == "!",
                conflicted: false,
                orig_path: None,
            }),
            _ => {}
        }
    }
    status
}

#[tauri::command]
pub async fn git_status(root: String) -> CmdResult<GitStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(top) = toplevel(&root) else {
            return Ok(GitStatus::default());
        };
        let status = run(
            &top,
            &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored"],
        );
        match status {
            Ok(output) => Ok(parse_status(&top, &output)),
            Err(e) => {
                forget_toplevel(&root);
                Err(e)
            }
        }
    })
    .await
    .map_err(err)?
}

/// The file as of HEAD, or None when it is not in HEAD (new file, no commits).
#[tauri::command]
pub async fn git_show_head(root: String, path: String) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let top = toplevel(&root)?;
        let spec = format!("HEAD:{}", repo_relative(&top, &path)?);
        Ok(run(&top, &["show", &spec]).ok())
    })
    .await
    .map_err(err)?
}

async fn run_on_paths(root: String, base: &[&str], paths: Vec<String>) -> CmdResult<String> {
    let mut args: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    args.push("--".into());
    args.extend(paths);
    run_async(root, args).await
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> CmdResult<String> {
    run_on_paths(root, &["add", "-A"], paths).await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> CmdResult<String> {
    match run_on_paths(root.clone(), &["restore", "--staged"], paths.clone()).await {
        Ok(out) => Ok(out),
        // Before the first commit there is no HEAD to restore from.
        Err(_) => run_on_paths(root, &["rm", "--cached", "-r", "-q"], paths).await,
    }
}

/// Reverts tracked files to their staged/committed content.
#[tauri::command]
pub async fn git_discard(root: String, paths: Vec<String>) -> CmdResult<String> {
    run_on_paths(root, &["restore", "--worktree"], paths).await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> CmdResult<String> {
    let mut args = vec!["commit".to_string()];
    if amend {
        args.push("--amend".into());
    }
    if message.trim().is_empty() && amend {
        // Amending without a new message keeps the previous one.
        args.push("--no-edit".into());
    } else {
        args.extend(["-m".into(), message]);
    }
    run_async(root, args).await
}

#[tauri::command]
pub async fn git_init(root: String) -> CmdResult<String> {
    // The folder may have been inside another repository until now.
    forget_toplevel(&root);
    run_async(root, vec!["init".into()]).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    remote: bool,
    current: bool,
    upstream: Option<String>,
}

#[tauri::command]
pub async fn git_branches(root: String) -> CmdResult<Vec<GitBranch>> {
    let output = run_async(
        root,
        vec![
            "for-each-ref".into(),
            "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
    )
    .await?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let (full, short, head, upstream) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            // `origin/HEAD` is an alias, not a branch.
            if full.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch {
                name: short.to_string(),
                remote: full.starts_with("refs/remotes/"),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn git_checkout(root: String, branch: String, remote: bool) -> CmdResult<String> {
    if remote {
        // `origin/feature` -> local `feature` tracking it, or the existing local one.
        let local = branch.split_once('/').map_or(branch.as_str(), |(_, b)| b).to_string();
        let exists = run_async(
            root.clone(),
            vec!["rev-parse".into(), "--verify".into(), "--quiet".into(), format!("refs/heads/{local}")],
        )
        .await
        .is_ok();
        if exists {
            return run_async(root, vec!["switch".into(), local]).await;
        }
        return run_async(root, vec!["switch".into(), "--track".into(), branch]).await;
    }
    run_async(root, vec!["switch".into(), branch]).await
}

#[tauri::command]
pub async fn git_create_branch(root: String, name: String, start: Option<String>) -> CmdResult<String> {
    if let Some(start) = &start {
        check_revision(start)?;
    }
    let mut args = vec!["switch".to_string(), "-c".into(), name];
    args.extend(start);
    run_async(root, args).await
}

#[tauri::command]
pub async fn git_fetch(root: String) -> CmdResult<String> {
    run_async(root, vec!["fetch".into(), "--all".into(), "--prune".into()]).await
}

#[tauri::command]
pub async fn git_pull(root: String) -> CmdResult<String> {
    run_async(root, vec!["pull".into(), "--no-edit".into()]).await
}

/// Pushes the current branch, setting its upstream on the first push.
#[tauri::command]
pub async fn git_push(root: String) -> CmdResult<String> {
    let has_upstream = run_async(
        root.clone(),
        vec!["rev-parse".into(), "--abbrev-ref".into(), "@{upstream}".into()],
    )
    .await
    .is_ok();
    if has_upstream {
        return run_async(root, vec!["push".into()]).await;
    }
    let remotes = run_async(root.clone(), vec!["remote".into()]).await?;
    let remote = remotes
        .lines()
        .next()
        .ok_or("This repository has no remote to push to.")?
        .to_string();
    run_async(root, vec!["push".into(), "-u".into(), remote, "HEAD".into()]).await
}

/// Field and record separators for `git log --format`; they cannot occur in commit text.
const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    /// Author date, seconds since the Unix epoch.
    date: i64,
    subject: String,
    /// Branch and tag names pointing at the commit, e.g. `HEAD -> main`, `origin/main`, `tag: v1`.
    refs: Vec<String>,
}

/// Revisions come from the UI; one starting with `-` would be read as an option.
fn check_revision(revision: &str) -> CmdResult<()> {
    if revision.is_empty() || revision.starts_with('-') {
        Err(format!("Invalid revision: {revision}"))
    } else {
        Ok(())
    }
}

fn parse_log(output: &str) -> Vec<GitCommit> {
    output
        .split(RECORD)
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.split(FIELD);
            let hash = f.next()?.to_string();
            let parents = f.next()?.split(' ').filter(|p| !p.is_empty()).map(String::from).collect();
            let author = f.next()?.to_string();
            let email = f.next()?.to_string();
            let date = f.next()?.parse().unwrap_or(0);
            let refs = f.next()?.split(", ").filter(|r| !r.is_empty()).map(String::from).collect();
            let subject = f.next()?.to_string();
            Some(GitCommit { hash, parents, author, email, date, subject, refs })
        })
        .collect()
}

/// A page of history in topological order; `revision` is a branch name, or None for all branches.
#[tauri::command]
pub async fn git_log(root: String, revision: Option<String>, skip: u32, limit: u32) -> CmdResult<Vec<GitCommit>> {
    let format = format!("--format=%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%D{FIELD}%s{RECORD}");
    let mut args = vec![
        "log".to_string(),
        format,
        "--topo-order".into(),
        format!("--skip={skip}"),
        format!("--max-count={limit}"),
    ];
    match revision {
        Some(rev) => {
            check_revision(&rev)?;
            args.push(rev);
        }
        None => args.push("--all".into()),
    }
    args.push("--".into());
    match run_async(root, args).await {
        Ok(output) => Ok(parse_log(&output)),
        // A repository without commits has no history to show.
        Err(e) if e.contains("does not have any commits") || e.contains("unknown revision") => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    /// Full message, including the body.
    message: String,
    files: Vec<CommitFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    path: String,
    /// `A`, `M`, `D`, `R`, `C` or `T`.
    status: String,
    orig_path: Option<String>,
}

/// Parses `git diff-tree --name-status -z` output.
fn parse_name_status(top: &str, output: &str) -> Vec<CommitFile> {
    let absolute = |p: &str| absolute(top, p);
    let mut fields = output.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M').to_string();
        // Renames and copies list the old path, then the new one.
        let (orig_path, path) = if letter == "R" || letter == "C" {
            let from = fields.next().map(absolute);
            (from, fields.next())
        } else {
            (None, fields.next())
        };
        if let Some(path) = path {
            files.push(CommitFile { path: absolute(path), status: letter, orig_path });
        }
    }
    files
}

#[tauri::command]
pub async fn git_commit_details(root: String, hash: String) -> CmdResult<CommitDetails> {
    check_revision(&hash)?;
    tauri::async_runtime::spawn_blocking(move || {
        let top = toplevel(&root)?;
        let message = run(&top, &["show", "-s", "--format=%B", &hash])?;
        // Merges are compared with their first parent, as IntelliJ shows them.
        let changes = run(
            &top,
            &["diff-tree", "-r", "-z", "-M", "--root", "--no-commit-id", "--name-status", "-m", "--first-parent", &hash],
        )?;
        Ok(CommitDetails {
            message: message.trim_end().to_string(),
            files: parse_name_status(&top, &changes),
        })
    })
    .await
    .map_err(err)?
}

/// The file at `revision` (e.g. `abc123` or `abc123^`), or None if it did not exist there.
#[tauri::command]
pub async fn git_show_at(root: String, revision: String, path: String) -> CmdResult<Option<String>> {
    check_revision(&revision)?;
    tauri::async_runtime::spawn_blocking(move || {
        let top = toplevel(&root)?;
        let spec = format!("{revision}:{}", repo_relative(&top, &path)?);
        Ok(run(&top, &["show", &spec]).ok())
    })
    .await
    .map_err(err)?
}

/// A lock younger than this may belong to a git command still running.
const LOCK_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Removes `.git/index.lock` left behind by an interrupted git command ("Another git
/// process seems to be running"). Returns false when there is none; refuses a lock
/// so recent that a git command may still be working.
#[tauri::command]
pub async fn git_remove_index_lock(root: String) -> CmdResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let git_dir = run(&root, &["rev-parse", "--absolute-git-dir"])?.trim().to_string();
        if let Some((host, _)) = crate::remote::parse(&root) {
            let lock = format!("{git_dir}/index.lock");
            let script = format!(
                "if [ -e {lock} ]; then rm -f {lock} && echo removed; fi",
                lock = crate::remote::quote(&lock)
            );
            let output = crate::remote::shared().exec_blocking(host, &script)?;
            return Ok(String::from_utf8_lossy(&output).contains("removed"));
        }
        // Git inside WSL answers with a Linux path; it is removed through the share.
        let git_dir = match crate::wsl::parse_share(&root) {
            Some((distro, _)) => crate::wsl::to_share(&distro, &git_dir),
            None => native(&git_dir),
        };
        let lock = Path::new(&git_dir).join("index.lock");
        let Ok(metadata) = std::fs::metadata(&lock) else { return Ok(false) };
        let age = metadata.modified().ok().and_then(|m| m.elapsed().ok()).unwrap_or_default();
        if age < LOCK_GRACE {
            return Err("A git command is working in this repository right now. Try again when it finishes.".into());
        }
        std::fs::remove_file(&lock).map_err(err)?;
        Ok(true)
    })
    .await
    .map_err(err)?
}

/// Checks out a commit without a branch (detached HEAD).
#[tauri::command]
pub async fn git_checkout_revision(root: String, hash: String) -> CmdResult<String> {
    check_revision(&hash)?;
    run_async(root, vec!["switch".into(), "--detach".into(), hash]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_stale_index_locks() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("powercode-lock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        run(&root, &["init", "-q"]).unwrap();
        let lock = dir.join(".git").join("index.lock");
        let remove = |root: &str| tauri::async_runtime::block_on(git_remove_index_lock(root.to_string()));

        assert_eq!(remove(&root), Ok(false), "no lock, nothing to do");
        std::fs::write(&lock, "").unwrap();
        assert!(remove(&root).is_err(), "a fresh lock may belong to a running command");
        assert!(lock.exists());
        // An old lock (as after an interrupted command) goes.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(&lock).unwrap().set_modified(old).unwrap();
        assert_eq!(remove(&root), Ok(true));
        assert!(!lock.exists());
        // Status with optional locks off never creates one.
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        run(&root, &["status", "--porcelain"]).unwrap();
        assert!(!lock.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_porcelain_v2() {
        let output = [
            "# branch.oid 1234",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 abc abc src/app file.ts",
            "1 A. N... 000000 100644 100644 000 abc new.ts",
            "2 R. N... 100644 100644 100644 abc abc R100 renamed.ts",
            "old.ts",
            "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
            "? untracked.txt",
            "! node_modules/",
        ]
        .join("\0");
        let status = parse_status("/repo", &output);

        assert_eq!(status.head.as_deref(), Some("1234"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.files.len(), 6);

        let modified = &status.files[0];
        assert_eq!(modified.path, native("/repo/src/app file.ts"));
        assert_eq!((modified.index.as_str(), modified.worktree.as_str()), ("", "M"));
        assert_eq!(status.files[1].index, "A");
        assert_eq!(status.files[2].orig_path.as_deref(), Some(native("/repo/old.ts").as_str()));
        assert!(status.files[3].conflicted);
        assert!(status.files[4].untracked);
        assert!(status.files[5].ignored);
        assert_eq!(status.files[5].path, native("/repo/node_modules"));
    }

    /// Runs the real git CLI against a throwaway repository.
    #[test]
    fn status_and_show_on_a_real_repository() {
        let dir = std::env::temp_dir().join(format!("powercode-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub dir")).unwrap();
        let root = dir.to_string_lossy().into_owned();
        run(&root, &["init", "-q"]).unwrap();
        run(&root, &["config", "user.email", "test@example.com"]).unwrap();
        run(&root, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(dir.join("sub dir").join("a.txt"), "one
").unwrap();
        run(&root, &["add", "-A"]).unwrap();
        run(&root, &["commit", "-q", "-m", "init"]).unwrap();

        std::fs::write(dir.join("sub dir").join("a.txt"), "two
").unwrap();
        std::fs::write(dir.join("new.txt"), "new").unwrap();

        let top = toplevel(&root).unwrap();
        let output = run(&top, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).unwrap();
        let status = parse_status(&top, &output);
        let modified = dir.join("sub dir").join("a.txt").to_string_lossy().into_owned();
        assert!(status.head.is_some());
        assert!(
            status.files.iter().any(|f| f.path.eq_ignore_ascii_case(&modified) && f.worktree == "M"),
            "paths: {:?}",
            status.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert!(status.files.iter().any(|f| f.untracked && f.path.ends_with("new.txt")));

        // On Windows the UI may spell the repository root with different case.
        let from_ui = if cfg!(windows) {
            format!("{}{}", modified[..top.len()].to_uppercase(), &modified[top.len()..])
        } else {
            modified.clone()
        };
        let spec = format!("HEAD:{}", repo_relative(&top, &from_ui).unwrap());
        assert_eq!(run(&top, &["show", &spec]).unwrap().trim(), "one");

        let format = format!("--format=%H{FIELD}%P{FIELD}%an{FIELD}%ae{FIELD}%at{FIELD}%D{FIELD}%s{RECORD}");
        let log = parse_log(&run(&top, &["log", &format, "--all"]).unwrap());
        assert_eq!(log.len(), 1);
        assert_eq!((log[0].subject.as_str(), log[0].author.as_str()), ("init", "Test"));
        assert!(log[0].refs.iter().any(|r| r.starts_with("HEAD -> ")));
        let changed = run(&top, &["diff-tree", "-r", "-z", "--root", "--no-commit-id", "--name-status", &log[0].hash]).unwrap();
        assert_eq!(parse_name_status(&top, &changed)[0].status, "A");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_log_records() {
        let output = format!(
            "a1{f}p1 p2{f}Ann{f}ann@x.io{f}1700000000{f}HEAD -> main, origin/main, tag: v1{f}Merge it{r}
b2{f}{f}Bob{f}b@x.io{f}1600000000{f}{f}Root, with a comma{r}
",
            f = FIELD,
            r = RECORD
        );
        let commits = parse_log(&output);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["p1", "p2"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "origin/main", "tag: v1"]);
        assert_eq!(commits[0].date, 1_700_000_000);
        assert!(commits[1].parents.is_empty() && commits[1].refs.is_empty());
        assert_eq!(commits[1].subject, "Root, with a comma");
    }

    #[test]
    fn parses_name_status() {
        let files = parse_name_status("/repo", "M src/a.ts R100 old.ts new.ts A added.ts ");
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].path, native("/repo/new.ts"));
        assert_eq!(files[1].orig_path.as_deref(), Some(native("/repo/old.ts").as_str()));
        assert_eq!(files[2].status, "A");
    }

    #[test]
    fn rejects_option_like_revisions() {
        assert!(check_revision("--output=x").is_err());
        assert!(check_revision("main").is_ok());
    }

    /// Git inside a real WSL distribution, driven through a share path.
    #[cfg(windows)]
    #[test]
    fn status_through_a_wsl_share() {
        let Some(distro) = crate::wsl::distributions().into_iter().next() else {
            eprintln!("skipped: no WSL distribution");
            return;
        };
        let mktemp = crate::wsl::command(&distro, "/", "mktemp").arg("-d").output().unwrap();
        let linux = String::from_utf8_lossy(&mktemp.stdout).trim().to_string();
        let share = crate::wsl::to_share(&distro, &linux);
        let sh = |script: &str| crate::wsl::command(&distro, &linux, "sh").args(["-c", script]).output().unwrap();
        let setup = sh("git init -q && git -c user.name=T -c user.email=t@x commit -q --allow-empty -m init && echo hi > new.txt");
        if !setup.status.success() {
            eprintln!("skipped: git unavailable in {distro}: {}", String::from_utf8_lossy(&setup.stderr));
            return;
        }

        let top = toplevel(&share).unwrap();
        assert!(top.eq_ignore_ascii_case(&share), "{top} vs {share}");
        let output = run(&share, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).unwrap();
        let status = parse_status(&top, &output);
        let new_file = format!("{share}\\new.txt");
        assert!(status.files.iter().any(|f| f.untracked && f.path == new_file), "{:?}", status.files.iter().map(|f| &f.path).collect::<Vec<_>>());

        // Share paths given as arguments reach git as Linux paths.
        run(&share, &["add", "-A", "--", &new_file]).unwrap();
        let staged = run(&share, &["diff", "--cached", "--name-only"]).unwrap();
        assert_eq!(staged.trim(), "new.txt");
        sh("cd / && rm -rf \"$OLDPWD\"");
    }

    #[test]
    fn detached_head() {

        let status = parse_status("/repo", "# branch.head (detached)\0");
        assert!(status.detached);
        assert_eq!(status.branch, None);
    }
}
