use std::path::{Path, PathBuf};

use tauri::{ipc::Channel, AppHandle, State};

use crate::error::io_error;
use crate::state::AppState;
use crate::terminal::TerminalSession;

/// Shells available on this machine that the Settings page lists, in preferred
/// order. `current_shell()` always yields one of them.
#[tauri::command]
pub fn get_shells() -> Result<Vec<String>, String> {
    Ok(crate::shell::available_shells())
}

/// Convert an extended-length Windows path (`\\?\`) back to a normal path so
/// shells accept it as their working directory. Other paths are unchanged.
#[cfg(windows)]
fn normalize_cwd(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share\project -> \\server\share\project
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // \\?\E:\Code\... -> E:\Code\...
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn normalize_cwd(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn resolve_cwd(state: &AppState) -> Result<PathBuf, String> {
    if let Some(workspace) = state.workspace()? {
        return Ok(workspace);
    }
    let path = std::env::current_dir().map_err(|err| io_error("resolve current directory", err))?;
    Ok(if path.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        path
    })
}

/// Spawn a new shell in a pseudo-terminal with the configured shell/cwd. The
/// session is registered under the frontend-assigned `id`. A restart of the
/// same terminal is done by `terminal_kill(id)` followed by another spawn.
/// The shell is resolved at spawn time so running terminals are never
/// affected by a later Default Shell change in Settings.
#[tauri::command]
pub fn terminal_spawn(
    state: State<'_, AppState>,
    app: AppHandle,
    id: u64,
    channel: Channel<Vec<u8>>,
) -> Result<(), String> {
    let cwd = resolve_cwd(&state)?;
    let shell = crate::config::configured_shell(&app);
    let session = TerminalSession::spawn(shell, Some(normalize_cwd(&cwd)), channel)?;
    state.set_terminal(id, session);
    Ok(())
}

/// Write user input for the terminal session with the given id.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.terminals()?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "no terminal session with that id is running".to_string())?;
    session.write(&data)
}

/// Inform the terminal session with the given id that its visible size changed.
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.terminals()?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "no terminal session with that id is running".to_string())?;
    session.resize(cols, rows)
}

/// Kill the terminal session with the given id.
#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    state.kill_terminal(id);
    Ok(())
}

/// Kill every running terminal session (workspace switch, app exit).
#[tauri::command]
pub fn terminal_kill_all(state: State<'_, AppState>) -> Result<(), String> {
    state.kill_all_terminals();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_cwd;
    use std::path::Path;

    #[cfg(windows)]
    #[test]
    fn strips_extended_local_path_prefix() {
        let input = Path::new(r"\\?\E:\Code\CorC++\Algorithm_Win");
        assert_eq!(
            normalize_cwd(input),
            Path::new(r"E:\Code\CorC++\Algorithm_Win")
        );
    }

    #[cfg(windows)]
    #[test]
    fn converts_extended_unc_to_regular_unc() {
        let input = Path::new(r"\\?\UNC\server\share\project");
        assert_eq!(normalize_cwd(input), Path::new(r"\\server\share\project"));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_regular_windows_path_unchanged() {
        let input = Path::new(r"E:\Code\CorC++\Algorithm_Win");
        assert_eq!(normalize_cwd(input), input);
    }

    #[cfg(windows)]
    #[test]
    fn keeps_regular_unc_path_unchanged() {
        let input = Path::new(r"\\server\share\project");
        assert_eq!(normalize_cwd(input), input);
    }

    #[cfg(not(windows))]
    #[test]
    fn keeps_unix_path_unchanged() {
        let input = Path::new("/home/user/project");
        assert_eq!(normalize_cwd(input), input);
    }
}