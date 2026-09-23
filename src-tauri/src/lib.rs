pub mod commands;
mod error;
mod state;
mod watcher;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::fs::list_dir,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::create_file,
            commands::fs::create_dir,
            commands::fs::rename_entry,
            commands::fs::delete_entry,
            commands::fs::set_workspace,
            commands::fs::get_workspace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}