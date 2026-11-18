mod error;
mod extensions;
mod exthost;
mod webview;
mod fs;
mod git;
mod profiles;
mod remote;
mod search;
mod terminal;
mod wsl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::Terminals::default())
        .manage(search::Searches::default())
        .manage(remote::Remotes::default())
        .manage(exthost::ExtensionHost::default())
        .manage(webview::Webviews::default())
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
            git::git_commit_details,
            git::git_show_at,
            git::git_checkout_revision,
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
            extensions::extensions_uninstall,
            extensions::extensions_read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
