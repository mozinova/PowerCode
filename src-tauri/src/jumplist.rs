//! The Windows jump list: right-clicking PowerCode on the taskbar or in the Start
//! menu shows "New Window" and the recent projects. The process takes the same
//! AppUserModelID as the installer's shortcut, so the running window, the pinned
//! icon and the jump list belong together.

/// The bundle identifier (`tauri.conf.json`), which the installer's shortcut uses as its AppUserModelID.
pub const APP_ID: &str = "com.mozin.powercode";

/// Gives the process the shortcut's AppUserModelID; call before any window exists.
pub fn set_app_id() {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(APP_ID));
    }
}

/// Arguments that open `path` the way `powercode <path>` does (quoted; no trailing
/// backslash before the closing quote, which would escape it).
fn open_arguments(path: &str) -> String {
    let trimmed = path.trim_end_matches('\\');
    // A drive root keeps its backslash, doubled so it does not escape the quote.
    let path = if trimmed.ends_with(':') { format!("{trimmed}\\\\") } else { trimmed.to_string() };
    format!("-- \"{path}\"")
}

/// The name shown for a recent project: its folder's name.
fn project_name(path: &str) -> String {
    path.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().filter(|n| !n.is_empty()).unwrap_or(path).to_string()
}

#[cfg(windows)]
mod imp {
    use windows::core::{Interface, Result, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink};

    fn link(exe: &str, arguments: &str, title: &str, description: &str, icon: (&str, i32)) -> Result<IShellLinkW> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe))?;
            link.SetArguments(&HSTRING::from(arguments))?;
            link.SetDescription(&HSTRING::from(description))?;
            link.SetIconLocation(&HSTRING::from(icon.0), icon.1)?;
            // A jump list item's text is its title property, not the link's name.
            let store: IPropertyStore = link.cast()?;
            store.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
            store.Commit()?;
            Ok(link)
        }
    }

    pub fn update(app_id: &str, recent: &[String]) -> Result<()> {
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let folder_icon = format!("{}\\System32\\imageres.dll", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()));
        unsafe {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.SetAppID(&HSTRING::from(app_id))?;
            let mut slots = 0u32;
            // Items the user removed from the list must not come back.
            let removed: IObjectArray = list.BeginList(&mut slots)?;
            let mut removed_arguments = Vec::new();
            for i in 0..removed.GetCount()? {
                if let Ok(item) = removed.GetAt::<IShellLinkW>(i) {
                    let mut buffer = [0u16; 2048];
                    if item.GetArguments(&mut buffer).is_ok() {
                        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                        removed_arguments.push(String::from_utf16_lossy(&buffer[..end]));
                    }
                }
            }

            let projects: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for path in recent {
                let arguments = super::open_arguments(path);
                if removed_arguments.contains(&arguments) {
                    continue;
                }
                // imageres.dll #3 is the folder icon.
                projects.AddObject(&link(&exe, &arguments, &super::project_name(path), path, (&folder_icon, 3))?)?;
            }
            if projects.GetCount()? > 0 {
                list.AppendCategory(&HSTRING::from("Recent"), &projects.cast::<IObjectArray>()?)?;
            }

            let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            tasks.AddObject(&link(&exe, crate::cli::NEW_WINDOW_FLAG, "New Window", "Open a new PowerCode window", (&exe, 0))?)?;
            list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
            list.CommitList()?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn delete(app_id: &str) -> Result<()> {
        unsafe {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            list.DeleteList(&HSTRING::from(app_id))
        }
    }

    /// Runs `f` on a thread of its own with COM initialized (the command threads' COM state is not ours).
    pub fn on_com_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::spawn(move || unsafe {
            let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let result = f();
            if initialized {
                CoUninitialize();
            }
            result
        })
        .join()
        .expect("jump list thread panicked")
    }
}

/// Rebuilds the jump list with `recent` projects (most recent first). Other systems: nothing.
#[tauri::command(async)]
pub fn system_update_jump_list(recent: Vec<String>) -> crate::error::CmdResult<()> {
    #[cfg(windows)]
    {
        // Remote projects open through `powercode <path>` too (SSH as `ssh://host/path`).
        let recent: Vec<String> = recent.into_iter().take(10).collect();
        imp::on_com_thread(move || imp::update(APP_ID, &recent)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = recent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_id_is_the_bundle_identifier() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"].as_str(), Some(APP_ID));
    }

    /// Builds a real jump list under an AppUserModelID of its own (not the installed
    /// app's), then removes it.
    #[cfg(windows)]
    #[test]
    fn builds_a_jump_list() {
        let app_id = "com.mozin.powercode.test";
        let recent = vec!["C:\\work\\my app".to_string(), "\\\\wsl.localhost\\Ubuntu\\home\\me".to_string(), "ssh://host/srv".to_string()];
        let result = imp::on_com_thread(move || {
            let built = imp::update(app_id, &recent);
            let deleted = imp::delete(app_id);
            built.and(deleted)
        });
        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn recent_projects_open_with_quoted_paths() {
        assert_eq!(open_arguments("C:\\work\\my app"), "-- \"C:\\work\\my app\"");
        assert_eq!(open_arguments("C:\\work\\"), "-- \"C:\\work\"");
        assert_eq!(open_arguments("C:\\"), "-- \"C:\\\\\"");
        assert_eq!(project_name("C:\\work\\my app\\"), "my app");
        assert_eq!(project_name("ssh://host/home/me/site"), "site");
        assert_eq!(project_name("\\\\wsl.localhost\\Ubuntu\\home\\me\\api"), "api");
    }
}
