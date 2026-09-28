use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::AppHandle;

use crate::debug::session::DebugSession;
use crate::lsp::session::LspSession;
use crate::terminal::TerminalSession;
use crate::watcher::WorkspaceWatcher;

pub struct AppState {
    workspace: Mutex<Option<PathBuf>>,
    /// Cached `git rev-parse --show-toplevel` result for `workspace`. The outer
    /// `Option` distinguishes "not looked up yet" from a cached "not a
    /// repository" (`None`). Cleared whenever the workspace changes.
    git_root: Mutex<Option<Option<PathBuf>>>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
    terminals: Mutex<HashMap<u64, TerminalSession>>,
    /// Live language-server sessions, keyed by client-side language id
    /// ("rust" / "cpp" / "typescript"). At most one per language per workspace.
    lsp: Mutex<HashMap<String, Arc<LspSession>>>,
    /// The single debug adapter session, if one is running.
    ///
    /// One slot, not a map: a phase-1 debug session owns one debuggee, so
    /// starting a second one is a stop-then-start rather than a parallel set of
    /// adapters.
    debug: Mutex<Option<Arc<DebugSession>>>,
    debug_start: Mutex<()>,
    /// The id under which the debuggee's terminal pty is registered in
    /// `terminals`, when the adapter asked to run the program in a terminal
    /// (`runInTerminal`). `None` when the current session has no terminal.
    debug_terminal: Mutex<Option<u64>>,
    debug_terminal_owner: Mutex<Option<u64>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            git_root: Mutex::new(None),
            watcher: Mutex::new(None),
            terminals: Mutex::new(HashMap::new()),
            lsp: Mutex::new(HashMap::new()),
            debug: Mutex::new(None),
            debug_start: Mutex::new(()),
            debug_terminal: Mutex::new(None),
            debug_terminal_owner: Mutex::new(None),
        }
    }

    pub fn set_workspace(&self, path: PathBuf, app: AppHandle) -> Result<(), String> {
        self.kill_all_terminals();
        // A new workspace never inherits the previous one's language servers.
        self.stop_all_lsp();
        // A debuggee belongs to the workspace it was launched from, so the
        // session is terminated here rather than left pointing at stale paths.
        self.stop_debug();
        // The cached repository root belongs to the outgoing workspace.
        if let Ok(mut guard) = self.git_root.lock() {
            *guard = None;
        }
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

    /// The cached repository root, or `None` when it has not been resolved yet.
    pub fn cached_git_root(&self) -> Result<Option<Option<PathBuf>>, String> {
        let guard = self
            .git_root
            .lock()
            .map_err(|_| "git root state is poisoned".to_string())?;
        Ok(guard.clone())
    }

    pub fn set_cached_git_root(&self, root: Option<PathBuf>) {
        if let Ok(mut guard) = self.git_root.lock() {
            *guard = Some(root);
        }
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

    /// The current debug session, if one is running.
    pub fn debug_session(&self) -> Result<Option<Arc<DebugSession>>, String> {
        self.debug
            .lock()
            .map(|guard| guard.clone())
            .map_err(|_| "debug state is poisoned".to_string())
    }

    pub fn lock_debug_start(&self) -> MutexGuard<'_, ()> {
        self.debug_start
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Store (or clear, when `session` is `None`) the single debug session.
    pub fn set_debug(&self, session: Option<Arc<DebugSession>>) {
        let mut guard = self
            .debug
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = session;
    }

    /// Clear the debug slot **only** if it still holds `session`.
    ///
    /// A session finalizes itself from its own reader thread (the debuggee
    /// exited / the adapter died), which can race a user starting the next
    /// session. Comparing identities means a finishing session can never delete
    /// the one that replaced it — without the check, that cleanup would null the
    /// new slot and the next `debug_request` would address nothing.
    pub fn clear_debug_if_same(&self, session: &Arc<DebugSession>) {
        let mut guard = self
            .debug
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            *guard = None;
        }
    }

    /// Disconnect and terminate the running debug session, if any.
    ///
    /// Called on explicit stop, on workspace change and on app exit. The
    /// shutdown is taken out of the lock first: it talks to the adapter over
    /// stdio and must never run while holding the state lock.
    ///
    /// The debuggee's pty is closed here too, and not only as a consequence of
    /// the adapter exiting. The debuggee is a process *this* IDE started, and a
    /// local adapter is not obliged to kill what it merely attached to — its
    /// `terminateDebuggee` can be a no-op. Closing the pty is what ends it, and
    /// doing it directly means a wedged adapter cannot leave a debuggee running
    /// with its stdin open.
    pub fn stop_debug(&self) {
        let session = self
            .debug
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(session) = session {
            session.shutdown();
        }
        self.kill_debug_terminal();
    }

    /// Remember the id the debuggee's terminal pty is registered under.
    pub fn set_debug_terminal(&self, id: u64, owner: u64) {
        *self
            .debug_terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id);
        *self
            .debug_terminal_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(owner);
    }

    /// Kill the debuggee's terminal pty (explicit Stop, session finalization,
    /// workspace change). Closing the pty is what closes the debuggee's stdin;
    /// the already-printed output stays in the frontend's xterm buffer.
    pub fn kill_debug_terminal(&self) {
        let owner = self
            .debug_terminal_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if owner.is_none() {
            return;
        }
        self.kill_debug_terminal_owned();
    }

    pub fn kill_debug_terminal_if_same(&self, owner: u64) {
        let same = self
            .debug_terminal_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some_and(|current| current == owner);
        if same {
            self.kill_debug_terminal_owned();
        }
    }

    fn kill_debug_terminal_owned(&self) {
        let id = self
            .debug_terminal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(id) = id {
            self.kill_terminal(id);
        }
        *self
            .debug_terminal_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}
