use std::fs;
use std::path::{Component, Path, PathBuf};

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

fn no_workspace_error() -> String {
    "No workspace is open. Please open a folder first.".to_string()
}

/// Lexically resolve "." and ".." components without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize the requested path against the workspace and enforce the workspace
/// boundary. Handles both existing and non-existing targets:
/// - existing targets are canonicalized (resolves symlinks) then checked;
/// - non-existing targets are checked against their deepest existing ancestor,
///   then the remaining relative components are re-appended.
fn validate_within_workspace(workspace: &Path, requested: &Path) -> Result<PathBuf, String> {
    let abs = normalize_path(&workspace.join(requested));

    let mut anchor = abs.as_path();
    loop {
        match fs::canonicalize(anchor) {
            Ok(canonical) => {
                if !canonical.starts_with(workspace) {
                    return Err(format!(
                        "Path is outside the workspace: {}",
                        abs.display()
                    ));
                }
                if anchor == abs {
                    return Ok(canonical);
                }
                let suffix = abs
                    .strip_prefix(anchor)
                    .map_err(|_| format!("Cannot resolve path: {}", abs.display()))?;
                return Ok(canonical.join(suffix));
            }
            Err(_) => match anchor.parent() {
                Some(parent) => anchor = parent,
                None => return Err(format!("Cannot resolve path: {}", abs.display())),
            },
        }
    }
}

#[tauri::command]
pub fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    let dir = validate_within_workspace(&workspace, Path::new(&path))?;

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
pub fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    let file = validate_within_workspace(&workspace, Path::new(&path))?;

    if !file.is_file() {
        return Err(format!("Not a file: {}", file.display()));
    }

    let bytes = fs::read(&file).map_err(|e| io_error("read file", e))?;
    String::from_utf8(bytes).map_err(|_| {
        format!("File is not valid UTF-8 and cannot be opened: {}", file.display())
    })
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    let file = validate_within_workspace(&workspace, Path::new(&path))?;
    fs::write(&file, content.as_bytes()).map_err(|e| io_error("write file", e))
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

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    use std::os::unix::fs::symlink_dir;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_dir;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_workspace() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!(
            "lite_ide_test_{}_{}",
            std::process::id(),
            n
        ));
        fs::create_dir_all(base.join("sub")).unwrap();
        fs::write(base.join("inside.txt"), "hello").unwrap();
        fs::canonicalize(&base).unwrap()
    }

    #[test]
    fn normalize_path_resolves_parent_components() {
        assert_eq!(
            normalize_path(Path::new("a/b/../c")),
            PathBuf::from("a").join("c")
        );
        assert_eq!(normalize_path(Path::new("a/b/../../..")), PathBuf::new());
    }

    #[test]
    fn validates_existing_file_inside_workspace() {
        let ws = tmp_workspace();
        let res = validate_within_workspace(&ws, Path::new("inside.txt"));
        assert!(res.is_ok());
        assert!(res.unwrap().starts_with(&ws));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validates_nonexistent_target_inside_workspace() {
        let ws = tmp_workspace();
        let res = validate_within_workspace(&ws, Path::new("sub/new.txt"));
        let ok = res.expect("should be allowed");
        assert_eq!(ok, ws.join("sub").join("new.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let ws = tmp_workspace();
        let outside = ws.parent().unwrap().join("outside.txt");
        fs::write(&outside, "x").unwrap();
        let p = outside.to_string_lossy().into_owned();
        assert!(validate_within_workspace(&ws, Path::new(&p)).is_err());
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_parent_escape_for_nonexistent_target() {
        let ws = tmp_workspace();
        let p = format!("../outside_{}.txt", std::process::id());
        assert!(validate_within_workspace(&ws, Path::new(&p)).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_symlink_escape() {
        let ws = tmp_workspace();
        // Create the symlink only where supported (Windows: requires dev mode,
        // Unix fine). If creation fails, skip.
        let link = ws.join("escape");
        if symlink_dir(std::env::temp_dir(), &link).is_ok() {
            let p = format!("{}/secret.txt", link.to_string_lossy());
            let res = validate_within_workspace(&ws, Path::new(&p));
            assert!(res.is_err(), "symlink escaping workspace must be rejected");
            let _ = fs::remove_file(&link);
        }
        let _ = fs::remove_dir_all(&ws);
    }
}