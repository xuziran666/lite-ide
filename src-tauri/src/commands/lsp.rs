//! Commands that drive the built-in LSP client. All of them can block for up
//! to the request timeout, so every one runs on Tauri's blocking pool rather
//! than the main thread. Each command is scoped to a language id, so multiple
//! language servers can run side by side (one per language per workspace).

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

/// Start (or "restart into") the session for one language in the current
/// workspace. `path` is the file that triggered the start (used by Rust to find
/// its nearest `Cargo.toml`); `command` is the configured server argv, falling
/// back to the language's PATH default when omitted.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    language: String,
    path: Option<String>,
    command: Option<Vec<String>>,
) -> Result<LspStartResult, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;

        if let Some(session) = state.lsp_session(&language)? {
            if session.is_running() {
                return Ok(LspStartResult {
                    already_running: true,
                    root_uri: Some(session.root_uri().to_string()),
                    capabilities: session.capabilities(),
                });
            }
            // A dead session is dropped and replaced below.
            state.set_lsp(&language, None);
        }

        let root_uri = lsp::resolve_root(
            &language,
            path.as_deref().map(Path::new),
            &workspace,
        );
        let mut command = lsp::resolve_command(&language, command);
        // clangd needs a little toolchain help on Windows (see `lsp::cpp`):
        // honor `.clangd`, whitelist the PATH compiler for header extraction,
        // and only fall back to it when the project has no compilation database.
        if language == "cpp" {
            command.extend(lsp::cpp::clangd_args(&workspace));
        }
        let process_id = std::process::id();

        let session = LspSession::start(
            app.clone(),
            &language,
            &command,
            root_uri.clone(),
            process_id,
        )?;
        let capabilities = session.capabilities();
        state.set_lsp(&language, Some(session));
        Ok(LspStartResult {
            already_running: false,
            root_uri: Some(root_uri),
            capabilities,
        })
    })
    .await
    .map_err(|err| format!("lsp_start 内部错误: {err}"))?
}

/// Stop one language's session for the current workspace (workspace switch, or
/// when the user closes the last file of that language).
#[tauri::command]
pub async fn lsp_stop(app: AppHandle, language: String) -> Result<(), String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.stop_lsp(&language);
        Ok(())
    })
    .await
    .map_err(|err| format!("lsp_stop 内部错误: {err}"))?
}

/// Send a notification to one language's server, if it is running.
#[tauri::command]
pub async fn lsp_notify(
    app: AppHandle,
    language: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        if let Some(session) = state.lsp_session(&language)? {
            if session.is_running() {
                session.notify(&method, params)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|err| format!("lsp_notify 内部错误: {err}"))?
}

/// Send a request to one language's server and return its result (blocking,
/// with the client's request timeout).
#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    language: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    spawn_blocking(move || {
        let state = app.state::<AppState>();
        let session = state
            .lsp_session(&language)?
            .filter(|session| session.is_running())
            .ok_or_else(|| "LSP 服务未启动".to_string())?;
        session.request(&method, params)
    })
    .await
    .map_err(|err| format!("lsp_request 内部错误: {err}"))?
}
