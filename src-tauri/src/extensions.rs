//! Installs VS Code extensions from Open VSX. Only the declarative parts of an
//! extension (themes, grammars, snippets, language configuration) are used by
//! the frontend; no extension code is ever executed.

use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{err, CmdResult};

const OPEN_VSX_API: &str = "https://open-vsx.org/api";
const MAX_VSIX_BYTES: usize = 200 * 1024 * 1024;

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("PowerCode/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client")
    })
}

fn extensions_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?.join("extensions");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Namespaces, names and ids end up in URLs and directory names.
fn validate_segment(value: &str) -> CmdResult<()> {
    let ok = !value.is_empty()
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("Invalid identifier: {value}"))
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFiles {
    icon: Option<String>,
    download: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchEntry {
    namespace: String,
    name: String,
    version: String,
    display_name: Option<String>,
    description: Option<String>,
    download_count: Option<u64>,
    verified: Option<bool>,
    files: SearchFiles,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SearchResponse {
    extensions: Vec<SearchEntry>,
}

#[tauri::command]
pub async fn openvsx_search(query: String) -> CmdResult<Vec<SearchEntry>> {
    let mut params = vec![("size", "40")];
    let query = query.trim();
    if query.is_empty() {
        params.extend([("sortBy", "downloadCount"), ("sortOrder", "desc")]);
    } else {
        params.push(("query", query));
    }
    let response: SearchResponse = http()
        .get(format!("{OPEN_VSX_API}/-/search"))
        .query(&params)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    Ok(response.extensions)
}

const MAX_README_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct ExtensionDetails {
    /// Open VSX metadata, passed through as-is.
    metadata: serde_json::Value,
    readme: Option<String>,
}

async fn fetch_text(url: &str, max_bytes: usize) -> CmdResult<String> {
    let bytes = http()
        .get(url)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .bytes()
        .await
        .map_err(err)?;
    if bytes.len() > max_bytes {
        return Err("The file is too large.".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Metadata and README of an extension, for its details page.
#[tauri::command]
pub async fn openvsx_details(namespace: String, name: String) -> CmdResult<ExtensionDetails> {
    validate_segment(&namespace)?;
    validate_segment(&name)?;
    let metadata: serde_json::Value = http()
        .get(format!("{OPEN_VSX_API}/{namespace}/{name}"))
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let readme = match metadata.pointer("/files/readme").and_then(|v| v.as_str()) {
        // A missing README should not prevent showing the rest of the page.
        Some(url) => fetch_text(url, MAX_README_BYTES).await.ok(),
        None => None,
    };
    Ok(ExtensionDetails { metadata, readme })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    id: String,
    path: String,
    manifest: serde_json::Value,
}

fn read_installed(dir: &Path) -> Option<InstalledExtension> {
    let id = dir.file_name()?.to_string_lossy().into_owned();
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    Some(InstalledExtension {
        id,
        path: dir.to_string_lossy().into_owned(),
        manifest: serde_json::from_str(&manifest).ok()?,
    })
}

#[tauri::command]
pub fn extensions_list(app: AppHandle) -> CmdResult<Vec<InstalledExtension>> {
    let mut installed: Vec<_> = std::fs::read_dir(extensions_dir(&app)?)
        .map_err(err)?
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|entry| read_installed(&entry.path()))
        .collect();
    installed.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(installed)
}

#[derive(Deserialize)]
struct ExtensionMetadata {
    files: SearchFiles,
}

/// Extracts the `extension/` folder of a .vsix archive into `dest`.
fn extract_vsix(bytes: &[u8], dest: &Path) -> CmdResult<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(err)?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(err)?;
        // `enclosed_name` rejects absolute paths and `..` traversal.
        let Some(name) = file.enclosed_name() else { continue };
        let Ok(relative) = name.strip_prefix("extension") else { continue };
        let out = dest.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(&out).map_err(err)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
            let mut target = std::fs::File::create(&out).map_err(err)?;
            std::io::copy(&mut file, &mut target).map_err(err)?;
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    downloaded: u64,
    /// From Content-Length; absent when the server does not send it.
    total: Option<u64>,
}

/// Interval between progress events, so a fast download does not flood the UI.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

async fn download_with_progress(url: &str, on_progress: &Channel<DownloadProgress>) -> CmdResult<Vec<u8>> {
    let mut response = http()
        .get(url)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_VSIX_BYTES as u64) {
        return Err("The extension is too large.".into());
    }

    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    let report = |downloaded: usize| {
        let _ = on_progress.send(DownloadProgress {
            downloaded: downloaded as u64,
            total,
        });
    };
    report(0);
    let mut last_report = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_VSIX_BYTES {
            return Err("The extension is too large.".into());
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            report(bytes.len());
            last_report = Instant::now();
        }
    }
    report(bytes.len());
    Ok(bytes)
}

#[tauri::command]
pub async fn extensions_install(
    app: AppHandle,
    namespace: String,
    name: String,
    on_progress: Channel<DownloadProgress>,
) -> CmdResult<InstalledExtension> {
    validate_segment(&namespace)?;
    validate_segment(&name)?;

    let metadata: ExtensionMetadata = http()
        .get(format!("{OPEN_VSX_API}/{namespace}/{name}"))
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let url = metadata
        .files
        .download
        .ok_or("The extension has no .vsix file to download.")?;

    let bytes = download_with_progress(&url, &on_progress).await?;

    let root = extensions_dir(&app)?;
    let id = format!("{namespace}.{name}").to_lowercase();
    let staging = root.join(format!(".staging-{id}"));
    let dest = root.join(&id);

    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&staging);
        extract_vsix(&bytes, &staging).inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&staging);
        })?;
        if !staging.join("package.json").is_file() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err("The .vsix package has no package.json.".to_string());
        }
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(err)?;
        }
        std::fs::rename(&staging, &dest).map_err(err)?;
        read_installed(&dest).ok_or_else(|| "Invalid extension manifest.".to_string())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn extensions_uninstall(app: AppHandle, id: String) -> CmdResult<()> {
    validate_segment(&id)?;
    std::fs::remove_dir_all(extensions_dir(&app)?.join(id)).map_err(err)
}

/// Reads a file contributed by an installed extension (grammar, theme, ...).
#[tauri::command]
pub fn extensions_read_file(app: AppHandle, id: String, relative: String) -> CmdResult<String> {
    validate_segment(&id)?;
    let base = extensions_dir(&app)?.join(&id).canonicalize().map_err(err)?;
    let target = base.join(&relative).canonicalize().map_err(err)?;
    if !target.starts_with(&base) {
        return Err("Path is outside the extension.".into());
    }
    std::fs::read_to_string(target).map_err(err)
}
