mod ai;
mod cli;
mod error;
mod extensions;
mod exthost;
mod webview;
mod fs;
mod git;
mod github_auth;
mod jumplist;
mod profiles;
mod remote;
mod remote_exthost;
mod search;
mod secrets;
mod system;
mod terminal;
mod wsl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any window: the taskbar groups it with the Start menu shortcut and its jump list.
    jumplist::set_app_id();
    let args: Vec<String> = std::env::args().collect();
    let mut builder = tauri::Builder::default();
    // A later `powercode <path>` hands its paths to the running window and exits; one
    // started with `--new-window` (New Window, `powercode -n`) is a window of its own.
    // Debug builds (`tauri dev`) share the identifier with the installed app: they
    // would hand over to it and exit, so they always run on their own.
    if !cfg!(debug_assertions) && !cli::wants_new_window(&args) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            cli::deliver(app, cli::parse_args(&argv, std::path::Path::new(&cwd)));
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(terminal::Terminals::default())
        .manage(search::Searches::default())
        .manage(remote::shared())
        .manage(exthost::ExtensionHost::default())
        .manage(webview::Webviews::default())
        .manage(cli::CliState::from_process())
        .manage(secrets::Secrets::default())
        .manage(std::sync::Arc::new(ai::AiRuns::default()))
        .setup(|app| {
            use tauri::Manager;
            if let Ok(data) = app.path().app_data_dir() {
                system::setup_on_first_run(&data);
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(webview::SCHEME, webview::handle)
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::list_project_files,
            fs::read_text_file,
            fs::write_text_file,
            fs::create_file,
            fs::create_dir,
            fs::rename_path,
            fs::delete_path,
            fs::fs_signatures,
            terminal::terminal_spawn,
            profiles::terminal_profiles,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            search::search_in_files,
            git::git_status,
            git::git_show_head,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_init,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_log,
            git::git_commit_context,
            git::git_commit_details,
            git::git_show_at,
            git::git_checkout_revision,
            git::git_remove_index_lock,
            remote::remote_hosts,
            remote::remote_add_ssh_host,
            remote::remote_home,
            remote::remote_disconnect,
            exthost::exthost_start,
            exthost::exthost_send,
            exthost::exthost_stop,
            webview::webview_set_html,
            webview::webview_dispose,
            extensions::openvsx_search,
            extensions::openvsx_details,
            extensions::openvsx_latest_versions,
            extensions::extensions_list,
            extensions::extensions_install,
            extensions::extensions_install_vsix,
            extensions::extensions_uninstall,
            extensions::extensions_set_enabled,
            extensions::extensions_download_size,
            extensions::extensions_cancel_install,
            extensions::extensions_read_file,
            cli::cli_take_pending,
            cli::cli_launch_info,
            cli::cli_new_window,
            jumplist::system_update_jump_list,
            ai::ai_detect,
            ai::ai_models,
            ai::ai_run,
            ai::ai_cancel,
            ai::ai_save_image,
            github_auth::github_device_start,
            github_auth::github_device_check,
            github_auth::github_user,
            github_auth::github_cli_token,
            github_auth::github_git_credential,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            remote_exthost::remote_exthost_prepare,
            system::system_integration_status,
            system::system_install_command,
            system::system_uninstall_command,
            system::system_register_open_with,
            system::system_unregister_open_with,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers "Open With" and Dock drops as events, not arguments.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let cwd = std::env::current_dir().unwrap_or_default();
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let argv: Vec<String> = std::iter::once(String::new()).chain(paths).collect();
                cli::deliver(_app, cli::parse_args(&argv, &cwd));
            }
        });
}
