//! Signing in to GitHub for extensions (the `github` authentication provider):
//! OAuth device flow with PowerCode's OAuth App, or a token the machine already
//! has (GitHub CLI, Git Credential Manager), or a pasted personal access token.
//! Every token is checked against the GitHub API, which also says its scopes.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Command, Stdio};

use crate::error::{err, CmdResult};
use crate::extensions::http;

/// PowerCode's GitHub OAuth App (device flow enabled). Public by design: the
/// device flow needs no client secret.
const CLIENT_ID: &str = "Ov23liUgwlQNNW6OCqec";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    #[serde(rename(deserialize = "device_code"))]
    device_code: String,
    #[serde(rename(deserialize = "user_code"))]
    user_code: String,
    #[serde(rename(deserialize = "verification_uri"))]
    verification_uri: String,
    /// Seconds to wait between checks.
    interval: u64,
    #[serde(rename(deserialize = "expires_in"))]
    expires_in: u64,
}

/// Starts a device flow sign-in for `scopes`: the code the user enters on GitHub.
#[tauri::command]
pub async fn github_device_start(scopes: Vec<String>) -> CmdResult<DeviceCode> {
    let response = http()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", &scopes.join(" "))])
        .send()
        .await
        .map_err(err)?;
    let body: serde_json::Value = response.json().await.map_err(err)?;
    if let Some(error) = body.get("error_description").or_else(|| body.get("error")).and_then(|e| e.as_str()) {
        return Err(format!("GitHub refused the sign-in: {error}"));
    }
    serde_json::from_value(body).map_err(err)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DeviceCheck {
    /// Not authorized yet: check again after `interval` seconds.
    Pending { interval: Option<u64> },
    Done { token: String },
}

/// Checks once whether the user authorized the device code (the UI repeats it).
#[tauri::command]
pub async fn github_device_check(device_code: String) -> CmdResult<DeviceCheck> {
    let body: serde_json::Value = http()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    if let Some(token) = body.get("access_token").and_then(|t| t.as_str()) {
        return Ok(DeviceCheck::Done { token: token.to_string() });
    }
    match body.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => Ok(DeviceCheck::Pending { interval: None }),
        // Asked to slow down: GitHub says the new interval.
        Some("slow_down") => Ok(DeviceCheck::Pending { interval: body.get("interval").and_then(|i| i.as_u64()) }),
        Some("expired_token") => Err("The code expired. Sign in again.".into()),
        Some("access_denied") => Err("The sign-in was cancelled on GitHub.".into()),
        Some(other) => Err(format!(
            "GitHub refused the sign-in: {}",
            body.get("error_description").and_then(|d| d.as_str()).unwrap_or(other)
        )),
        None => Err("Unexpected answer from GitHub.".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubUser {
    id: u64,
    login: String,
    name: Option<String>,
    /// The token's OAuth scopes (empty for fine-grained tokens, which have permissions instead).
    scopes: Vec<String>,
}

/// Who a token belongs to and what it may do; an error when GitHub does not accept it.
#[tauri::command]
pub async fn github_user(token: String) -> CmdResult<GitHubUser> {
    let response = http()
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", token.trim()))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(err)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("GitHub does not accept this token (wrong, expired or revoked).".into());
    }
    let response = response.error_for_status().map_err(err)?;
    let scopes = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let body: serde_json::Value = response.json().await.map_err(err)?;
    Ok(GitHubUser {
        id: body.get("id").and_then(|i| i.as_u64()).unwrap_or(0),
        login: body.get("login").and_then(|l| l.as_str()).unwrap_or_default().to_string(),
        name: body.get("name").and_then(|n| n.as_str()).map(str::to_string),
        scopes,
    })
}

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// The GitHub CLI's token for github.com, if it is installed and signed in.
#[tauri::command(async)]
pub fn github_cli_token() -> CmdResult<String> {
    let output = command("gh")
        .args(["auth", "token", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "The GitHub CLI (gh) is not installed.".to_string())?;
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || token.is_empty() {
        return Err("The GitHub CLI is not signed in (run `gh auth login`).".into());
    }
    Ok(token)
}

/// The github.com password Git's credential helper holds (Git Credential Manager keeps
/// an OAuth token there). Never prompts: without a stored credential it fails.
#[tauri::command(async)]
pub fn github_git_credential() -> CmdResult<String> {
    let mut child = command("git")
        .args(["credential", "fill"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Git is not installed.".to_string())?;
    child
        .stdin
        .take()
        .ok_or("No stdin")?
        .write_all(b"protocol=https\nhost=github.com\n\n")
        .map_err(err)?;
    let output = child.wait_with_output().map_err(err)?;
    let text = String::from_utf8_lossy(&output.stdout);
    password_of(&text).ok_or_else(|| "Git has no stored credential for github.com.".to_string())
}

fn password_of(credential: &str) -> Option<String> {
    credential
        .lines()
        .find_map(|line| line.strip_prefix("password="))
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_password_of_a_credential() {
        assert_eq!(password_of("protocol=https\nhost=github.com\nusername=ana\npassword=gho_abc\n").as_deref(), Some("gho_abc"));
        assert_eq!(password_of("protocol=https\nhost=github.com\n"), None);
        assert_eq!(password_of("password=\n"), None);
    }

    #[test]
    fn device_codes_come_in_github_spelling() {
        let code: DeviceCode = serde_json::from_value(serde_json::json!({
            "device_code": "dc", "user_code": "WDJB-MJHT", "verification_uri": "https://github.com/login/device",
            "expires_in": 900, "interval": 5
        }))
        .unwrap();
        let out = serde_json::to_value(&code).unwrap();
        assert_eq!(out["userCode"], "WDJB-MJHT");
        assert_eq!(out["deviceCode"], "dc");
        assert_eq!(out["interval"], 5);
    }
}
