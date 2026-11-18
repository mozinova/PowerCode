//! The extension host on a remote: an SSH host or a WSL distribution, like
//! VS Code Server. Extensions then run where the files are, with the remote's
//! own tools (language servers, debuggers, CLIs).
//!
//! Everything lives in `~/.powercode-server` on the remote:
//!
//!   node-v<version>-<platform>/   Node.js for the remote's platform
//!   ext-host-<hash>.cjs           the extension host (ext-host/, bundled)
//!   extensions/<id>/              extensions with code, for the remote's platform
//!   data/                         their storage
//!
//! Nothing needs the remote's internet access: Node and extensions are
//! downloaded here and streamed to it (`tar` on its stdin).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{err, CmdResult};
use crate::remote::quote;

pub const NODE_VERSION: &str = "24.19.0";
const SERVER_DIR: &str = ".powercode-server";
const INSTALL_INFO: &str = ".powercode-install.json";

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteTarget {
    Ssh { host: String },
    Wsl { distro: String },
}

impl RemoteTarget {
    fn label(&self) -> String {
        match self {
            RemoteTarget::Ssh { host } => host.clone(),
            RemoteTarget::Wsl { distro } => format!("WSL: {distro}"),
        }
    }
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// A command running POSIX `script` on the target (through `sh`, whatever the login shell).
fn script_command(target: &RemoteTarget, script: &str) -> Command {
    match target {
        RemoteTarget::Ssh { host } => {
            let mut cmd = Command::new("ssh");
            cmd.args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", host]);
            cmd.arg(format!("sh -c {}", quote(script)));
            no_window(&mut cmd);
            cmd
        }
        RemoteTarget::Wsl { distro } => {
            let mut cmd = crate::wsl::command(distro, "/", "sh");
            cmd.args(["-c", script]);
            cmd
        }
    }
}

/// Runs `script` on the target with `input` on its stdin; returns its stdout, or stderr as the error.
pub fn run_script(target: &RemoteTarget, script: &str, input: Option<Vec<u8>>) -> CmdResult<String> {
    let mut cmd = script_command(target, script);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not reach {}: {e}", target.label()))?;
    // Written from a thread, so a large upload cannot deadlock with the output pipes.
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().expect("stdin is piped");
        std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })
    });
    let output = child.wait_with_output().map_err(err)?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("{}: {}", target.label(), if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }))
    }
}

/// The command starting the extension host on the target (its stdio carries the protocol).
pub fn host_command(target: &RemoteTarget, node: &str, script: &str) -> Command {
    match target {
        RemoteTarget::Ssh { host } => {
            let mut cmd = Command::new("ssh");
            cmd.args(["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", host]);
            cmd.arg(format!("{} {}", quote(node), quote(script)));
            no_window(&mut cmd);
            cmd
        }
        RemoteTarget::Wsl { distro } => {
            let mut cmd = crate::wsl::command(distro, "/", node);
            cmd.arg(script);
            cmd
        }
    }
}

// ---- Platform --------------------------------------------------------------------

/// The remote's platform, as Node.js and Open VSX name it.
#[derive(Debug, PartialEq)]
struct Platform {
    /// `linux-x64`, `linux-arm64`, `linux-x64-musl`, `darwin-arm64`, ...
    node: String,
    /// `linux-x64`, `alpine-arm64`, `darwin-arm64`, ...
    vsix: String,
}

/// From `uname -sm` and the first line of `ldd --version` (which names musl on Alpine).
fn parse_platform(uname: &str, ldd: &str) -> CmdResult<Platform> {
    let mut parts = uname.split_whitespace();
    let (os, machine) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let arch = match machine {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        "armv7l" | "armv6l" => "armv7l",
        other => return Err(format!("Unsupported remote architecture: {other}")),
    };
    match os {
        "Linux" if ldd.to_lowercase().contains("musl") => Ok(Platform {
            node: format!("linux-{arch}-musl"),
            vsix: format!("alpine-{arch}"),
        }),
        "Linux" => Ok(Platform {
            node: format!("linux-{arch}"),
            vsix: if arch == "armv7l" { "linux-armhf".into() } else { format!("linux-{arch}") },
        }),
        "Darwin" => Ok(Platform { node: format!("darwin-{arch}"), vsix: format!("darwin-{arch}") }),
        other => Err(format!("Unsupported remote system: {other}")),
    }
}

fn node_url(platform: &str) -> String {
    let file = format!("node-v{NODE_VERSION}-{platform}.tar.gz");
    // musl builds come from Node's unofficial builds.
    if platform.ends_with("-musl") {
        format!("https://unofficial-builds.nodejs.org/download/release/v{NODE_VERSION}/{file}")
    } else {
        format!("https://nodejs.org/dist/v{NODE_VERSION}/{file}")
    }
}

// ---- Downloads ---------------------------------------------------------------------

async fn download(url: &str) -> CmdResult<Vec<u8>> {
    let response = crate::extensions::http().get(url).send().await.map_err(err)?.error_for_status().map_err(err)?;
    Ok(response.bytes().await.map_err(err)?.to_vec())
}

/// Node.js for `platform`, downloaded once into `cache`.
async fn node_archive(cache: &Path, platform: &str) -> CmdResult<Vec<u8>> {
    let file = cache.join(format!("node-v{NODE_VERSION}-{platform}.tar.gz"));
    if let Ok(bytes) = std::fs::read(&file) {
        return Ok(bytes);
    }
    let bytes = download(&node_url(platform)).await?;
    std::fs::create_dir_all(cache).map_err(err)?;
    std::fs::write(&file, &bytes).map_err(err)?;
    Ok(bytes)
}

// ---- Extension archives --------------------------------------------------------------

fn gzip(tar: Vec<u8>) -> CmdResult<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&tar).map_err(err)?;
    encoder.finish().map_err(err)
}

/// A local extension folder as a .tar.gz (universal extensions are the same everywhere).
fn archive_folder(dir: &Path) -> CmdResult<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    builder.append_dir_all(".", dir).map_err(err)?;
    gzip(builder.into_inner().map_err(err)?)
}

/// The `extension/` folder of a .vsix as a .tar.gz, keeping executable bits (native binaries).
fn archive_vsix(vsix: &[u8]) -> CmdResult<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(vsix)).map_err(err)?;
    let mut builder = tar::Builder::new(Vec::new());
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(err)?;
        let Some(name) = file.enclosed_name() else { continue };
        let Ok(relative) = name.strip_prefix("extension") else { continue };
        if file.is_dir() || relative.as_os_str().is_empty() {
            continue;
        }
        let recorded = file.unix_mode().unwrap_or(0);
        let mut data = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut data).map_err(err)?;
        let mode = if recorded & 0o111 != 0 || is_executable(&data) { 0o755 } else { 0o644 };
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        // Forward slashes whatever the local OS.
        let path = relative.to_string_lossy().replace('\\', "/");
        builder.append_data(&mut header, path, data.as_slice()).map_err(err)?;
    }
    gzip(builder.into_inner().map_err(err)?)
}

/// Native binaries and scripts, whatever mode the archive recorded (packages made on
/// Windows record none), so they stay runnable on the remote.
fn is_executable(data: &[u8]) -> bool {
    const MAGICS: [&[u8]; 6] = [
        b"\x7fELF",
        b"#!",
        &[0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit
        &[0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
        &[0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
        &[0xfe, 0xed, 0xfa, 0xcf],
    ];
    MAGICS.iter().any(|magic| data.starts_with(magic))
}

// ---- Preparing the remote -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExtension {
    id: String,
    path: String,
    publisher: String,
    name: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHost {
    node: String,
    script: String,
    home: String,
    extensions_dir: String,
    data_dir: String,
    /// Extensions that could not be set up there, with the reason.
    skipped: Vec<String>,
}

/// The platform recorded next to a local extension when it was installed.
fn local_platform(path: &str) -> String {
    std::fs::read_to_string(Path::new(path).join(INSTALL_INFO))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|info| info.get("targetPlatform")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "universal".into())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |hash, b| (hash ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// Gets the remote ready to run the extension host; reports each step on `on_progress`.
#[tauri::command]
pub async fn remote_exthost_prepare(
    app: AppHandle,
    target: RemoteTarget,
    extensions: Vec<LocalExtension>,
    on_progress: Channel<String>,
) -> CmdResult<PreparedHost> {
    let cache = app.path().app_data_dir().map_err(err)?.join("remote-node");
    let script = crate::exthost::host_script(&app)?;
    prepare(&cache, &script, target, extensions, |text| {
        let _ = on_progress.send(text);
    })
    .await
}

/// The work of `remote_exthost_prepare`: `node_cache` keeps Node.js downloads, `local_script` is the host to install.
async fn prepare(
    node_cache: &Path,
    local_script: &Path,
    target: RemoteTarget,
    extensions: Vec<LocalExtension>,
    progress: impl Fn(String),
) -> CmdResult<PreparedHost> {
    let run = |script: String, input: Option<Vec<u8>>| {
        let target = target.clone();
        tauri::async_runtime::spawn_blocking(move || run_script(&target, &script, input))
    };

    progress(format!("Connecting to {}…", target.label()));
    let facts = run("printf '%s\\n' \"$HOME\"; uname -sm; (ldd --version 2>&1 || true) | head -n 1".into(), None).await.map_err(err)??;
    let mut lines = facts.lines();
    let home = lines.next().unwrap_or("").trim().to_string();
    let uname = lines.next().unwrap_or("");
    let ldd = lines.next().unwrap_or("");
    if !home.starts_with('/') {
        return Err(format!("Could not find the home folder on {}.", target.label()));
    }
    let platform = parse_platform(uname, ldd)?;
    let server = format!("{home}/{SERVER_DIR}");

    // Node.js.
    let node = format!("{server}/node-v{NODE_VERSION}-{}/bin/node", platform.node);
    let has_node = run(format!("test -x {} && echo ok || true", quote(&node)), None).await.map_err(err)??;
    if has_node.trim() != "ok" {
        progress(format!("Downloading Node.js for {}…", platform.node));
        let archive = node_archive(node_cache, &platform.node).await?;
        progress(format!("Installing Node.js on {}…", target.label()));
        run(format!("mkdir -p {s} && cd {s} && tar -xzf -", s = quote(&server)), Some(archive)).await.map_err(err)??;
    }

    // The extension host itself, named by its content so updates replace it.
    let script_bytes = std::fs::read(local_script).map_err(err)?;
    let script = format!("{server}/ext-host-{:016x}.cjs", fnv1a(&script_bytes));
    let has_script = run(format!("test -f {} && echo ok || true", quote(&script)), None).await.map_err(err)??;
    if has_script.trim() != "ok" {
        run(
            format!("mkdir -p {s} && rm -f {s}/ext-host-*.cjs && cat > {f}", s = quote(&server), f = quote(&script)),
            Some(script_bytes),
        )
        .await
        .map_err(err)??;
    }

    // Extensions: what is there already (version and platform of each).
    let extensions_dir = format!("{server}/extensions");
    let listing = run(
        format!(
            "mkdir -p {d} && for e in {d}/*/; do [ -f \"$e{info}\" ] && printf '%s\\t%s\\n' \"$(basename \"$e\")\" \"$(cat \"$e{info}\")\"; done; true",
            d = quote(&extensions_dir),
            info = INSTALL_INFO
        ),
        None,
    )
    .await
    .map_err(err)??;
    let remote: HashMap<String, serde_json::Value> = listing
        .lines()
        .filter_map(|line| {
            let (id, info) = line.split_once('\t')?;
            Some((id.to_string(), serde_json::from_str(info).ok()?))
        })
        .collect();

    let mut skipped = Vec::new();
    for ext in &extensions {
        let universal = local_platform(&ext.path) == "universal";
        let wanted_platform = if universal { "universal".to_string() } else { platform.vsix.clone() };
        let current = remote.get(&ext.id);
        let up_to_date = current.is_some_and(|info| {
            info.get("version").and_then(|v| v.as_str()) == Some(ext.version.as_str())
                && info.get("targetPlatform").and_then(|v| v.as_str()) == Some(wanted_platform.as_str())
        });
        if up_to_date {
            continue;
        }
        progress(format!("Installing {} on {}…", ext.name, target.label()));
        let archive = if universal {
            let dir = PathBuf::from(&ext.path);
            tauri::async_runtime::spawn_blocking(move || archive_folder(&dir)).await.map_err(err)?
        } else {
            // The package for the remote's platform (e.g. Linux binaries), at the same version.
            let url = format!(
                "{}/{}/{}/{}/{}",
                crate::extensions::OPEN_VSX_API,
                ext.publisher,
                ext.name,
                platform.vsix,
                ext.version
            );
            match async {
                let metadata: serde_json::Value = crate::extensions::http().get(&url).send().await.map_err(err)?.error_for_status().map_err(err)?.json().await.map_err(err)?;
                let url = metadata["files"]["download"].as_str().ok_or("no package for this platform")?.to_string();
                let vsix = download(&url).await?;
                tauri::async_runtime::spawn_blocking(move || archive_vsix(&vsix)).await.map_err(err)?
            }
            .await
            {
                Ok(archive) => Ok(archive),
                Err(e) => Err(format!("{} has no {} package ({e})", ext.id, platform.vsix)),
            }
        };
        let archive = match archive {
            Ok(archive) => archive,
            Err(e) => {
                skipped.push(e);
                continue;
            }
        };
        let info = serde_json::json!({ "version": ext.version, "targetPlatform": wanted_platform }).to_string();
        let dest = format!("{extensions_dir}/{}", ext.id);
        let install = format!(
            "rm -rf {t} && mkdir -p {t} && tar -xzf - -C {t} && rm -rf {d} && mv {t} {d} && printf '%s' {info} > {d}/{file}",
            t = quote(&format!("{dest}.tmp")),
            d = quote(&dest),
            info = quote(&info),
            file = INSTALL_INFO,
        );
        if let Err(e) = run(install, Some(archive)).await.map_err(err)? {
            skipped.push(format!("{}: {e}", ext.id));
        }
    }

    Ok(PreparedHost {
        node,
        script,
        home: home.clone(),
        extensions_dir,
        data_dir: format!("{server}/data"),
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platforms() {
        assert_eq!(parse_platform("Linux x86_64", "ldd (Ubuntu GLIBC 2.39) 2.39").unwrap(), Platform { node: "linux-x64".into(), vsix: "linux-x64".into() });
        assert_eq!(parse_platform("Linux aarch64", "musl libc (aarch64)").unwrap(), Platform { node: "linux-arm64-musl".into(), vsix: "alpine-arm64".into() });
        assert_eq!(parse_platform("Darwin arm64", "").unwrap(), Platform { node: "darwin-arm64".into(), vsix: "darwin-arm64".into() });
        assert_eq!(parse_platform("Linux armv7l", "").unwrap().vsix, "linux-armhf");
        assert!(parse_platform("Linux mips", "").is_err());
        assert!(node_url("linux-x64-musl").starts_with("https://unofficial-builds.nodejs.org/"));
        assert_eq!(node_url("linux-x64"), format!("https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.gz"));
    }

    #[test]
    fn vsix_archives_keep_paths_and_executable_bits() {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let plain = zip::write::SimpleFileOptions::default();
        zip.start_file("extension/package.json", plain.unix_permissions(0o644)).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("extension/bin/tool", plain.unix_permissions(0o755)).unwrap();
        zip.write_all(b"#!/bin/sh").unwrap();
        zip.start_file("extension/bin/native", plain).unwrap();
        zip.write_all(b"\x7fELF\x02\x01").unwrap();
        zip.start_file("extension.vsixmanifest", plain).unwrap();
        zip.write_all(b"<x/>").unwrap();
        let vsix = zip.finish().unwrap().into_inner();

        let gz = archive_vsix(&vsix).unwrap();
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(gz.as_slice()));
        let entries: Vec<(String, u32)> = tar
            .entries()
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.path().unwrap().to_string_lossy().replace('\\', "/"), e.header().mode().unwrap())
            })
            .collect();
        assert_eq!(
            entries,
            vec![("package.json".to_string(), 0o644), ("bin/tool".to_string(), 0o755), ("bin/native".to_string(), 0o755)]
        );
    }

    /// End to end in the first WSL distribution: installs Node.js, the host and a test
    /// extension in `~/.powercode-server`, starts the host there and checks the extension
    /// runs on Linux. Downloads Node.js once (cached like the app does): `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn runs_the_extension_host_in_wsl() {
        use std::io::BufRead;
        let Some(distro) = crate::wsl::distributions().into_iter().next() else { return };
        let target = RemoteTarget::Wsl { distro };
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let cache = dirs::data_dir().unwrap().join("com.mozin.powercode").join("remote-node");

        // A universal test extension that reports where it runs.
        let ext_dir = std::env::temp_dir().join("powercode-remote-test-ext");
        let _ = std::fs::remove_dir_all(&ext_dir);
        std::fs::create_dir_all(&ext_dir).unwrap();
        std::fs::write(
            ext_dir.join("package.json"),
            r#"{"name":"remote-ext","publisher":"test","version":"1.0.0","main":"./main.js","activationEvents":["*"]}"#,
        )
        .unwrap();
        std::fs::write(
            ext_dir.join("main.js"),
            r#"const vscode = require("vscode"); const fs = require("fs");
exports.activate = () => {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  console.log("REMOTE " + JSON.stringify({ platform: process.platform, folder: folder.toString(), fsPath: folder.fsPath, hosts: fs.existsSync("/etc/hosts") }));
};"#,
        )
        .unwrap();

        let prepared = tauri::async_runtime::block_on(prepare(
            &cache,
            &manifest_dir.join("resources").join("ext-host.cjs"),
            target.clone(),
            vec![LocalExtension {
                id: "test.remote-ext".into(),
                path: ext_dir.to_string_lossy().into_owned(),
                publisher: "test".into(),
                name: "remote-ext".into(),
                version: "1.0.0".into(),
            }],
            |step| println!("{step}"),
        ))
        .unwrap();
        assert!(prepared.skipped.is_empty(), "{:?}", prepared.skipped);
        assert!(prepared.node.starts_with(&prepared.home) && prepared.node.ends_with("/bin/node"));

        let mut child = host_command(&target, &prepared.node, &prepared.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let initialize = serde_json::json!({
            "id": 1, "method": "initialize", "params": {
                "workspaceFolders": [{ "uri": "file:///etc", "name": "etc" }],
                "extensions": [{ "id": "test.remote-ext", "path": format!("{}/test.remote-ext", prepared.extensions_dir),
                                  "manifest": { "name": "remote-ext", "publisher": "test", "version": "1.0.0", "main": "./main.js", "activationEvents": ["*"] } }],
                "settings": {}, "languages": [],
                "globalStoragePath": format!("{}/global", prepared.data_dir),
                "storagePath": format!("{}/workspaces/test", prepared.data_dir),
                "logPath": format!("{}/logs", prepared.data_dir),
                "remote": { "kind": "wsl", "distro": "x" }, "localExtensionPaths": {}
            }
        });
        writeln!(stdin, "{initialize}").unwrap();
        writeln!(stdin, "{}", serde_json::json!({ "method": "start" })).unwrap();

        let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut report = None;
        for line in stdout.lines() {
            let line = line.unwrap();
            let Some(json) = line.strip_prefix("\u{1}PC ") else { continue };
            let message: serde_json::Value = serde_json::from_str(json).unwrap();
            if message["method"] == "extensions/activationFailed" {
                panic!("activation failed: {message}");
            }
            let text = message["params"]["message"].as_str().unwrap_or("");
            if let Some(rest) = text.strip_prefix("REMOTE ") {
                report = Some(serde_json::from_str::<serde_json::Value>(rest).unwrap());
                break;
            }
        }
        drop(stdin);
        let _ = child.kill();
        let report = report.expect("the extension reported");
        assert_eq!(report["platform"], "linux");
        assert_eq!(report["folder"], "file:///etc");
        assert_eq!(report["fsPath"], "/etc");
        assert_eq!(report["hosts"], true, "the extension reads the remote's files");
        let _ = std::fs::remove_dir_all(&ext_dir);
    }

    /// Runs scripts (with input and errors) in the first WSL distribution, when there is one.
    #[test]
    fn runs_scripts_in_wsl() {
        let Some(distro) = crate::wsl::distributions().into_iter().next() else { return };
        let target = RemoteTarget::Wsl { distro };
        let out = run_script(&target, "printf '%s' \"$(cat)\" | tr a-z A-Z", Some(b"hello".to_vec())).unwrap();
        assert_eq!(out, "HELLO");
        let failure = run_script(&target, "echo boom >&2; exit 3", None).unwrap_err();
        assert!(failure.contains("boom"), "{failure}");
    }
}
