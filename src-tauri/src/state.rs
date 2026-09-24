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
    /// Live language-server sessions, keyed by client-side language id
    /// ("rust" / "cpp" / "typescript"). At most one per language per workspace.
    lsp: Mutex<HashMap<String, Arc<LspSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            watcher: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
            lsp: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_workspace(&self, path: PathBuf, app: AppHandle) -> Result<(), String> {
        self.kill_all_terminals();
        // A new workspace never inherits the previous one's language servers.
        self.stop_all_lsp();
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

    /// The current LSP session for a language, if any.
    pub fn lsp_session(&self, language: &str) -> Result<Option<Arc<LspSession>>, String> {
        self.lsp
            .lock()
            .map(|guard| guard.get(language).cloned())
            .map_err(|_| "lsp state is poisoned".to_string())
    }

    /// Store (or clear, when `session` is None) the LSP session for a language.
    pub fn set_lsp(&self, language: &str, session: Option<Arc<LspSession>>) {
        let mut guard = self.lsp.lock().unwrap_or_else(|p| p.into_inner());
        match session {
            Some(session) => {
                guard.insert(language.to_string(), session);
            }
            None => {
                guard.remove(language);
            }
        }
    }

    /// Gracefully shut down one language's session (if any) and clear its slot.
    pub fn stop_lsp(&self, language: &str) {
        let session = self
            .lsp
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(language);
        if let Some(session) = session {
            session.shutdown();
        }
    }

    /// Gracefully shut down every language server and clear the slots.
    pub fn stop_all_lsp(&self) {
        let sessions = {
            let mut guard = self
                .lsp
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.drain().map(|(_, session)| session).collect::<Vec<_>>()
        };
        for session in sessions {
            session.shutdown();
        }
    }
}