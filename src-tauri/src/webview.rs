//! The `pcwebview` protocol serving extensions' webviews from their own origin
//! (like VS Code's `vscode-webview://`): they can load their scripts, styles
//! and fonts, but cannot reach the app's IPC.
//!
//!   /<id>/index.html   the webview's HTML, as last set by the UI
//!   /file/<path>       a local file, e.g. from `Webview.asWebviewUri`

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, State, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "pcwebview";

#[derive(Default)]
pub struct Webviews {
    html: Mutex<HashMap<String, String>>,
}

#[tauri::command]
pub fn webview_set_html(state: State<'_, Webviews>, id: String, html: String) {
    if let Ok(mut map) = state.html.lock() {
        map.insert(id, html);
    }
}

#[tauri::command]
pub fn webview_dispose(state: State<'_, Webviews>, id: String) {
    if let Ok(mut map) = state.html.lock() {
        map.remove(&id);
    }
}

fn percent_decode(text: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap_or_default()
}

/// The local path of a `/file/...` request path (already percent-decoded).
fn file_path(rest: &str) -> String {
    if cfg!(windows) {
        // `/file/C:/dir/a.js`, or a UNC share as `/file///server/share/a.js`.
        rest.to_string()
    } else {
        format!("/{rest}")
    }
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let path = percent_decode(request.uri().path());
    let path = path.strip_prefix('/').unwrap_or(&path).to_string();

    // `/ssh/<host>/<absolute path>`: a file on an SSH host (e.g. an image in a Markdown preview).
    if let Some(rest) = path.strip_prefix("ssh/") {
        let Some((host, remote_path)) = rest.split_once('/') else {
            responder.respond(response(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()));
            return;
        };
        let (host, remote_path) = (host.to_string(), format!("/{remote_path}"));
        tauri::async_runtime::spawn_blocking(move || {
            let script = format!("cat -- {}", crate::remote::quote(&remote_path));
            let reply = match crate::remote::shared().exec_blocking(&host, &script) {
                Ok(bytes) => response(StatusCode::OK, mime_type(&remote_path), bytes),
                Err(_) => response(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()),
            };
            responder.respond(reply);
        });
        return;
    }

    if let Some(rest) = path.strip_prefix("file/") {
        let file = file_path(rest);
        tauri::async_runtime::spawn_blocking(move || {
            let reply = match std::fs::read(&file) {
                Ok(bytes) => response(StatusCode::OK, mime_type(&file), bytes),
                Err(_) => response(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()),
            };
            responder.respond(reply);
        });
        return;
    }

    let id = path.split('/').next().unwrap_or("");
    let html = ctx
        .app_handle()
        .state::<Webviews>()
        .html
        .lock()
        .ok()
        .and_then(|map| map.get(id).cloned());
    responder.respond(match html {
        Some(html) => response(StatusCode::OK, "text/html; charset=utf-8", html.into_bytes()),
        None => response(StatusCode::NOT_FOUND, "text/plain", b"Unknown webview".to_vec()),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/file/C%3A/My%20Dir/a.js"), "/file/C:/My Dir/a.js");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%e2%9c%93"), "✓");
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_type("x/main.JS"), "text/javascript; charset=utf-8");
        assert_eq!(mime_type("codicon.ttf"), "font/ttf");
        assert_eq!(mime_type("noext"), "application/octet-stream");
    }
}
