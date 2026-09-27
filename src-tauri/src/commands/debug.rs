//! Tauri commands for the built-in debug client.
//!
//! Three commands cover the whole protocol surface, mirroring how the LSP
//! commands are shaped so the frontend needs no bespoke plumbing:
//!
//! - `debug_start` — resolve the adapter, spawn it, run `initialize`, then send
//!   either `launch` or `attach` (chosen by the `request` argument). It returns
//!   immediately after that request is *written*; it does not wait for the
//!   adapter's response or its `initialized` event (see below).
//! - `debug_request` — send any other DAP request (`continue`, `next`,
//!   `stackTrace`, `variables`, …) and return its `body`.
//! - `debug_stop` — `disconnect` (terminating the debuggee) and kill the adapter.
//!
//! All of them block on the adapter round trip, so each runs on Tauri's blocking
//! pool instead of the main thread.

use serde_json::Value;
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager};

use crate::debug::session::DebugSession;
use crate::debug::{self, DebugStartResult};
use crate::state::AppState;

/// Bring up a debug session for one language.
///
/// `adapter` is the argv configured under `debug.adapters.<languageId>` (or
/// `None` when the language has no entry, which is reported verbatim). `request`
/// is `"launch"` or `"attach"` (absent means `"launch"`), and `launch` is the
/// already-merged DAP arguments for that request.
///
/// This command deliberately does **not** wait for the program to stop, nor even
/// for the `launch`/`attach` *response*. It returns as soon as that request has
/// been written; everything after that is driven by the adapter's events, which
/// the frontend receives as `debug-event`. Two protocol facts force this:
/// `lldb-dap` withholds the `launch` response until the debuggee first stops
/// (which may be never), and breakpoints are only bindable after the adapter's
/// `initialized` event. So the frontend sends `setBreakpoints` +
/// `configurationDone` when that event arrives, not this command.
#[tauri::command]
pub async fn debug_start(
    app: AppHandle,
    language: String,
    adapter: Option<Vec<String>>,
    request: Option<String>,
    launch: Value,
) -> Result<DebugStartResult, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _start_guard = state.lock_debug_start();
        if state.workspace()?.is_none() {
            return Err("No workspace is open. Please open a folder first.".to_string());
        }

        // A second F5 replaces the previous run rather than racing it. A session
        // whose debuggee already terminated is *finished* even though its adapter
        // may still be alive, so it does not count as running and is reaped
        // here instead of blocking the new start.
        if let Some(existing) = state.debug_session()? {
            if existing.is_running() && !existing.is_finished() {
                return Err("A debug session is already running. Stop it first.".to_string());
            }
            // Identity-checked: if this session was already finalized and a new
            // one slipped in, that new one is left untouched.
            state.clear_debug_if_same(&existing);
            existing.shutdown();
        }

        let request = match request.as_deref() {
            None | Some("launch") => "launch",
            Some("attach") => "attach",
            Some(other) => return Err(format!("Unsupported debug request: {other}")),
        };

        let argv = debug::resolve_adapter_argv(&language, adapter)?;
        let arguments = debug::launch_arguments(&launch);
        // An attach target is already running and has no local program to check;
        // only a launch is verified against the file system.
        if request == "launch" {
            debug::verify_program(&arguments)?;
        }

        let session = DebugSession::start(Some(app.clone()), &language, &argv)?;
        if let Err(err) = session.request(
            "setExceptionBreakpoints",
            serde_json::json!({ "filters": [] }),
        ) {
            session.abort();
            return Err(err);
        }
        // Fire and forget: the response only arrives once the debuggee first
        // stops, which can be never. See `DebugSession::send_request`.
        if let Err(err) = session.send_request(request, arguments) {
            session.abort();
            return Err(err);
        }

        let result = DebugStartResult {
            session_id: session.id(),
            adapter: session.label.clone(),
            capabilities: session.capabilities(),
        };

        // The debuggee may already have finished (a one-line program that exits
        // immediately); that is a successful start, not an error.
        if !session.is_running() {
            state.set_debug(None);
        } else {
            state.set_debug(Some(session));
        }
        Ok(result)
    })
    .await
    .map_err(|err| format!("debug_start 内部错误: {err}"))?
}

/// Send a DAP request to the running adapter and return its `body`.
///
/// Used for every request after startup, including `setBreakpoints` when the
/// user adds or removes one mid-session. A request that is refused because the
/// adapter is gone clears the slot, so the frontend can never keep addressing a
/// dead session.
#[tauri::command]
pub async fn debug_request(
    app: AppHandle,
    command: String,
    arguments: Value,
) -> Result<Value, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = state
            .debug_session()?
            .filter(|session| session.is_running() && !session.is_finished())
            .ok_or_else(|| "Debug session is not running".to_string())?;
        let result = session.request(&command, arguments);
        if !session.is_running() || session.is_finished() {
            // Only this session's own slot is cleared; a new session started
            // meanwhile is not affected.
            state.clear_debug_if_same(&session);
        }
        result
    })
    .await
    .map_err(|err| format!("debug_request 内部错误: {err}"))?
}

/// Terminate the debuggee and stop the adapter.
#[tauri::command]
pub async fn debug_stop(app: AppHandle) -> Result<(), String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.stop_debug();
        Ok(())
    })
    .await
    .map_err(|err| format!("debug_stop 内部错误: {err}"))?
}
