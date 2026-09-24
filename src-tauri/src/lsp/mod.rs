//! Built-in LSP client (MVP): connects Monaco to external language servers
//! (rust-analyzer, clangd, typescript-language-server) over stdio / JSON-RPC.
//!
//! Design rules for this phase:
//! - One server per (workspace, language), launched from PATH, started lazily
//!   when a file of that language opens.
//! - No main-thread blocking: request/response happen off the event loop and
//!   the frontend only ever sees `lsp-diagnostics` / `lsp-exited` events plus
//!   the results of `lsp_start` / `lsp_stop` / `lsp_notify` / `lsp_request`.
//! - The reader thread never panics on unknown JSON-RPC shapes; unsupported
//!   server requests are answered `-32601`.

pub mod cpp;
pub mod rpc;
pub mod session;
pub mod transport;
pub mod uri;

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

/// Built-in server invocation for a language id. `rust-analyzer` must be
/// reachable from PATH; `clangd` and `typescript-language-server` likewise.
pub fn default_command(language: &str) -> Vec<String> {
    match language {
        "cpp" => vec!["clangd".to_string()],
        "typescript" => vec![
            "typescript-language-server".to_string(),
            "--stdio".to_string(),
        ],
        // `rust` and any unknown language (defensive fallback).
        _ => vec!["rust-analyzer".to_string()],
    }
}

/// The result returned to the frontend from `lsp_start`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStartResult {
    /// True when a session was already running (start was a no-op).
    pub already_running: bool,
    /// The root folder the session was configured with.
    pub root_uri: Option<String>,
}



/// Build the `initialize` request params with the client capabilities this
/// app understands.
pub fn initialize_params(root_uri: &str, process_id: u32) -> Value {
    json!({
        "processId": process_id,
        "clientInfo": { "name": "lite-ide", "version": "0.1.0" },
        "rootUri": root_uri,
        "workspaceFolders": [{
            "uri": root_uri,
            "name": "workspace"
        }],
        "capabilities": {
            "textDocument": {
                "synchronization": { "didSave": false },
                "publishDiagnostics": { "relatedInformation": true },
                "completion": {
                    "completionItem": {
                        "snippetSupport": true,
                        "labelDetailsSupport": true
                    }
                },
                "hover": {},
                "definition": {},
                "documentSymbol": {}
            },
            "workspace": { "configuration": true }
        }
    })
}

/// Locate the nearest `Cargo.toml` from `start_dir`, walking up, and return
/// the `file://` URI of the folder that owns it; falls back to the workspace
/// root itself.
pub fn find_project_root(start_dir: &std::path::Path, workspace_root: &std::path::Path) -> String {
    let mut dir = Some(start_dir);
    while let Some(current) = dir {
        if current.join("Cargo.toml").is_file() {
            return uri::path_to_file_uri(&current.to_path_buf());
        }
        dir = current.parent();
        if let Some(parent) = dir {
            // Stop as soon as we leave the workspace root.
            if !parent.starts_with(workspace_root) {
                break;
            }
        }
    }
    uri::path_to_file_uri(&workspace_root.to_path_buf())
}

/// Resolve the target command, falling back to the language's PATH default
/// when no configured override is present.
pub fn resolve_command(language: &str, prefer: Option<Vec<String>>) -> Vec<String> {
    prefer
        .filter(|command| !command.is_empty() && !command[0].is_empty())
        .unwrap_or_else(|| default_command(language))
}

/// The root URI sent at initialize time.
/// - Rust prefers the project root (nearest `Cargo.toml`);
/// - C/C++ and TypeScript prefer the workspace root and let the server discover
///   their own project files (`compile_commands.json`, `tsconfig.json`).
///
/// The trigger file never moves the root outside the workspace, so opening an
/// external definition target cannot change it.
pub fn resolve_root(language: &str, trigger_path: Option<&Path>, workspace: &Path) -> String {
    match language {
        "rust" => match trigger_path {
            Some(file) => find_project_root(file, workspace),
            None => uri::path_to_file_uri(&workspace.to_path_buf()),
        },
        _ => uri::path_to_file_uri(&workspace.to_path_buf()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_params_contains_required_handshake_fields() {
        let params = initialize_params("file:///C:/workspace", 1234);
        assert_eq!(params["processId"], 1234);
        assert_eq!(params["rootUri"], "file:///C:/workspace");
        assert_eq!(params["capabilities"]["textDocument"]["completion"]["completionItem"]["snippetSupport"], true);
        // `publishDiagnostics` must be advertised or typescript-language-server
        // never pushes diagnostics for open documents.
        assert_eq!(
            params["capabilities"]["textDocument"]["publishDiagnostics"]["relatedInformation"],
            true
        );
        assert_eq!(params["capabilities"]["workspace"]["configuration"], true);
    }

    #[test]
    fn find_project_root_walks_up_to_cargo_toml() {
        // Exercise the algorithm without touching the real filesystem: create
        // a temp tree with src/ nested inside a Cargo project.
        let workspace_root = std::env::temp_dir().join("lite_ide_lsp_root_test");
        let project = workspace_root.join("my_project");
        let src = project.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(project.join("Cargo.toml"), "[package]").unwrap();

        let root_uri = find_project_root(&src, &workspace_root);
        assert!(root_uri.ends_with("my_project"));

        // A directory inside the project with no Cargo.toml still resolves up.
        let nested = project.join("src").join("nested").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        let root_uri_2 = find_project_root(&nested, &workspace_root);
        assert!(root_uri_2.ends_with("my_project"));

        std::fs::remove_dir_all(&workspace_root).ok();
    }

    #[test]
    fn find_project_root_falls_back_to_workspace_root() {
        let workspace_root = std::env::temp_dir().join("lite_ide_lsp_root_fb");
        std::fs::create_dir_all(&workspace_root.join("a").join("b")).unwrap();
        let root_uri = find_project_root(&workspace_root.join("a").join("b"), &workspace_root);
        assert!(root_uri.contains("lite_ide_lsp_root_fb"));
        std::fs::remove_dir_all(&workspace_root).ok();
    }

    #[test]
    fn default_command_and_resolution() {
        assert_eq!(default_command("rust"), vec!["rust-analyzer".to_string()]);
        assert_eq!(default_command("cpp"), vec!["clangd".to_string()]);
        assert_eq!(
            default_command("typescript"),
            vec!["typescript-language-server".to_string(), "--stdio".to_string()]
        );
        // Unknown languages fall back to rust-analyzer (defensive).
        assert_eq!(default_command("weird"), vec!["rust-analyzer".to_string()]);

        assert_eq!(resolve_command("rust", None), vec!["rust-analyzer".to_string()]);
        assert_eq!(
            resolve_command("cpp", Some(vec!["/x/y".to_string()])),
            vec!["/x/y".to_string()]
        );
        // Empty / blank commands fall back to the language default.
        assert_eq!(resolve_command("typescript", Some(vec![])), default_command("typescript"));
        assert_eq!(
            resolve_command("cpp", Some(vec!["".to_string()])),
            vec!["clangd".to_string()]
        );
    }

    #[test]
    fn resolve_root_uses_workspace_for_cpp_and_typescript() {
        let workspace_root = std::env::temp_dir().join("lite_ide_lsp_root_lang");
        let project = workspace_root.join("sub");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("Cargo.toml"), "[package]").unwrap();
        let file = project.join("main.cpp");

        let cpp_root = resolve_root("cpp", Some(&file), &workspace_root);
        assert!(cpp_root.ends_with("lite_ide_lsp_root_lang"), "{cpp_root}");
        let ts_root = resolve_root("typescript", Some(&file), &workspace_root);
        assert!(ts_root.ends_with("lite_ide_lsp_root_lang"), "{ts_root}");
        // Rust still prefers the nearest Cargo.toml project.
        let rust_root = resolve_root("rust", Some(&file), &workspace_root);
        assert!(rust_root.ends_with("sub"), "{rust_root}");

        std::fs::remove_dir_all(&workspace_root).ok();
    }
}