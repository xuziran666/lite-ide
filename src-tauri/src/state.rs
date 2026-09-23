use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use tauri::AppHandle;

use crate::terminal::TerminalSession;
use crate::watcher::WorkspaceWatcher;

pub struct AppState {
    workspace: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
    terminals: Mutex<HashMap<u64, TerminalSession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            watcher: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_workspace(&self, path: PathBuf, app: AppHandle) -> Result<(), String> {
        self.kill_all_terminals();
        let mut guard = self
            .workspace
            .lock()
            .map_err(|_| "workspace state is poisoned".to_string())?;
        *guard = Some(path.clone());
        drop(guard);

        // Restart the watcher for the new workspace. A watcher failure is
        // non-fatal: the workspace is still usable, it just won't emit events.
        let mut watcher_guard = self
            .watcher
            .lock()
            .map_err(|_| "watcher state is poisoned".to_string())?;
        *watcher_guard = match WorkspaceWatcher::start(&path, app) {
            Ok(watcher) => Some(watcher),
            Err(err) => {
                eprintln!("file watcher could not be started: {err}");
                None
            }
        };
        Ok(())
    }

    pub fn workspace(&self) -> Result<Option<PathBuf>, String> {
        let guard = self
            .workspace
            .lock()
            .map_err(|_| "workspace state is poisoned".to_string())?;
        Ok(guard.clone())
    }

    pub fn set_terminal(&self, id: u64, session: TerminalSession) {
        let mut guard = self
            .terminals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(id, session);
    }

    /// All running terminal sessions keyed by their frontend-assigned id.
    pub fn terminals(&self) -> Result<MutexGuard<'_, HashMap<u64, TerminalSession>>, String> {
        self.terminals
            .lock()
            .map_err(|_| "terminal state is poisoned".to_string())
    }

    /// Kill the terminal session with the given id, if it is still running,
    /// and remove it from the map.
    pub fn kill_terminal(&self, id: u64) {
        let mut guard = self
            .terminals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut session) = guard.remove(&id) {
            session.kill();
        }
    }

    /// Kill every running terminal session and clear the map.
    pub fn kill_all_terminals(&self) {
        let mut guard = self
            .terminals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, mut session) in guard.drain() {
            session.kill();
        }
    }
}