use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::AppHandle;

use crate::lsp::session::LspSession;
use crate::terminal::TerminalSession;
use crate::watcher::WorkspaceWatcher;

pub struct AppState {
    workspace: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
    terminals: Mutex<HashMap<u64, TerminalSession>>,
    lsp: Mutex<Option<Arc<LspSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            watcher: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
            lsp: Mutex::new(None),
        }
    }

    pub fn set_workspace(&self, path: PathBuf, app: AppHandle) -> Result<(), String> {
        self.kill_all_terminals();
        // A new workspace never inherits the previous one's language server.
        self.stop_lsp();
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

    /// The current LSP session, if any.
    pub fn lsp_session(&self) -> Result<Option<Arc<LspSession>>, String> {
        self.lsp
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| "lsp state is poisoned".to_string())
    }

    /// Store (or clear) the shared LSP session.
    pub fn set_lsp(&self, session: Option<Arc<LspSession>>) {
        *self.lsp.lock().unwrap() = session;
    }

    /// Gracefully shut down the current session (if any) and clear the slot.
    pub fn stop_lsp(&self) {
        let session = self
            .lsp
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(session) = session {
            session.shutdown();
        }
    }
}