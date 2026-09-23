use std::path::PathBuf;
use std::sync::Mutex;

use tauri::AppHandle;

use crate::watcher::WorkspaceWatcher;

pub struct AppState {
    workspace: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            workspace: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }

    pub fn set_workspace(&self, path: PathBuf, app: AppHandle) -> Result<(), String> {
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
}