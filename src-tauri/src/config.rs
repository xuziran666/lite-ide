use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Actions users may rebind plus their defaults. `openTaskCenter` defaults to
/// the special `Ctrl+Ctrl` chord, which the frontend interprets as a quick
/// double press of Ctrl rather than a real chord.
const KEYBINDING_DEFAULTS: &[(&str, &str)] = &[
    ("toggleExplorer", "Ctrl+B"),
    ("toggleTerminal", "Ctrl+`"),
    ("newTerminal", "Ctrl+Shift+`"),
    ("closeEditorTab", "Ctrl+W"),
    ("restoreClosedTab", "Ctrl+Shift+T"),
    ("nextEditorTab", "Ctrl+Tab"),
    ("previousEditorTab", "Ctrl+Shift+Tab"),
    ("openTaskCenter", "Ctrl+Ctrl"),
];

const USER_CONFIG_FILE: &str = "user.json";

#[derive(Debug, Default, Deserialize)]
struct UserConfigFile {
    #[serde(default)]
    keybindings: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct UserConfig {
    pub keybindings: HashMap<String, String>,
    pub notice: Option<String>,
}

fn defaults() -> HashMap<String, String> {
    KEYBINDING_DEFAULTS
        .iter()
        .map(|(action, chord)| (action.to_string(), chord.to_string()))
        .collect()
}

fn parse_user_config(text: &str) -> UserConfig {
    let mut keybindings = defaults();
    match serde_json::from_str::<UserConfigFile>(text) {
        Ok(file) => {
            for (action, chord) in file.keybindings {
                // Unknown actions are ignored so they never leak into the map.
                if keybindings.contains_key(&action) {
                    keybindings.insert(action, chord);
                }
            }
            UserConfig {
                keybindings,
                notice: None,
            }
        }
        Err(_) => UserConfig {
            keybindings,
            notice: Some("user.json 格式错误，已使用默认快捷键".to_string()),
        },
    }
}

/// The directory holding global user configuration (never created on read).
pub fn app_config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

fn user_config_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app_config_dir(app)?.join(USER_CONFIG_FILE))
}

/// Load the user configuration. A missing file yields the defaults without a
/// notice; malformed JSON yields the defaults with a notice. The file is never
/// created or overwritten.
pub fn load(app: &AppHandle) -> UserConfig {
    let Some(path) = user_config_path(app) else {
        return UserConfig {
            keybindings: defaults(),
            notice: None,
        };
    };
    match fs::read_to_string(&path) {
        Ok(text) => parse_user_config(&text),
        Err(_) => UserConfig {
            keybindings: defaults(),
            notice: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{defaults, parse_user_config};

    #[test]
    fn defaults_cover_every_action() {
        let map = defaults();
        assert_eq!(map.len(), 8);
        assert_eq!(map.get("toggleExplorer").map(String::as_str), Some("Ctrl+B"));
        assert_eq!(
            map.get("openTaskCenter").map(String::as_str),
            Some("Ctrl+Ctrl")
        );
    }

    #[test]
    fn merges_user_overrides_over_defaults() {
        let cfg = parse_user_config(
            r#"{"keybindings":{"openTaskCenter":"Ctrl+Shift+P","toggleExplorer":"Ctrl+E"}}"#,
        );
        assert_eq!(cfg.notice, None);
        assert_eq!(
            cfg.keybindings.get("openTaskCenter").map(String::as_str),
            Some("Ctrl+Shift+P")
        );
        assert_eq!(
            cfg.keybindings.get("toggleExplorer").map(String::as_str),
            Some("Ctrl+E")
        );
        assert_eq!(
            cfg.keybindings.get("toggleTerminal").map(String::as_str),
            Some("Ctrl+`")
        );
    }

    #[test]
    fn broken_user_json_falls_back_with_notice() {
        let cfg = parse_user_config("{nope");
        assert!(cfg.notice.is_some());
        assert_eq!(
            cfg.keybindings.get("openTaskCenter").map(String::as_str),
            Some("Ctrl+Ctrl")
        );
    }

    #[test]
    fn empty_user_json_falls_back_with_notice() {
        let cfg = parse_user_config("");
        assert!(cfg.notice.is_some());
        assert_eq!(cfg.keybindings.len(), 8);
    }

    #[test]
    fn unknown_actions_are_ignored() {
        let cfg = parse_user_config(r#"{"keybindings":{"no-such-action":"Ctrl+Z"}}"#);
        assert!(!cfg.keybindings.contains_key("no-such-action"));
    }
}