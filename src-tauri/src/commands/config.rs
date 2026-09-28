use std::fs;

use tauri::AppHandle;

use crate::config::{app_config_dir, UserConfig, UserConfigFile};

/// Global configuration files the Settings UI may open/edit. Everything else
/// is rejected so the commands cannot touch arbitrary paths.
///
/// `user.json` is the same file `crate::config::load`/`save` use; allowing it
/// here is what lets the Debug settings section open the real global config in
/// the editor instead of creating a second copy under the workspace.
///
/// `launch.json` is the global `launch.json` next to `user.json`: it says *how
/// to start a program*, while `user.json`'s `debug.adapters` says *how to start
/// the adapter*. It is read through this same command so there is exactly one
/// place that knows the app config directory.
const GLOBAL_CONFIG_FILES: &[&str] = &["tasks.json", "user.json", "launch.json"];

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

#[cfg(test)]
mod tests {
    use super::GLOBAL_CONFIG_FILES;

    /// The global `launch.json` is read through `read_global_file`, so the
    /// allowlist has to name it — dropping it would make the whole global
    /// launch-config feature fail with "Not a config file: launch.json".
    #[test]
    fn the_global_launch_file_is_allowed() {
        for name in ["user.json", "tasks.json", "launch.json"] {
            assert!(
                GLOBAL_CONFIG_FILES.contains(&name),
                "{name} must be readable and writable through the global-file commands"
            );
        }
        // Still an allowlist, not a path: anything else is rejected.
        assert!(!GLOBAL_CONFIG_FILES.contains(&".."));
    }
}