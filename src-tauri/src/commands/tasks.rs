use std::fs;

use tauri::State;

use crate::config::UserConfig;
use crate::error::io_error;
use crate::state::AppState;
use crate::tasks::{parse_tasks, TaskSpec};

/// Relative location of the workspace task list.
const TASKS_FILE: &str = ".lite-ide/tasks.json";

/// Load `.lite-ide/tasks.json` for the current workspace. Returns `None` when
/// there is no workspace or no task file, and a readable error when the file is
/// invalid JSON or its shape is wrong.
#[tauri::command]
pub fn load_workspace_tasks(
    state: State<'_, AppState>,
) -> Result<Option<Vec<TaskSpec>>, String> {
    let Some(workspace) = state.workspace()? else {
        return Ok(None);
    };
    let path = workspace.join(TASKS_FILE);
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