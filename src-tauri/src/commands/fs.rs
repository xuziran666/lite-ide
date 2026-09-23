use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::io_error;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn resolve_in_workspace(workspace: &Path, path: &Path) -> Result<PathBuf, String> {
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    };
    let canonical = fs::canonicalize(&target).map_err(|e| io_error("resolve path", e))?;
    if !canonical.starts_with(workspace) {
        return Err(format!(
            "Path is outside the workspace: {}",
            target.display()
        ));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let workspace = state
        .workspace()?
        .ok_or_else(|| "No workspace is open. Please open a folder first.".to_string())?;
    let dir = resolve_in_workspace(&workspace, Path::new(&path))?;

    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| io_error("read directory", e))?;
    for item in read_dir {
        let item = item.map_err(|e| io_error("read directory entry", e))?;
        let file_type = item
            .file_type()
            .map_err(|e| io_error("read entry type", e))?;
        let name = item.file_name().to_string_lossy().into_owned();
        entries.push(Entry {
            name: name.clone(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub fn set_workspace(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let requested = PathBuf::from(&path);
    if !requested.is_dir() {
        return Err(format!("Not a directory: {}", requested.display()));
    }
    let canonical = fs::canonicalize(&requested).map_err(|e| io_error("open workspace", e))?;
    state.set_workspace(canonical.clone())?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .workspace()?
        .map(|p| p.to_string_lossy().into_owned()))
}