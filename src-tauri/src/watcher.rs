use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::commands::fs::path_is_ignored;

const POLL: Duration = Duration::from_millis(50);
const DEBOUNCE: Duration = Duration::from_millis(500);
const EVENT_NAME: &str = "file-system-changed";

/// Bridges notify events into an mpsc channel. A custom handler (rather than
/// notify's `event_handler` callback overload) keeps this compatible with the
/// current notify version.
struct ChannelHandler(mpsc::Sender<Event>);

impl notify::EventHandler for ChannelHandler {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        if let Ok(event) = event {
            let _ = self.0.send(event);
        }
    }
}

/// A recursive watcher for the current workspace. Kept alive by `AppState` so
/// events keep flowing for as long as the workspace is set. Owns the notify
/// watcher handle; the collector thread runs independently.
pub struct WorkspaceWatcher {
    _handle: RecommendedWatcher,
}

impl WorkspaceWatcher {
    pub fn start(workspace: &Path, app: AppHandle) -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::channel();
        let mut handle = RecommendedWatcher::new(ChannelHandler(tx), Config::default())?;
        handle.watch(workspace, RecursiveMode::Recursive)?;

        let watched = workspace.to_path_buf();
        std::thread::spawn(move || collector_loop(rx, watched, app));

        Ok(Self { _handle: handle })
    }
}

/// Returns the change-relevant path for an event, skipping read/access events
/// and events without a path.
fn watchable_path(event: &Event) -> Option<&Path> {
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }
    event.paths.first().map(|p| p.as_path())
}

fn can_emit(debounce_start: Option<Instant>) -> bool {
    match debounce_start {
        Some(start) => start.elapsed() >= DEBOUNCE,
        None => false,
    }
}

fn emit_changes(app: &AppHandle, pending: &HashSet<PathBuf>) {
    let mut paths: Vec<String> = pending
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    paths.sort();
    let _ = app.emit(EVENT_NAME, paths);
}

fn collector_loop(rx: mpsc::Receiver<Event>, workspace: PathBuf, app: AppHandle) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    let mut debounce_start: Option<Instant> = None;

    loop {
        let mut flush = false;
        let mut stop = false;
        match rx.recv_timeout(POLL) {
            Ok(event) => {
                if let Some(path) = watchable_path(&event) {
                    if let Ok(relative) = path.strip_prefix(&workspace) {
                        if !path_is_ignored(relative) {
                            pending.insert(path.to_path_buf());
                            debounce_start.get_or_insert_with(Instant::now);
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                flush = can_emit(debounce_start);
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush = !pending.is_empty();
                stop = true;
            }
        }

        if flush {
            emit_changes(&app, &pending);
            pending.clear();
            debounce_start = None;
        }

        if stop {
            break;
        }
    }
}