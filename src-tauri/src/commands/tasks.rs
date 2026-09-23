use std::fs;

use tauri::AppHandle;

use crate::config::{app_config_dir, UserConfig};
use crate::error::io_error;
use crate::tasks::{parse_tasks, TaskSpec};

/// File name of the global task list, stored next to `user.json`.
const TASKS_FILE: &str = "tasks.json";

/// Load the global `tasks.json` from the app config directory. Returns `None`
/// when the file does not exist, and a readable error when the file is invalid
/// JSON or its shape is wrong.
#[tauri::command]
pub fn load_tasks(app: AppHandle) -> Result<Option<Vec<TaskSpec>>, String> {
    let Some(dir) = app_config_dir(&app) else {
        return Ok(None);
    };
    let path = dir.join(TASKS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| io_error("read the tasks file", e))?;
    parse_tasks(&text).map(Some)
}

/// The user configuration: keybindings merged over the built-in defaults, plus
/// an optional notice when the stored file could not be read.
#[tauri::command]
pub fn get_user_config(app: tauri::AppHandle) -> Result<UserConfig, String> {
    Ok(crate::config::load(&app))
}