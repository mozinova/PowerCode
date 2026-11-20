//! File system commands. Paths are local (including WSL shares, which Windows
//! serves like network folders) or `ssh://host/path`, routed to the SSH session.

use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::error::{err, CmdResult};
use crate::remote::{self, Remotes};

/// Files larger than this are refused by the editor to keep the UI responsive.
const MAX_TEXT_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// Entries hidden from the project tree, mirroring VS Code's default `files.exclude`.
const HIDDEN_ENTRIES: &[&str] = &[".git", ".DS_Store", "Thumbs.db"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

#[tauri::command]
pub async fn list_dir(remotes: State<'_, Remotes>, path: String) -> CmdResult<Vec<DirEntry>> {
    let mut entries: Vec<DirEntry> = if let Some((host, dir)) = remote::parse(&path) {
        remote::list_dir(&remotes, host, &dir)
            .await?
            .into_iter()
            .filter(|(name, _)| !HIDDEN_ENTRIES.contains(&name.as_str()))
            .map(|(name, is_dir)| DirEntry {
                path: remote::join(host, &format!("{}/{name}", dir.trim_end_matches('/'))),
                name,
                is_dir,
            })
            .collect()
    } else {
        std::fs::read_dir(&path)
            .map_err(err)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if HIDDEN_ENTRIES.contains(&name.as_str()) {
                    return None;
                }
                let path = entry.path();
                // `Path::is_dir` follows symlinks, unlike `DirEntry::file_type`.
                let is_dir = path.is_dir();
                Some(DirEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    is_dir,
                })
            })
            .collect()
    };
    sort_entries(&mut entries);
    Ok(entries)
}

/// Upper bound on files indexed for file search, to bound memory on huge trees.
const MAX_INDEXED_FILES: usize = 100_000;

/// Lists every file under `root` (relative paths), honouring `.gitignore`
/// files even outside git repositories.
#[tauri::command]
pub async fn list_project_files(remotes: State<'_, Remotes>, root: String) -> CmdResult<Vec<String>> {
    if let Some((host, dir)) = remote::parse(&root) {
        return remote::list_files(&remotes, host, &dir, MAX_INDEXED_FILES).await;
    }
    // Walking a WSL share takes seconds (each folder is a round trip to the distribution);
    // listed inside it, the same index takes a fraction of a second.
    if let Some((distro, dir)) = crate::wsl::parse_share(&root) {
        let files = remote::list_files(&remotes, &remote::wsl_session(&distro), &dir, MAX_INDEXED_FILES).await?;
        return Ok(files.into_iter().map(|f| f.replace('/', "\\")).collect());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let walker = ignore::WalkBuilder::new(&root)
            .hidden(false)
            .require_git(false)
            .filter_entry(|entry| {
                !HIDDEN_ENTRIES.contains(&entry.file_name().to_string_lossy().as_ref())
            })
            .build();

        let mut files = Vec::new();
        for entry in walker.filter_map(Result::ok) {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Ok(relative) = entry.path().strip_prefix(&root) {
                files.push(relative.to_string_lossy().into_owned());
                if files.len() >= MAX_INDEXED_FILES {
                    break;
                }
            }
        }
        files
    })
    .await
    .map_err(err)
}

fn decode_text(bytes: Vec<u8>) -> CmdResult<String> {
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(format!("File is too large ({} MB).", bytes.len() / (1024 * 1024)));
    }
    String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text.".to_string())
}

#[tauri::command]
pub async fn read_text_file(remotes: State<'_, Remotes>, path: String) -> CmdResult<String> {
    if let Some((host, file)) = remote::parse(&path) {
        return decode_text(remote::read_file(&remotes, host, &file).await?);
    }
    let size = std::fs::metadata(&path).map_err(err)?.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err(format!("File is too large ({} MB).", size / (1024 * 1024)));
    }
    decode_text(std::fs::read(&path).map_err(err)?)
}

/// The error of a save refused because the file changed on disk since it was read.
pub const FILE_CHANGED: &str = "PC_FILE_CHANGED";

/// Writes a text file and returns its new change signature (see `fs_signatures`).
/// With `expected` (the signature when the editor read or last wrote it), the write
/// is refused with `FILE_CHANGED` if the file changed since (an AI agent, `git`,
/// another editor), instead of overwriting that change.
#[tauri::command]
pub async fn write_text_file(
    remotes: State<'_, Remotes>,
    path: String,
    contents: String,
    expected: Option<String>,
) -> CmdResult<Option<String>> {
    write_checked(&remotes, path, contents, expected).await
}

async fn write_checked(remotes: &Remotes, path: String, contents: String, expected: Option<String>) -> CmdResult<Option<String>> {
    if let Some(expected) = expected {
        let current = signatures(remotes, vec![path.clone()]).await?.pop().flatten();
        // A file deleted meanwhile is written again, as VS Code does.
        if current.is_some_and(|current| current != expected) {
            return Err(FILE_CHANGED.to_string());
        }
    }
    if let Some((host, file)) = remote::parse(&path) {
        remote::write_file(remotes, host, &file, contents.as_bytes()).await?;
    } else {
        let target = path.clone();
        tauri::async_runtime::spawn_blocking(move || std::fs::write(Path::new(&target), contents))
            .await
            .map_err(err)?
            .map_err(err)?;
    }
    Ok(signatures(remotes, vec![path]).await?.pop().flatten())
}

fn ensure_absent(path: &Path) -> CmdResult<()> {
    if path.exists() {
        Err(format!("'{}' already exists.", path.display()))
    } else {
        Ok(())
    }
}

/// Creates an empty file, along with any missing parent directories.
#[tauri::command]
pub async fn create_file(remotes: State<'_, Remotes>, path: String) -> CmdResult<()> {
    if let Some((host, file)) = remote::parse(&path) {
        return remote::create_file(&remotes, host, &file).await;
    }
    let path = Path::new(&path);
    ensure_absent(path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(drop)
        .map_err(err)
}

#[tauri::command]
pub async fn create_dir(remotes: State<'_, Remotes>, path: String) -> CmdResult<()> {
    if let Some((host, dir)) = remote::parse(&path) {
        return remote::create_dir(&remotes, host, &dir).await;
    }
    let path = Path::new(&path);
    ensure_absent(path)?;
    std::fs::create_dir_all(path).map_err(err)
}

#[tauri::command]
pub async fn rename_path(remotes: State<'_, Remotes>, from: String, to: String) -> CmdResult<()> {
    if let (Some((host, old)), Some((_, new))) = (remote::parse(&from), remote::parse(&to)) {
        return remote::rename(&remotes, host, &old, &new).await;
    }
    // A case-only rename on a case-insensitive file system "exists" already.
    if !from.eq_ignore_ascii_case(&to) {
        ensure_absent(Path::new(&to))?;
    }
    std::fs::rename(&from, &to).map_err(err)
}

/// Moves a local file or directory to the OS trash. Remote ones (SSH, WSL)
/// have no trash reachable from here and are deleted for good.
#[tauri::command]
pub async fn delete_path(remotes: State<'_, Remotes>, path: String) -> CmdResult<()> {
    if let Some((host, target)) = remote::parse(&path) {
        return remote::delete(&remotes, host, &target).await;
    }
    if crate::wsl::parse_share(&path).is_some() {
        let p = Path::new(&path);
        return if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }.map_err(err);
    }
    trash::delete(&path).map_err(err)
}

/// A file's or folder's change signature: modification time and size. A folder's
/// time changes when entries are added, removed or renamed in it.
fn local_signature(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{modified}:{}", meta.len()))
}

/// `stat` of many paths on a remote in one round trip: signature by remote path.
/// A remote that does not answer is an error, not "every path is gone": that would
/// make the Project view list its folders again (and empty them) on every check.
async fn remote_signatures(remotes: &Remotes, host: &str, paths: &[String]) -> CmdResult<std::collections::HashMap<String, String>> {
    let quoted: Vec<String> = paths.iter().map(|p| remote::quote(p)).collect();
    // Missing paths are just absent from the output; `true` keeps the exit status 0.
    let script = format!("stat -c '%y|%s|%n' -- {} 2>/dev/null; true", quoted.join(" "));
    let output = Remotes::exec(remotes, host, script).await?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '|');
            let (time, size, path) = (parts.next()?, parts.next()?, parts.next()?);
            Some((path.to_string(), format!("{time}:{size}")))
        })
        .collect())
}

/// Change signatures of `paths` (None where a path does not exist), to notice
/// changes made outside the app (AI agents, other editors, `git`): remote paths
/// are checked with one command per host or distribution.
#[tauri::command]
pub async fn fs_signatures(remotes: State<'_, Remotes>, paths: Vec<String>) -> CmdResult<Vec<Option<String>>> {
    signatures(&remotes, paths).await
}

async fn signatures(remotes: &Remotes, paths: Vec<String>) -> CmdResult<Vec<Option<String>>> {
    // Remote paths grouped by session (SSH host or WSL distribution), with their index.
    let mut groups: std::collections::HashMap<String, Vec<(usize, String)>> = std::collections::HashMap::new();
    let mut result: Vec<Option<String>> = vec![None; paths.len()];
    for (index, path) in paths.iter().enumerate() {
        if let Some((host, file)) = remote::parse(path) {
            groups.entry(host.to_string()).or_default().push((index, file));
        } else if let Some((distro, linux)) = crate::wsl::parse_share(path) {
            groups.entry(remote::wsl_session(&distro)).or_default().push((index, linux));
        }
    }
    for (session, entries) in &groups {
        let list: Vec<String> = entries.iter().map(|(_, p)| p.clone()).collect();
        let found = remote_signatures(remotes, session, &list).await?;
        for (index, path) in entries {
            result[*index] = found.get(path).cloned();
        }
    }
    let local: Vec<(usize, String)> = paths
        .iter()
        .enumerate()
        .filter(|(_, p)| remote::parse(p).is_none() && crate::wsl::parse_share(p).is_none())
        .map(|(i, p)| (i, p.clone()))
        .collect();
    let signatures = tauri::async_runtime::spawn_blocking(move || local.into_iter().map(|(i, p)| (i, local_signature(&p))).collect::<Vec<_>>())
        .await
        .map_err(err)?;
    for (index, signature) in signatures {
        result[index] = signature;
    }
    Ok(result)
}

#[cfg(test)]
mod signature_tests {
    use super::*;

    #[test]
    fn a_write_is_refused_when_the_file_changed_since_it_was_read() {
        let dir = std::env::temp_dir().join(format!("powercode-write-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt").to_string_lossy().into_owned();
        std::fs::write(&file, "one").unwrap();
        let remotes = Remotes::default();
        let block = |future| tauri::async_runtime::block_on(future);
        let read = local_signature(&file);
        // Unchanged since read: written, with the new signature returned.
        let saved = block(write_checked(&remotes, file.clone(), "two".into(), read.clone())).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(saved, local_signature(&file));
        // Changed by something else (size and time differ): refused, the change kept.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "theirs!").unwrap();
        let refused = block(write_checked(&remotes, file.clone(), "mine".into(), saved.clone()));
        assert_eq!(refused, Err(FILE_CHANGED.to_string()));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs!");
        // Without an expected signature (Overwrite): written.
        block(write_checked(&remotes, file.clone(), "mine".into(), None)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
        // Deleted meanwhile: written again.
        std::fs::remove_file(&file).unwrap();
        block(write_checked(&remotes, file.clone(), "back".into(), saved)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "back");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signatures_change_with_the_content_and_the_folder() {
        let dir = std::env::temp_dir().join(format!("powercode-signatures-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let (file, folder) = (file.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned());
        let before = (local_signature(&file).unwrap(), local_signature(&folder).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "three").unwrap();
        std::fs::write(dir.join("b.txt"), "new").unwrap();
        assert_ne!(local_signature(&file).unwrap(), before.0, "the file's size and time changed");
        assert_ne!(local_signature(&folder).unwrap(), before.1, "an entry was added to the folder");
        assert!(local_signature(&dir.join("missing").to_string_lossy()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod wsl_tests {
    /// The file index of a WSL folder comes from inside the distribution, with the
    /// app's path separators (machine-specific): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn lists_wsl_projects_natively() {
        let Some(distro) = crate::wsl::distributions().into_iter().next() else { return };
        let remotes = crate::remote::Remotes::default();
        let started = std::time::Instant::now();
        let files = tauri::async_runtime::block_on(crate::remote::list_files(
            &remotes,
            &crate::remote::wsl_session(&distro),
            "/home/daniel/deepseek-harness",
            super::MAX_INDEXED_FILES,
        ))
        .unwrap();
        let files: Vec<String> = files.into_iter().map(|f| f.replace('/', "\\")).collect();
        println!("{} files in {:?}, e.g. {:?}", files.len(), started.elapsed(), files.iter().find(|f| f.contains('\\')));
        assert!(files.len() > 1000);
        assert!(files.iter().all(|f| !f.contains('/')), "Windows separators, like the tree's paths");
    }
}
