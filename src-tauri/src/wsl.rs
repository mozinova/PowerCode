//! WSL distributions are opened through their `\\wsl.localhost\<distro>` share,
//! so files work like local ones; commands (terminal, git) run inside the
//! distribution with `wsl.exe`.

use std::process::Command;

use crate::error::{err, CmdResult};

const SHARE_PREFIXES: &[&str] = &[r"\\wsl.localhost\", r"\\wsl$\"];

/// Splits a WSL share path into its distribution and Linux path, e.g.
/// `\\wsl.localhost\Ubuntu\home\me` -> (`Ubuntu`, `/home/me`).
pub fn parse_share(path: &str) -> Option<(String, String)> {
    let prefix = SHARE_PREFIXES
        .iter()
        .find(|p| path.len() > p.len() && path[..p.len()].eq_ignore_ascii_case(p))?;
    let rest = &path[prefix.len()..];
    let (distro, linux) = rest.split_once('\\').unwrap_or((rest, ""));
    Some((distro.to_string(), format!("/{}", linux.replace('\\', "/").trim_end_matches('/'))))
}

/// The Windows share path of a Linux path inside `distro`.
pub fn to_share(distro: &str, linux: &str) -> String {
    format!(r"\\wsl.localhost\{distro}{}", linux.trim_end_matches('/').replace('/', "\\"))
}

/// A `wsl.exe` command running `program` inside `distro`, from `linux_dir`.
pub fn command(distro: &str, linux_dir: &str, program: &str) -> Command {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["-d", distro, "--cd", linux_dir, "--exec", program]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `wsl.exe` prints UTF-16LE when listing distributions.
fn decode_wsl_output(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}

/// Installed distributions; empty where WSL is unavailable.
pub fn distributions() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--list", "--quiet"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(output) = cmd.output() else { return Vec::new() };
    if !output.status.success() {
        return Vec::new();
    }
    decode_wsl_output(&output.stdout)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The user's home directory inside `distro`, as a share path.
pub fn home(distro: &str) -> CmdResult<String> {
    let output = command(distro, "~", "sh")
        .args(["-c", "printf %s \"$HOME\""])
        .output()
        .map_err(err)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(to_share(distro, &String::from_utf8_lossy(&output.stdout)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_paths_round_trip() {
        assert_eq!(
            parse_share(r"\\wsl.localhost\Ubuntu\home\me\proj"),
            Some(("Ubuntu".into(), "/home/me/proj".into()))
        );
        assert_eq!(parse_share(r"\\WSL$\Debian"), Some(("Debian".into(), "/".into())));
        assert_eq!(parse_share(r"C:\Users\me"), None);
        assert_eq!(to_share("Ubuntu", "/home/me/proj"), r"\\wsl.localhost\Ubuntu\home\me\proj");
    }

    #[test]
    fn decodes_utf16_listing() {
        let bytes: Vec<u8> = "Ubuntu\r\nDebian\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode_wsl_output(&bytes).lines().collect::<Vec<_>>(), vec!["Ubuntu", "Debian"]);
    }
}

/// Exercises a real distribution when one is installed: home, share access and git inside WSL.
#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    #[test]
    fn home_and_git_in_the_first_distribution() {
        let Some(distro) = distributions().into_iter().next() else {
            eprintln!("skipped: no WSL distribution");
            return;
        };
        let home = home(&distro).expect("home");
        assert!(home.starts_with(r"\\wsl.localhost\"), "{home}");
        assert!(std::path::Path::new(&home).is_dir(), "share not reachable: {home}");

        let (_, linux_home) = parse_share(&home).unwrap();
        let output = command(&distro, &linux_home, "git").arg("--version").output().expect("wsl git");
        if output.status.success() {
            assert!(String::from_utf8_lossy(&output.stdout).starts_with("git version"));
        } else {
            eprintln!("git is not installed in {distro}");
        }
    }
}
