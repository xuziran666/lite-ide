use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::io_error;

/// File name of the persisted session inside the app config directory.
const SESSION_FILE: &str = "session.json";

/// The persisted application session. Every field is optional, so a partial or
/// outdated file still loads.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Session {
    #[serde(default)]
    pub last_workspace: Option<String>,
}

/// Parse session contents. Anything malformed degrades to the default session
/// instead of failing the caller.
pub(crate) fn parse_session(text: &str) -> Session {
    serde_json::from_str(text).unwrap_or_default()
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("Failed to resolve the config directory: {err}"))?;
    Ok(dir.join(SESSION_FILE))
}

/// Read the persisted session. A missing file and malformed JSON both yield the
/// default session, so a broken file never blocks startup.
pub fn load(app: &AppHandle) -> Session {
    let Ok(path) = session_path(app) else {
        return Session::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => parse_session(&text),
        Err(_) => Session::default(),
    }
}

/// Persist the workspace that was opened last, so the next run can restore it.
pub fn save_workspace(app: &AppHandle, workspace: &Path) -> Result<(), String> {
    let path = session_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Invalid session file path".to_string())?;
    fs::create_dir_all(dir).map_err(|err| io_error("create the config directory", err))?;

    let mut session = load(app);
    session.last_workspace = Some(workspace.to_string_lossy().into_owned());

    let text = serde_json::to_string_pretty(&session)
        .map_err(|err| format!("Failed to serialize the session: {err}"))?;
    fs::write(&path, text).map_err(|err| io_error("write the session file", err))
}

#[cfg(test)]
mod tests {
    use super::parse_session;

    #[test]
    fn parses_a_saved_workspace() {
        let session = parse_session(r#"{"last_workspace":"E:\\Code\\demo"}"#);
        assert_eq!(session.last_workspace.as_deref(), Some(r"E:\Code\demo"));
    }

    #[test]
    fn falls_back_to_default_for_malformed_json() {
        assert!(parse_session("{not json").last_workspace.is_none());
    }

    #[test]
    fn falls_back_to_default_for_empty_input() {
        assert!(parse_session("").last_workspace.is_none());
    }

    #[test]
    fn tolerates_a_missing_or_unknown_workspace_field() {
        assert!(parse_session("{}").last_workspace.is_none());
        assert!(parse_session(r#"{"last_workspace":null,"future":1}"#).last_workspace.is_none());
    }
}
