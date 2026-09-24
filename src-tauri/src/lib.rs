pub mod commands;
mod config;
mod error;
mod lsp;
mod session;
mod shell;
mod state;
mod tasks;
mod terminal;
mod watcher;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::fs::read_external_file,
            commands::fs::write_file,
            commands::fs::create_file,
            commands::fs::create_dir,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::fs::set_workspace,
            commands::fs::get_workspace,
            commands::fs::get_last_workspace,
            commands::search::list_workspace_files,
            commands::search::search_workspace,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_kill_all,
            commands::terminal::get_shells,
            commands::tasks::load_tasks,
            commands::config::get_user_config,
            commands::config::set_user_config,
            commands::config::read_global_file,
            commands::config::write_global_file,
            commands::lsp::lsp_start,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_notify,
            commands::lsp::lsp_request,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            state.kill_all_terminals();
            state.stop_all_lsp();
        }
    });
}