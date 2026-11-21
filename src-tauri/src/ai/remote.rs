//! AI command transport for the host owning a remote workspace.

use super::*;
use crate::remote::quote;
use crate::remote_exthost::{run_script, script_command, RemoteTarget};

#[derive(Clone, Debug)]
pub(super) struct Workspace {
    pub target: RemoteTarget,
    pub cwd: String,
}

impl Workspace {
    pub fn parse(path: &str) -> Option<Self> {
        if let Some((host, cwd)) = crate::remote::parse(path) {
            Some(Self { target: RemoteTarget::Ssh { host: host.into() }, cwd })
        } else {
            crate::wsl::parse_share(path).map(|(distro, cwd)| Self { target: RemoteTarget::Wsl { distro }, cwd })
        }
    }

    /// Login startup files provide version managers; explicit paths cover GUI-only installs.
    pub fn command(&self, script: &str) -> Command {
        let setup = r#"export PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.bun/bin:$HOME/.opencode/bin:$HOME/.agy/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.cargo/bin:$PATH"; if ! command -v node >/dev/null 2>&1; then for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/aliases/default/bin; do [ ! -d "$d" ] || PATH="$d:$PATH"; done; export PATH; fi; unset CLAUDECODE; "#;
        let posix = format!("exec sh -c {}", quote(&format!("{setup}{script}")));
        script_command(&self.target, &format!("exec \"${{SHELL:-/bin/sh}}\" -lc {}", quote(&posix)))
    }

    pub fn output(&self, script: &str, timeout: Duration) -> CmdResult<String> {
        output_command_within(self.command(script), timeout).ok_or_else(|| "Remote AI command failed or timed out. Check the host connection and AI installation.".into())
    }

    pub fn detect(&self, paths: &HashMap<String, String>) -> CmdResult<Vec<AiProvider>> {
        let mut script = String::new();
        for kind in KINDS {
            let configured = paths.get(kind.id()).filter(|p| p.starts_with('/'));
            script.push_str(&format!(
                "p={}; if [ ! -x \"$p\" ]; then p=$(command -v {} 2>/dev/null || true); fi; ",
                quote(configured.map(String::as_str).unwrap_or("")), quote(kind.program())
            ));
            // The remote extension host installs platform-specific extension binaries here.
            let pattern = match kind {
                Kind::Claude => Some("\"$HOME\"/.powercode-server/extensions/anthropic.claude-code/resources/native-binary/claude \"$HOME\"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude"),
                Kind::Codex => Some("\"$HOME\"/.powercode-server/extensions/openai.chatgpt/bin/*/codex \"$HOME\"/.vscode-server/extensions/openai.chatgpt-*/bin/*/codex"),
                _ => None,
            };
            script.push_str("b=0; ");
            if let Some(pattern) = pattern {
                script.push_str(&format!("if [ -z \"$p\" ]; then for f in {pattern}; do if [ -x \"$f\" ]; then p=$f; b=1; break; fi; done; fi; "));
            }
            script.push_str(&format!(
                "if [ -n \"$p\" ]; then printf '__PC_AI__\\t{}\\t%s\\t%s\\n' \"$p\" \"$b\"; fi;\n", kind.id()
            ));
        }
        let output = self.output(&script, Duration::from_secs(30))?;
        Ok(output.lines().filter_map(|line| {
            let mut fields = line.strip_prefix("__PC_AI__\t")?.split('\t');
            let kind = Kind::parse(fields.next()?).ok()?;
            Some(AiProvider { id: kind.id().into(), name: kind.name().into(), path: fields.next()?.into(), version: None, bundled: fields.next() == Some("1") })
        }).collect())
    }

    pub fn models(&self, kind: Kind, path: &str) -> CmdResult<Vec<AiModel>> {
        if kind == Kind::Claude { return Ok(claude_models()); }
        let script = if kind == Kind::Codex {
            "cat \"${CODEX_HOME:-$HOME/.codex}/models_cache.json\" 2>/dev/null || true".into()
        } else {
            format!("exec {} models", quote(path))
        };
        let output = self.output(&script, Duration::from_secs(60))?;
        Ok(match kind {
            Kind::Codex => codex_models(&output),
            Kind::OpenCode => opencode_models(&output),
            Kind::Antigravity => antigravity_models(&output),
            Kind::Claude => unreachable!(),
        })
    }

    pub fn cancel(&self, pid: u32) {
        // setsid gives the assistant and its tools a group independent of SSH/wsl.exe.
        let _ = self.output(&format!("kill -TERM -- -{pid} 2>/dev/null || kill -TERM {pid} 2>/dev/null || true"), Duration::from_secs(10));
    }

    pub fn prepare(&self, request: &mut AiRequest) -> CmdResult<Option<String>> {
        request.cwd = self.cwd.clone();
        if request.attachments.is_empty() { return Ok(None); }
        // One archive upload, rather than one SSH/WSL process for each attachment.
        let mut archive = tar::Builder::new(Vec::new());
        let mut names = Vec::new();
        for (index, path) in request.attachments.iter().enumerate() {
            let name = format!("{index}-{}", Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or("attachment"));
            let bytes = if let Some(source) = Self::parse(path) {
                if !same_target(&source.target, &self.target) { return Err("Attachments from another remote host are not supported.".into()); }
                // Files already on this host can be opened directly.
                names.push((path.clone(), source.cwd));
                continue;
            } else { std::fs::read(path).map_err(err)? };
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o600);
            header.set_cksum();
            archive.append_data(&mut header, &name, bytes.as_slice()).map_err(err)?;
            names.push((path.clone(), name));
        }
        if names.iter().all(|(_, path)| path.starts_with('/')) {
            request.attachments = names.into_iter().map(|(old, path)| {
                request.prompt = request.prompt.replace(&old, &path);
                path
            }).collect();
            return Ok(None);
        }
        let data = archive.into_inner().map_err(err)?;
        let dir = run_script(&self.target, "umask 077; d=$(mktemp -d /tmp/powercode-ai-XXXXXXXX) || exit; if tar -xf - -C \"$d\"; then printf '%s' \"$d\"; else rm -rf -- \"$d\"; exit 1; fi", Some(data))?;
        let dir = dir.trim().to_string();
        if !dir.strip_prefix("/tmp/powercode-ai-").is_some_and(|suffix| suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_alphanumeric())) {
            return Err("Invalid remote attachment directory.".into());
        }
        request.attachments = names.into_iter().map(|(old, name)| {
            let path = if name.starts_with('/') { name } else { format!("{dir}/{name}") };
            request.prompt = request.prompt.replace(&old, &path);
            path
        }).collect();
        Ok(Some(dir))
    }

    pub fn cleanup(&self, dir: &str) {
        let _ = self.output(&format!("rm -rf -- {}", quote(dir)), Duration::from_secs(10));
    }

    pub fn run_command(&self, kind: Kind, request: &AiRequest) -> Command {
        let args = arguments(kind, request).iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
        let run = format!("printf '__PC_AI_PID__%s\\n' \"$$\"; cd {} && exec {} {args}", quote(&self.cwd), quote(&request.path));
        self.command(&format!("if command -v setsid >/dev/null 2>&1; then exec setsid sh -c {r}; else exec sh -c {r}; fi", r = quote(&run)))
    }
}

fn same_target(a: &RemoteTarget, b: &RemoteTarget) -> bool {
    match (a, b) {
        (RemoteTarget::Ssh { host: a }, RemoteTarget::Ssh { host: b }) => a == b,
        (RemoteTarget::Wsl { distro: a }, RemoteTarget::Wsl { distro: b }) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspaces_keep_the_host_and_translate_the_directory() {
        let ssh = Workspace::parse("ssh://user@build/home/me/project's files").unwrap();
        assert!(matches!(ssh.target, RemoteTarget::Ssh { ref host } if host == "user@build"));
        assert_eq!(ssh.cwd, "/home/me/project's files");
        let wsl = Workspace::parse(r"\\wsl.localhost\Ubuntu\home\me\project").unwrap();
        assert!(matches!(wsl.target, RemoteTarget::Wsl { ref distro } if distro == "Ubuntu"));
        assert_eq!(wsl.cwd, "/home/me/project");
        assert!(Workspace::parse(r"C:\projects\local").is_none());
    }

    #[test]
    fn attachments_on_the_same_host_are_translated_without_uploading() {
        let workspace = Workspace::parse("ssh://build/home/me/project").unwrap();
        let mut request = AiRequest {
            provider: "claude".into(), path: "/usr/bin/claude".into(), model: None,
            prompt: "Look at ssh://build/home/me/picture.png".into(), cwd: "ssh://build/home/me/project".into(),
            agent: false, session: None, one_shot: false, attachments: vec!["ssh://build/home/me/picture.png".into()],
        };
        assert_eq!(workspace.prepare(&mut request).unwrap(), None);
        assert_eq!(request.cwd, "/home/me/project");
        assert_eq!(request.attachments, ["/home/me/picture.png"]);
        assert_eq!(request.prompt, "Look at /home/me/picture.png");
        request.attachments = vec!["ssh://another-host/home/me/picture.png".into()];
        assert!(workspace.prepare(&mut request).unwrap_err().contains("another remote host"));
    }

    #[test]
    fn commands_use_the_workspace_transport_without_a_local_working_directory() {
        let ssh = Workspace::parse("ssh://build/home/me/project").unwrap().command("pwd");
        assert_eq!(ssh.get_program(), "ssh");
        assert_eq!(ssh.get_current_dir(), None);
        assert!(ssh.get_args().any(|arg| arg == "build"));
        assert!(ssh.get_args().any(|arg| arg == "BatchMode=yes"));
        let wsl = Workspace::parse(r"\\wsl$\Ubuntu\home\me").unwrap().command("pwd");
        assert_eq!(wsl.get_program(), "wsl.exe");
        assert_eq!(wsl.get_current_dir(), None);
        let args: Vec<_> = wsl.get_args().map(|arg| arg.to_str().unwrap()).collect();
        assert_eq!(&args[..6], ["-d", "Ubuntu", "--cd", "/", "--exec", "sh"]);
    }

    #[test]
    fn remote_envelope_preserves_stdin_and_shell_metacharacters() {
        let workspace = Workspace::parse("ssh://build/tmp").unwrap();
        let script = format!("printf '%s\\n' {}; cat", quote("a'b $(printf INJECTED); $HOME"));
        let command = workspace.command(&script);
        // A local POSIX shell stands in for sshd. No network or AI account is used.
        let shell = if cfg!(windows) { "C:/Program Files/Git/bin/sh.exe" } else { "sh" };
        let mut child = Command::new(shell).args(["-c", command.get_args().last().unwrap().to_str().unwrap()])
            .env("SHELL", "/bin/sh").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("POSIX shell");
        child.stdin.take().unwrap().write_all(b"prompt with newlines\nand Unicode: ol\xc3\xa1").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "a'b $(printf INJECTED); $HOME\nprompt with newlines\nand Unicode: olá");
    }

    #[test]
    fn remote_run_quotes_model_session_and_working_directory() {
        let workspace = Workspace::parse("ssh://build/tmp").unwrap();
        let request = AiRequest {
            provider: "codex".into(), path: "/bin/echo".into(), model: Some("model'; printf INJECTED; echo '".into()),
            prompt: String::new(), cwd: workspace.cwd.clone(), agent: false, session: Some("session with spaces".into()),
            one_shot: false, attachments: vec!["/tmp/image with spaces.png".into()],
        };
        let command = workspace.run_command(Kind::Codex, &request);
        let shell = if cfg!(windows) { "C:/Program Files/Git/bin/sh.exe" } else { "sh" };
        let output = Command::new(shell).args(["-c", command.get_args().last().unwrap().to_str().unwrap()])
            .env("SHELL", "/bin/sh").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.lines().next().unwrap().starts_with("__PC_AI_PID__"));
        assert!(text.contains("model'; printf INJECTED; echo '"));
        assert!(text.contains("resume session with spaces"));
        assert!(text.contains("--image=/tmp/image with spaces.png"));
        assert_eq!(text.lines().count(), 2, "model must remain one argument");
    }
}
