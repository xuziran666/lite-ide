use std::path::{Path, PathBuf};

use tauri::{ipc::Channel, State};

use crate::error::io_error;
use crate::state::AppState;
use crate::terminal::TerminalSession;

/// Locate an executable by name on the `PATH`. Returns the first match.
#[cfg(windows)]
fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The shell to launch for a new terminal session. On Windows prefer
/// PowerShell 7 (`pwsh.exe`), then Windows PowerShell (`powershell.exe`),
/// then fall back to `cmd.exe`; on Unix use `$SHELL` then `/bin/sh`.
fn current_shell() -> String {
    #[cfg(windows)]
    {
        ["pwsh.exe", "powershell.exe", "cmd.exe"]
            .iter()
            .find_map(|name| find_executable(name))
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
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

/// Spawn a new shell in a pseudo-terminal with the current shell/cwd. Any
/// previously running session is killed first (restart semantics).
#[tauri::command]
pub fn terminal_spawn(
    state: State<'_, AppState>,
    channel: Channel<Vec<u8>>,
) -> Result<(), String> {
    state.kill_terminal();
    let cwd = resolve_cwd(&state)?;
    let session = TerminalSession::spawn(current_shell(), Some(normalize_cwd(&cwd)), channel)?;
    state.set_terminal(session);
    Ok(())
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, data: String) -> Result<(), String> {
    let mut session = state.terminal()?;
    let terminal = session
        .as_mut()
        .ok_or_else(|| "no terminal session is running".to_string())?;
    terminal.write(&data)
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<(), String> {
    let mut session = state.terminal()?;
    let terminal = session
        .as_mut()
        .ok_or_else(|| "no terminal session is running".to_string())?;
    terminal.resize(cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, AppState>) -> Result<(), String> {
    state.kill_terminal();
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