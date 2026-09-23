use std::fs;

use tauri::AppHandle;

use crate::config::{app_config_dir, UserConfig, UserConfigFile};

/// Global configuration files the Settings UI may open/edit. Everything else
/// is rejected so the commands cannot touch arbitrary paths.
const GLOBAL_CONFIG_FILES: &[&str] = &["tasks.json"];

fn global_file_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir =
        app_config_dir(app).ok_or_else(|| "Failed to resolve the config directory".to_string())?;
    if !GLOBAL_CONFIG_FILES.contains(&name) {
        return Err(format!("Not a config file: {name}"));
    }
    Ok(dir.join(name))
}

#[tauri::command]
pub fn get_user_config(app: AppHandle) -> Result<UserConfig, String> {
    Ok(crate::config::load(&app))
}

#[tauri::command]
pub fn set_user_config(app: AppHandle, config: UserConfigFile) -> Result<(), String> {
    crate::config::save(&app, config)
}

#[tauri::command]
pub fn read_global_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = global_file_path(&app, &name)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|err| format!("Failed to read the file: {err}"))
}

#[tauri::command]
pub fn write_global_file(app: AppHandle, name: String, content: String) -> Result<(), String> {
    let path = global_file_path(&app, &name)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Invalid config file path".to_string())?;
    fs::create_dir_all(dir)
        .map_err(|err| format!("Failed to create the config directory: {err}"))?;
    fs::write(&path, content).map_err(|err| format!("Failed to write the file: {err}"))
}