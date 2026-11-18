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

#[tauri::command]
pub async fn write_text_file(remotes: State<'_, Remotes>, path: String, contents: String) -> CmdResult<()> {
    if let Some((host, file)) = remote::parse(&path) {
        return remote::write_file(&remotes, host, &file, contents.as_bytes()).await;
    }
    std::fs::write(Path::new(&path), contents).map_err(err)
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
