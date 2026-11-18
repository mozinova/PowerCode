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

pub(crate) const OPEN_VSX_API: &str = "https://open-vsx.org/api";
const MAX_VSIX_BYTES: usize = 200 * 1024 * 1024;

pub(crate) fn http() -> &'static reqwest::Client {
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
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    version: String,
    /// The installed package is for another platform than this one (e.g. installed
    /// before PowerCode picked platform-specific packages): it needs reinstalling.
    wrong_platform: bool,
}

/// The platform of an installed extension's package: from the install info, else
/// what Open VSX served by default (what PowerCode installed before recording it).
fn installed_platform(app: &AppHandle, id: &str, metadata: &ExtensionMetadata) -> String {
    let recorded = extensions_dir(app)
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join(id.to_lowercase()).join(INSTALL_INFO)).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|info| info.get("targetPlatform")?.as_str().map(str::to_string));
    recorded.unwrap_or_else(|| metadata.target_platform.clone().unwrap_or_else(|| "universal".to_string()))
}

/// Latest published version of each installed `namespace.name` id, queried in parallel.
/// Extensions Open VSX does not know (or that fail to load) are left out.
#[tauri::command]
pub async fn openvsx_latest_versions(
    app: AppHandle,
    ids: Vec<String>,
) -> CmdResult<std::collections::HashMap<String, LatestVersion>> {
    let lookups: Vec<_> = ids
        .into_iter()
        .filter_map(|id| {
            let (namespace, name) = id.split_once('.')?;
            if validate_segment(namespace).is_err() || validate_segment(name).is_err() {
                return None;
            }
            let url = format!("{OPEN_VSX_API}/{namespace}/{name}");
            let app = app.clone();
            Some(tauri::async_runtime::spawn(async move {
                let response = http().get(url).send().await.ok()?.error_for_status().ok()?;
                let metadata: ExtensionMetadata = response.json().await.ok()?;
                let wrong_platform = match choose_download(&metadata, current_target_platform()) {
                    Ok((_, platform)) => platform != installed_platform(&app, &id, &metadata),
                    Err(_) => false,
                };
                Some((id, LatestVersion { version: metadata.version.clone(), wrong_platform }))
            }))
        })
        .collect();
    let mut versions = std::collections::HashMap::new();
    for lookup in lookups {
        if let Ok(Some((id, latest))) = lookup.await {
            versions.insert(id, latest);
        }
    }
    Ok(versions)
}

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

#[tauri::command(async)]
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
#[serde(rename_all = "camelCase")]
struct ExtensionMetadata {
    #[serde(default)]
    version: String,
    files: SearchFiles,
    /// Platform of `files.download`; `universal` (or absent) when not platform-specific.
    #[serde(default)]
    target_platform: Option<String>,
    /// Packages per platform (`win32-x64`, `linux-arm64`, ...) of platform-specific extensions.
    #[serde(default)]
    downloads: std::collections::HashMap<String, String>,
}

/// VS Code's name for the platform PowerCode runs on, as used by platform-specific extensions.
fn current_target_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "win32-arm64",
        ("windows", _) => "win32-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        ("linux", "aarch64") if cfg!(target_env = "musl") => "alpine-arm64",
        ("linux", _) if cfg!(target_env = "musl") => "alpine-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", "arm") => "linux-armhf",
        _ => "linux-x64",
    }
}

/// The .vsix to install: this platform's package, else a universal one. Extensions
/// with native parts (Claude Code, rust-analyzer, ...) publish one per platform and
/// Open VSX's default `download` may be any of them.
fn choose_download(metadata: &ExtensionMetadata, platform: &str) -> CmdResult<(String, String)> {
    if let Some(url) = metadata.downloads.get(platform) {
        return Ok((url.clone(), platform.to_string()));
    }
    if let Some(url) = metadata.downloads.get("universal") {
        return Ok((url.clone(), "universal".to_string()));
    }
    let default_platform = metadata.target_platform.as_deref().unwrap_or("universal");
    match &metadata.files.download {
        Some(url) if default_platform == "universal" || default_platform == platform => {
            Ok((url.clone(), default_platform.to_string()))
        }
        Some(_) => Err(format!(
            "This extension is not available for this platform ({platform}). It is published for: {}.",
            {
                let mut platforms: Vec<&str> = metadata.downloads.keys().map(String::as_str).collect();
                platforms.sort_unstable();
                platforms.join(", ")
            }
        )),
        None => Err("The extension has no .vsix file to download.".to_string()),
    }
}

/// Written next to an installed extension: which platform's package it is.
const INSTALL_INFO: &str = ".powercode-install.json";

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
    let (url, platform) = choose_download(&metadata, current_target_platform())?;

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
        let info = serde_json::json!({ "targetPlatform": platform });
        let _ = std::fs::write(staging.join(INSTALL_INFO), info.to_string());
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(err)?;
        }
        std::fs::rename(&staging, &dest).map_err(err)?;
        read_installed(&dest).ok_or_else(|| "Invalid extension manifest.".to_string())
    })
    .await
    .map_err(err)?
}

#[tauri::command(async)]
pub fn extensions_uninstall(app: AppHandle, id: String) -> CmdResult<()> {
    validate_segment(&id)?;
    std::fs::remove_dir_all(extensions_dir(&app)?.join(id)).map_err(err)
}

/// Reads a file contributed by an installed extension (grammar, theme, ...).
#[tauri::command(async)]
pub fn extensions_read_file(app: AppHandle, id: String, relative: String) -> CmdResult<String> {
    validate_segment(&id)?;
    let base = extensions_dir(&app)?.join(&id).canonicalize().map_err(err)?;
    let target = base.join(&relative).canonicalize().map_err(err)?;
    if !target.starts_with(&base) {
        return Err("Path is outside the extension.".into());
    }
    std::fs::read_to_string(target).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(json: serde_json::Value) -> ExtensionMetadata {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn picks_this_platforms_package() {
        // Open VSX's answer for Claude Code: the default download is another platform's.
        let m = metadata(serde_json::json!({
            "version": "2.1.327",
            "targetPlatform": "alpine-arm64",
            "files": { "download": "https://x/alpine-arm64.vsix" },
            "downloads": {
                "win32-x64": "https://x/win32-x64.vsix",
                "alpine-arm64": "https://x/alpine-arm64.vsix",
                "darwin-arm64": "https://x/darwin-arm64.vsix"
            }
        }));
        assert_eq!(choose_download(&m, "win32-x64").unwrap(), ("https://x/win32-x64.vsix".into(), "win32-x64".into()));
        assert_eq!(choose_download(&m, "darwin-arm64").unwrap().1, "darwin-arm64");
        let missing = choose_download(&m, "linux-armhf").unwrap_err();
        assert!(missing.contains("linux-armhf") && missing.contains("win32-x64"), "{missing}");
    }

    #[test]
    fn universal_packages() {
        let plain = metadata(serde_json::json!({ "files": { "download": "https://x/u.vsix" } }));
        assert_eq!(choose_download(&plain, "win32-x64").unwrap(), ("https://x/u.vsix".into(), "universal".into()));
        let listed = metadata(serde_json::json!({
            "targetPlatform": "universal",
            "files": { "download": "https://x/u.vsix" },
            "downloads": { "universal": "https://x/u.vsix" }
        }));
        assert_eq!(choose_download(&listed, "linux-x64").unwrap().1, "universal");
    }

    #[test]
    fn platform_name_matches_vscode() {
        let platform = current_target_platform();
        assert!(["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "linux-armhf", "alpine-x64", "alpine-arm64"].contains(&platform));
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(platform, "win32-x64");
        }
    }
}
