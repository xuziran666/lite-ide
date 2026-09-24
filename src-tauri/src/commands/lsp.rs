//! Commands that drive the built-in LSP client. All of them can block for up
//! to the request timeout, so every one runs on Tauri's blocking pool rather
//! than the main thread.

use std::path::Path;

use serde_json::Value;
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager};

use crate::lsp::session::LspSession;
use crate::lsp::{self, LspStartResult};
use crate::state::AppState;

fn no_workspace_error() -> String {
    "No workspace is open. Please open a folder first.".to_string()
}

/// Start (or "restart into") the rust-analyzer session for the current
/// workspace. `path` is an absolute path of the file that triggered the start;
/// its nearest `Cargo.toml` becomes the LSP root.
#[tauri::command]
pub async fn lsp_start(app: AppHandle, path: Option<String>) -> Result<LspStartResult, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;

        if let Some(session) = state.lsp_session()? {
            if session.is_running() {
                return Ok(LspStartResult {
                    already_running: true,
                    root_uri: Some(session.root_uri().to_string()),
                });
            }
            // A dead session is dropped and replaced below.
            state.set_lsp(None);
        }

        let root_uri = match &path {
            Some(file) => lsp::find_project_root(Path::new(file), &workspace),
            None => crate::lsp::uri::path_to_file_uri(&workspace),
        };
        let command = lsp::resolve_command(None);
        let process_id = std::process::id();

        let session = LspSession::start(app.clone(), &command, root_uri.clone(), process_id)?;
        state.set_lsp(Some(session));
        Ok(LspStartResult {
            already_running: false,
            root_uri: Some(root_uri),
        })
    })
    .await
    .map_err(|err| format!("lsp_start 内部错误: {err}"))?
}

/// Stop the session for the current workspace (used on workspace switch and by
/// the UI when the user closes all Rust files).
#[tauri::command]
pub async fn lsp_stop(app: AppHandle) -> Result<(), String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.stop_lsp();
        Ok(())
    })
    .await
    .map_err(|err| format!("lsp_stop 内部错误: {err}"))?
}

/// Send a notification to the server, if one is running for the workspace.
#[tauri::command]
pub async fn lsp_notify(
    app: AppHandle,
    method: String,
    params: Value,
) -> Result<(), String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Some(session) = state.lsp_session()? {
            if session.is_running() {
                session.notify(&method, params)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("lsp_notify 内部错误: {err}"))?
}

/// Send a request to the server and return its result (blocking, with the
/// client's request timeout).
#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = state
            .lsp_session()?
            .filter(|session| session.is_running())
            .ok_or_else(|| "LSP 服务未启动".to_string())?;
        session.request(&method, params)
    })
    .await
    .map_err(|err| format!("lsp_request 内部错误: {err}"))?
}