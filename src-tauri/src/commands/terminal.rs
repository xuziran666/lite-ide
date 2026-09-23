use std::path::PathBuf;

use tauri::{ipc::Channel, State};

use crate::error::io_error;
use crate::state::AppState;
use crate::terminal::TerminalSession;

fn current_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
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
    let session = TerminalSession::spawn(current_shell(), Some(cwd), channel)?;
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