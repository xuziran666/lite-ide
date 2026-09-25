use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::commands::fs::path_is_ignored;

const POLL: Duration = Duration::from_millis(50);
/// Quiet period after the last event before a batch is emitted.
const DEBOUNCE: Duration = Duration::from_millis(500);
/// Hard ceiling on how long a batch may be held back while events keep
/// arriving, so a continuously writing workspace still refreshes promptly.
const MAX_WAIT: Duration = Duration::from_millis(2000);
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

/// Whether the pending batch is due to be emitted: after a quiet `DEBOUNCE`
/// since the newest event, or once the batch has been held for `MAX_WAIT`.
fn can_emit(first: Option<Instant>, last: Option<Instant>) -> bool {
    match (first, last) {
        (Some(first), Some(last)) => last.elapsed() >= DEBOUNCE || first.elapsed() >= MAX_WAIT,
        _ => false,
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
    let mut first_event: Option<Instant> = None;
    let mut last_event: Option<Instant> = None;

    loop {
        let mut flush = false;
        let mut stop = false;
        match rx.recv_timeout(POLL) {
            Ok(event) => {
                if let Some(path) = watchable_path(&event) {
                    if let Ok(relative) = path.strip_prefix(&workspace) {
                        if !path_is_ignored(relative) {
                            let now = Instant::now();
                            pending.insert(path.to_path_buf());
                            first_event.get_or_insert(now);
                            last_event = Some(now);
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                flush = can_emit(first_event, last_event);
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush = !pending.is_empty();
                stop = true;
            }
        }

        if flush {
            emit_changes(&app, &pending);
            pending.clear();
            first_event = None;
            last_event = None;
        }

        if stop {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_events_never_emit() {
        assert!(!can_emit(None, None));
    }

    #[test]
    fn a_fresh_event_is_held_back() {
        let now = Instant::now();
        assert!(!can_emit(Some(now), Some(now)));
    }

    #[test]
    fn a_quiet_batch_is_emitted() {
        let now = Instant::now() - DEBOUNCE;
        assert!(can_emit(Some(now), Some(now)));
    }

    #[test]
    fn a_continuously_written_batch_is_emitted_at_max_wait() {
        let first = Instant::now() - MAX_WAIT;
        let last = Instant::now();
        assert!(can_emit(Some(first), Some(last)));
    }

    #[test]
    fn an_older_first_event_cannot_emit_before_the_quiet_period() {
        let first = Instant::now() - DEBOUNCE + Duration::from_millis(1);
        let last = Instant::now();
        assert!(!can_emit(Some(first), Some(last)));
    }
}
