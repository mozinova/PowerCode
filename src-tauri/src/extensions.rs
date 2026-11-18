//! Installs VS Code extensions from Open VSX. Only the declarative parts of an
//! extension (themes, grammars, snippets, language configuration) are used by
//! the frontend; no extension code is ever executed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{err, CmdResult};

pub(crate) const OPEN_VSX_API: &str = "https://open-vsx.org/api";
/// Only a sanity bound against a broken server: extensions with native parts
/// (language servers, debuggers, AI backends) are often hundreds of megabytes.
const MAX_VSIX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

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

/// The install info written next to an installed extension (platform, and `source: "vsix"` for files).
fn install_info(app: &AppHandle, id: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(extensions_dir(app).ok()?.join(id.to_lowercase()).join(INSTALL_INFO)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Installed from a .vsix file: kept as installed (a local or development build), not
/// replaced by Open VSX's version.
fn installed_from_file(app: &AppHandle, id: &str) -> bool {
    install_info(app, id).is_some_and(|info| info.get("source").and_then(|s| s.as_str()) == Some("vsix"))
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
            if validate_segment(namespace).is_err() || validate_segment(name).is_err() || installed_from_file(&app, &id) {
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
fn extract_vsix(vsix: impl std::io::Read + std::io::Seek, dest: &Path) -> CmdResult<()> {
    let mut archive = zip::ZipArchive::new(vsix).map_err(err)?;
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

/// Downloads `url` into the file `to` (not memory: packages can be large), reporting progress.
async fn download_with_progress(url: &str, to: &Path, on_progress: &Channel<DownloadProgress>) -> CmdResult<()> {
    let mut response = http()
        .get(url)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_VSIX_BYTES) {
        return Err("The extension is too large.".into());
    }

    let report = |downloaded: u64| {
        let _ = on_progress.send(DownloadProgress { downloaded, total });
    };
    report(0);
    let mut file = std::io::BufWriter::new(std::fs::File::create(to).map_err(err)?);
    let mut downloaded: u64 = 0;
    let mut last_report = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        std::io::Write::write_all(&mut file, &chunk).map_err(err)?;
        downloaded += chunk.len() as u64;
        if downloaded > MAX_VSIX_BYTES {
            return Err("The extension is too large.".into());
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            report(downloaded);
            last_report = Instant::now();
        }
    }
    std::io::Write::flush(&mut file).map_err(err)?;
    report(downloaded);
    Ok(())
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

    let root = extensions_dir(&app)?;
    let id = format!("{namespace}.{name}").to_lowercase();
    let staging = root.join(format!(".staging-{id}"));
    let dest = root.join(&id);
    // Next to the extensions (same disk), removed whatever happens.
    let package = root.join(format!(".download-{id}.vsix"));
    let downloaded = download_with_progress(&url, &package, &on_progress).await;
    if let Err(e) = downloaded {
        let _ = std::fs::remove_file(&package);
        return Err(e);
    }

    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&staging);
        let extracted = std::fs::File::open(&package)
            .map_err(err)
            .and_then(|file| extract_vsix(std::io::BufReader::new(file), &staging));
        let _ = std::fs::remove_file(&package);
        extracted.inspect_err(|_| {
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

/// What a .vsix declares: its `package.json` (for the id) and its platform
/// (`TargetPlatform` in `extension.vsixmanifest`, absent for universal packages).
fn read_vsix_identity(path: &Path) -> CmdResult<(serde_json::Value, String)> {
    let file = std::fs::File::open(path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|_| "This file is not a VS Code extension package (.vsix).".to_string())?;
    let mut read = |name: &str| -> Option<String> {
        let mut entry = zip.by_name(name).ok()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut entry, &mut text).ok()?;
        Some(text)
    };
    let manifest = read("extension/package.json").ok_or("The package has no extension/package.json.")?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("Invalid package.json: {e}"))?;
    let platform = read("extension.vsixmanifest")
        .and_then(|xml| regex::Regex::new(r#"TargetPlatform="([^"]+)""#).ok()?.captures(&xml).map(|c| c[1].to_string()))
        .unwrap_or_else(|| "universal".into());
    Ok((manifest, platform))
}

/// Installs an extension from a .vsix file on this computer (replacing the installed
/// version, if any). Packages for another platform are refused, as in VS Code.
#[tauri::command]
pub async fn extensions_install_vsix(app: AppHandle, path: String) -> CmdResult<InstalledExtension> {
    let root = extensions_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let package = PathBuf::from(&path);
        let (manifest, platform) = read_vsix_identity(&package)?;
        let publisher = manifest["publisher"].as_str().unwrap_or_default();
        let name = manifest["name"].as_str().unwrap_or_default();
        validate_segment(publisher).map_err(|_| "The package's publisher is missing or invalid.".to_string())?;
        validate_segment(name).map_err(|_| "The package's name is missing or invalid.".to_string())?;
        let current = current_target_platform();
        if platform != "universal" && platform != current {
            return Err(format!("This package is built for {platform}; PowerCode runs on {current}. Get the {current} package of the extension."));
        }

        let id = format!("{publisher}.{name}").to_lowercase();
        let staging = root.join(format!(".staging-{id}"));
        let dest = root.join(&id);
        let _ = std::fs::remove_dir_all(&staging);
        let file = std::fs::File::open(&package).map_err(err)?;
        extract_vsix(std::io::BufReader::new(file), &staging).inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&staging);
        })?;
        let info = serde_json::json!({ "targetPlatform": platform, "source": "vsix" });
        std::fs::write(staging.join(INSTALL_INFO), info.to_string()).map_err(err)?;
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
    fn extracts_packages_from_disk() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("powercode-vsix-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let package = dir.join("x.vsix");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&package).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(br#"{"name":"x"}"#).unwrap();
        zip.start_file("extension/out/main.js", options).unwrap();
        zip.write_all(b"exports.activate = () => {};").unwrap();
        zip.start_file("extension/../escape.txt", options).unwrap();
        zip.write_all(b"no").unwrap();
        zip.start_file("extension.vsixmanifest", options).unwrap();
        zip.write_all(b"<x/>").unwrap();
        zip.finish().unwrap();

        let dest = dir.join("out");
        extract_vsix(std::io::BufReader::new(std::fs::File::open(&package).unwrap()), &dest).unwrap();
        assert_eq!(std::fs::read_to_string(dest.join("package.json")).unwrap(), r#"{"name":"x"}"#);
        assert!(dest.join("out").join("main.js").is_file());
        assert!(!dir.join("escape.txt").exists() && !dest.join("escape.txt").exists(), "no path traversal");
        assert!(!dest.join("extension.vsixmanifest").exists(), "only the extension/ folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_vsix(path: &Path, package_json: &str, target_platform: Option<&str>) {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", options).unwrap();
        zip.write_all(package_json.as_bytes()).unwrap();
        zip.start_file("extension.vsixmanifest", options).unwrap();
        let platform = target_platform.map(|p| format!(r#" TargetPlatform="{p}""#)).unwrap_or_default();
        zip.write_all(format!(r#"<PackageManifest><Metadata><Identity Id="x" Version="1.0.0" Publisher="me"{platform}/></Metadata></PackageManifest>"#).as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn reads_vsix_identity_and_platform() {
        let dir = std::env::temp_dir().join(format!("powercode-vsix-identity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let universal = dir.join("u.vsix");
        write_vsix(&universal, r#"{"publisher":"Me","name":"tool","version":"1.2.3"}"#, None);
        let (manifest, platform) = read_vsix_identity(&universal).unwrap();
        assert_eq!((manifest["publisher"].as_str(), manifest["name"].as_str(), platform.as_str()), (Some("Me"), Some("tool"), "universal"));

        let linux = dir.join("l.vsix");
        write_vsix(&linux, r#"{"publisher":"me","name":"native"}"#, Some("linux-arm64"));
        assert_eq!(read_vsix_identity(&linux).unwrap().1, "linux-arm64");

        let not_a_zip = dir.join("x.vsix");
        std::fs::write(&not_a_zip, "hello").unwrap();
        assert!(read_vsix_identity(&not_a_zip).unwrap_err().contains("not a VS Code extension package"));
        let _ = std::fs::remove_dir_all(&dir);
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
