//! Integration with the OS: the `powercode` shell command on the PATH, and
//! PowerCode in "Open with" (and Explorer's context menus on Windows). All of
//! it is per user; nothing becomes the default app for a file type.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::error::{err, CmdResult};

const COMMAND: &str = "powercode";

/// Extensions PowerCode offers to open in "Open with" (code and text files).
const EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonc", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "css", "scss", "less",
    "html", "htm", "xml", "svg", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log", "csv", "tsv", "py", "pyi", "rs",
    "go", "java", "kt", "kts", "scala", "c", "h", "cpp", "hpp", "cc", "cs", "fs", "php", "rb", "lua", "swift", "dart",
    "vue", "svelte", "astro", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "sql", "graphql", "gql",
    "prisma", "proto", "tf", "gradle", "lock", "gitignore", "gitattributes", "editorconfig", "dockerignore",
];

/// The program the shell command and "Open with" start: the installed app
/// (the AppImage itself, not its temporary mount).
fn app_executable() -> CmdResult<PathBuf> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(appimage));
    }
    std::env::current_exe().map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    /// Where the shell command is (or would be) installed.
    command_path: String,
    /// The shell command exists and starts this PowerCode.
    command_installed: bool,
    /// Its folder is on the user's PATH (a new terminal will find it).
    command_on_path: bool,
    /// PowerCode is offered in "Open with".
    open_with_registered: bool,
    /// "Open with" can be set up from the app on this OS (on macOS the app bundle declares it).
    open_with_supported: bool,
}

// ---- The shell command -------------------------------------------------------------

#[cfg(windows)]
fn command_dir() -> CmdResult<PathBuf> {
    Ok(dirs::data_local_dir().ok_or("No local app data folder.")?.join("PowerCode").join("bin"))
}

#[cfg(target_os = "macos")]
fn command_dir() -> CmdResult<PathBuf> {
    Ok(PathBuf::from("/usr/local/bin"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command_dir() -> CmdResult<PathBuf> {
    Ok(dirs::home_dir().ok_or("No home folder.")?.join(".local").join("bin"))
}

fn command_path() -> CmdResult<PathBuf> {
    Ok(command_dir()?.join(if cfg!(windows) { format!("{COMMAND}.cmd") } else { COMMAND.to_string() }))
}

/// The launcher script: starts PowerCode in the background with the arguments
/// (relative paths resolve against the caller's directory, which it inherits).
fn launcher(exe: &Path) -> String {
    if cfg!(windows) {
        format!("@echo off\r\nrem PowerCode command line launcher (installed by PowerCode).\r\nstart \"\" \"{}\" %*\r\n", exe.display())
    } else {
        format!(
            "#!/bin/sh\n# PowerCode command line launcher (installed by PowerCode).\n{} \"$@\" >/dev/null 2>&1 &\n",
            crate::remote::quote(&exe.to_string_lossy())
        )
    }
}

fn path_entries() -> Vec<PathBuf> {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let normalize = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    if cfg!(windows) { normalize(a) == normalize(b) } else { a == b }
}

#[cfg(windows)]
mod windows_path {
    //! The user's PATH in the registry (`HKCU\Environment`), kept as REG_EXPAND_SZ
    //! so entries like `%USERPROFILE%\bin` keep working.
    use super::*;
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    fn environment() -> CmdResult<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE).map_err(err)
    }

    /// The raw (unexpanded) user PATH.
    fn read() -> CmdResult<String> {
        match environment()?.get_raw_value("Path") {
            Ok(value) => {
                let wide: Vec<u16> = value.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                Ok(String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string())
            }
            Err(_) => Ok(String::new()),
        }
    }

    fn write(path: &str) -> CmdResult<()> {
        let mut bytes: Vec<u8> = path.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect();
        bytes.shrink_to_fit();
        environment()?.set_raw_value("Path", &RegValue { vtype: RegType::REG_EXPAND_SZ, bytes: bytes.into() }).map_err(err)?;
        broadcast_environment_change();
        Ok(())
    }

    /// Tells Explorer (and so new terminals) that the environment changed.
    fn broadcast_environment_change() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let name: Vec<u16> = "Environment".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, name.as_ptr() as isize, SMTO_ABORTIFHUNG, 2000, std::ptr::null_mut());
        }
    }

    #[cfg(test)]
    pub fn read_for_tests() -> String {
        read().unwrap_or_default()
    }

    pub fn contains(dir: &Path) -> bool {
        read().map(|p| p.split(';').any(|e| same_dir(Path::new(e), dir))).unwrap_or(false)
    }

    pub fn add(dir: &Path) -> CmdResult<()> {
        if contains(dir) {
            return Ok(());
        }
        let current = read()?;
        let entry = dir.to_string_lossy();
        write(&if current.trim().is_empty() { entry.into_owned() } else { format!("{};{entry}", current.trim_end_matches(';')) })
    }

    pub fn remove(dir: &Path) -> CmdResult<()> {
        let current = read()?;
        let kept: Vec<&str> = current.split(';').filter(|e| !e.is_empty() && !same_dir(Path::new(e), dir)).collect();
        write(&kept.join(";"))
    }
}

/// Puts `dir` on this process's PATH too, so PowerCode's own terminals find the command at once.
fn add_to_process_path(dir: &Path) {
    let mut entries = path_entries();
    if !entries.iter().any(|e| same_dir(e, dir)) {
        entries.push(dir.to_path_buf());
        if let Ok(joined) = std::env::join_paths(entries) {
            // Safety: called from command handlers, not while other threads read the environment concurrently in practice.
            unsafe { std::env::set_var("PATH", joined) };
        }
    }
}

fn install_command() -> CmdResult<()> {
    let exe = app_executable()?;
    let path = command_path()?;
    let dir = command_dir()?;
    let script = launcher(&exe);
    #[cfg(target_os = "macos")]
    {
        // /usr/local/bin belongs to root: copy the script there with the user's permission, as VS Code does.
        let temp = std::env::temp_dir().join(format!("powercode-launcher-{}", std::process::id()));
        std::fs::write(&temp, &script).map_err(err)?;
        let shell = format!(
            "mkdir -p {dir} && cp {src} {dst} && chmod 755 {dst}",
            dir = crate::remote::quote(&dir.to_string_lossy()),
            src = crate::remote::quote(&temp.to_string_lossy()),
            dst = crate::remote::quote(&path.to_string_lossy()),
        );
        let apple_script = format!(
            "do shell script \"{}\" with administrator privileges",
            shell.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let status = std::process::Command::new("osascript").args(["-e", &apple_script]).status().map_err(err)?;
        let _ = std::fs::remove_file(&temp);
        if !status.success() {
            return Err("The shell command was not installed (permission was not granted).".into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::create_dir_all(&dir).map_err(err)?;
        std::fs::write(&path, script).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
        }
    }
    #[cfg(windows)]
    windows_path::add(&dir)?;
    add_to_process_path(&dir);
    Ok(())
}

fn uninstall_command() -> CmdResult<()> {
    let path = command_path()?;
    #[cfg(target_os = "macos")]
    {
        if path.exists() {
            let apple_script = format!(
                "do shell script \"rm -f {}\" with administrator privileges",
                crate::remote::quote(&path.to_string_lossy()).replace('"', "\\\"")
            );
            let status = std::process::Command::new("osascript").args(["-e", &apple_script]).status().map_err(err)?;
            if !status.success() {
                return Err("The shell command was not removed (permission was not granted).".into());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if path.exists() {
            std::fs::remove_file(&path).map_err(err)?;
        }
    }
    #[cfg(windows)]
    windows_path::remove(&command_dir()?)?;
    Ok(())
}

fn command_installed() -> bool {
    let (Ok(path), Ok(exe)) = (command_path(), app_executable()) else { return false };
    std::fs::read_to_string(path).is_ok_and(|script| script == launcher(&exe))
}

fn command_on_path() -> bool {
    let Ok(dir) = command_dir() else { return false };
    #[cfg(windows)]
    if windows_path::contains(&dir) {
        return true;
    }
    path_entries().iter().any(|e| same_dir(e, &dir))
}

// ---- "Open with" ----------------------------------------------------------------------

#[cfg(windows)]
mod windows_open_with {
    //! Per-user registrations under `HKCU\Software\Classes`: a ProgID offered
    //! (not set as default) for code extensions, the app's "Open with" entry,
    //! and "Open with PowerCode" on files, folders and folder backgrounds.
    use super::*;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const PROG_ID: &str = "PowerCode.File";
    const MENU_KEY: &str = "PowerCode";
    const MENU_LABEL: &str = "Open with PowerCode";

    fn classes() -> CmdResult<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software\\Classes", winreg::enums::KEY_ALL_ACCESS).map_err(err)
    }

    fn exe_name(exe: &Path) -> String {
        exe.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "powercode.exe".into())
    }

    fn set_default(key: &RegKey, path: &str, value: &str) -> CmdResult<RegKey> {
        let (sub, _) = key.create_subkey(path).map_err(err)?;
        sub.set_value("", &value).map_err(err)?;
        Ok(sub)
    }

    fn context_menu(classes: &RegKey, base: &str, exe: &Path, argument: &str) -> CmdResult<()> {
        let menu = set_default(classes, &format!("{base}\\shell\\{MENU_KEY}"), MENU_LABEL)?;
        menu.set_value("Icon", &format!("\"{}\"", exe.display())).map_err(err)?;
        set_default(classes, &format!("{base}\\shell\\{MENU_KEY}\\command"), &format!("\"{}\" \"{argument}\"", exe.display()))?;
        Ok(())
    }

    /// Tells Explorer the associations changed, so menus update without a restart.
    fn notify_shell() {
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null()) };
    }

    pub fn register(exe: &Path) -> CmdResult<()> {
        let classes = classes()?;
        let open = format!("\"{}\" \"%1\"", exe.display());

        let prog = set_default(&classes, PROG_ID, "PowerCode File")?;
        prog.set_value("FriendlyTypeName", &"PowerCode File").map_err(err)?;
        set_default(&classes, &format!("{PROG_ID}\\DefaultIcon"), &format!("\"{}\",0", exe.display()))?;
        set_default(&classes, &format!("{PROG_ID}\\shell\\open\\command"), &open)?;
        for ext in EXTENSIONS {
            let (list, _) = classes.create_subkey(format!(".{ext}\\OpenWithProgids")).map_err(err)?;
            list.set_value(PROG_ID, &"").map_err(err)?;
        }

        let app = format!("Applications\\{}", exe_name(exe));
        let (app_key, _) = classes.create_subkey(&app).map_err(err)?;
        app_key.set_value("FriendlyAppName", &"PowerCode").map_err(err)?;
        set_default(&classes, &format!("{app}\\shell\\open\\command"), &open)?;
        let (types, _) = classes.create_subkey(format!("{app}\\SupportedTypes")).map_err(err)?;
        for ext in EXTENSIONS {
            types.set_value(format!(".{ext}"), &"").map_err(err)?;
        }

        context_menu(&classes, "*", exe, "%1")?;
        context_menu(&classes, "Directory", exe, "%1")?;
        context_menu(&classes, "Directory\\Background", exe, "%V")?;
        notify_shell();
        Ok(())
    }

    pub fn unregister(exe: &Path) -> CmdResult<()> {
        let classes = classes()?;
        let _ = classes.delete_subkey_all(PROG_ID);
        for ext in EXTENSIONS {
            if let Ok(list) = classes.open_subkey_with_flags(format!(".{ext}\\OpenWithProgids"), winreg::enums::KEY_ALL_ACCESS) {
                let _ = list.delete_value(PROG_ID);
            }
        }
        let _ = classes.delete_subkey_all(format!("Applications\\{}", exe_name(exe)));
        for base in ["*", "Directory", "Directory\\Background"] {
            let _ = classes.delete_subkey_all(format!("{base}\\shell\\{MENU_KEY}"));
        }
        notify_shell();
        Ok(())
    }

    pub fn registered(exe: &Path) -> bool {
        classes()
            .and_then(|c| c.open_subkey(format!("{PROG_ID}\\shell\\open\\command")).map_err(err))
            .and_then(|k| k.get_value::<String, _>("").map_err(err))
            .is_ok_and(|command| command == format!("\"{}\" \"%1\"", exe.display()))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod linux_open_with {
    //! A desktop entry (hidden from launchers) declaring the MIME types PowerCode opens.
    use super::*;

    const MIME_TYPES: &str = "text/plain;text/markdown;text/x-markdown;application/json;application/javascript;text/javascript;\
application/typescript;text/x-typescript;text/css;text/html;application/xml;text/xml;application/x-yaml;text/x-python;\
text/x-rust;text/x-go;text/x-java;text/x-c;text/x-c++;text/x-csharp;application/x-shellscript;text/x-sql;application/toml;\
text/csv;inode/directory;";

    fn entry_path() -> CmdResult<PathBuf> {
        Ok(dirs::data_dir().ok_or("No data folder.")?.join("applications").join("powercode-open.desktop"))
    }

    fn entry(exe: &Path) -> String {
        format!(
            "[Desktop Entry]\nType=Application\nName=PowerCode\nComment=Open in PowerCode\nExec=\"{}\" %F\nIcon=powercode\nTerminal=false\nNoDisplay=true\nMimeType={MIME_TYPES}\n",
            exe.display()
        )
    }

    fn refresh() {
        if let Some(dir) = dirs::data_dir() {
            let _ = std::process::Command::new("update-desktop-database").arg(dir.join("applications")).status();
        }
    }

    pub fn register(exe: &Path) -> CmdResult<()> {
        let path = entry_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        std::fs::write(&path, entry(exe)).map_err(err)?;
        refresh();
        Ok(())
    }

    pub fn unregister(_exe: &Path) -> CmdResult<()> {
        let path = entry_path()?;
        if path.exists() {
            std::fs::remove_file(path).map_err(err)?;
        }
        refresh();
        Ok(())
    }

    pub fn registered(exe: &Path) -> bool {
        entry_path().ok().and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|text| text == entry(exe))
    }
}

fn register_open_with() -> CmdResult<()> {
    let _exe = app_executable()?;
    #[cfg(windows)]
    return windows_open_with::register(&_exe);
    #[cfg(all(unix, not(target_os = "macos")))]
    return linux_open_with::register(&_exe);
    #[cfg(target_os = "macos")]
    Err("On macOS, \"Open With\" comes from the installed app bundle.".into())
}

fn unregister_open_with() -> CmdResult<()> {
    let _exe = app_executable()?;
    #[cfg(windows)]
    return windows_open_with::unregister(&_exe);
    #[cfg(all(unix, not(target_os = "macos")))]
    return linux_open_with::unregister(&_exe);
    #[cfg(target_os = "macos")]
    Ok(())
}

fn open_with_registered() -> bool {
    let Ok(_exe) = app_executable() else { return false };
    #[cfg(windows)]
    return windows_open_with::registered(&_exe);
    #[cfg(all(unix, not(target_os = "macos")))]
    return linux_open_with::registered(&_exe);
    #[cfg(target_os = "macos")]
    true
}

// ---- Commands -------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn system_integration_status() -> CmdResult<IntegrationStatus> {
    Ok(IntegrationStatus {
        command_path: command_path()?.to_string_lossy().into_owned(),
        command_installed: command_installed(),
        command_on_path: command_on_path(),
        open_with_registered: open_with_registered(),
        open_with_supported: !cfg!(target_os = "macos"),
    })
}

#[tauri::command(async)]
pub fn system_install_command() -> CmdResult<()> {
    install_command()
}

#[tauri::command(async)]
pub fn system_uninstall_command() -> CmdResult<()> {
    uninstall_command()
}

#[tauri::command(async)]
pub fn system_register_open_with() -> CmdResult<()> {
    register_open_with()
}

#[tauri::command(async)]
pub fn system_unregister_open_with() -> CmdResult<()> {
    unregister_open_with()
}

/// Release builds set the integration up on their own (per user, no prompts), and
/// again when the app moved (e.g. after an update to another folder). macOS needs
/// a password for the shell command, so there it is left to the user.
pub fn setup_on_first_run(app_data: &Path) {
    if cfg!(debug_assertions) || cfg!(target_os = "macos") {
        return;
    }
    let Ok(exe) = app_executable() else { return };
    let marker = app_data.join("system-integration.json");
    let done_for = std::fs::read_to_string(&marker).ok();
    let current = serde_json::json!({ "executable": exe.to_string_lossy() }).to_string();
    if done_for.as_deref() == Some(current.as_str()) {
        return;
    }
    std::thread::spawn(move || {
        let command = install_command();
        let open_with = register_open_with();
        if command.is_ok() && open_with.is_ok() {
            let _ = std::fs::create_dir_all(marker.parent().unwrap_or(Path::new(".")));
            let _ = std::fs::write(&marker, current);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_scripts_pass_arguments_through() {
        let exe = if cfg!(windows) { PathBuf::from(r"C:\Program Files\PowerCode\PowerCode.exe") } else { PathBuf::from("/opt/Power Code/powercode") };
        let script = launcher(&exe);
        if cfg!(windows) {
            assert!(script.contains("start \"\" \"C:\\Program Files\\PowerCode\\PowerCode.exe\" %*"), "{script}");
        } else {
            assert!(script.starts_with("#!/bin/sh\n"));
            assert!(script.contains("'/opt/Power Code/powercode' \"$@\""), "{script}");
        }
    }

    /// Read-only: the user PATH as decoded here matches `reg query` (unexpanded).
    #[cfg(windows)]
    #[test]
    fn reads_the_user_path_unexpanded() {
        let output = std::process::Command::new("reg").args(["query", r"HKCU\Environment", "/v", "Path"]).output().unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(line) = text.lines().find(|l| l.trim_start().starts_with("Path")) else { return };
        let expected = line.split_once("REG_").map(|(_, rest)| rest.split_once("    ").map_or("", |(_, v)| v)).unwrap_or("").trim();
        assert_eq!(windows_path::read_for_tests().trim(), expected);
    }

    #[test]
    fn compares_path_entries_like_the_os() {
        assert!(same_dir(Path::new("/a/b/"), Path::new("/a/b")));
        if cfg!(windows) {
            assert!(same_dir(Path::new(r"C:\Users\Me\bin\"), Path::new(r"c:\users\me\BIN")));
        }
    }
}
