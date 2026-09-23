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

/// The shape stored on disk in `user.json`. Every section defaults, so partial
/// files and unknown keys never break the loader, and the same shape is used
/// when the Settings UI writes the file back.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfigFile {
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
    #[serde(default)]
    pub editor: EditorConfigFile,
    #[serde(default)]
    pub terminal: TerminalConfigFile,
    #[serde(default)]
    pub general: GeneralConfigFile,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigFile {
    #[serde(default)]
    pub font_size: Option<u32>,
    #[serde(default)]
    pub tab_size: Option<u32>,
    #[serde(default)]
    pub word_wrap: Option<String>,
    #[serde(default)]
    pub minimap: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfigFile {
    #[serde(default)]
    pub default_shell: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralConfigFile {
    #[serde(default)]
    pub restore_last_workspace: Option<bool>,
    #[serde(default)]
    pub confirm_before_close: Option<bool>,
}

/// The resolved config sent to the frontend: defaults merged with `user.json`
/// overrides, plus an optional notice when the stored file was unreadable.
#[derive(Debug, Clone, Serialize)]
pub struct UserConfig {
    pub keybindings: HashMap<String, String>,
    pub editor: EditorSettings,
    pub terminal: TerminalSettings,
    pub general: GeneralSettings,
    pub config_dir: String,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EditorSettings {
    pub font_size: u32,
    pub tab_size: u32,
    pub word_wrap: String,
    pub minimap: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            tab_size: 2,
            word_wrap: "off".to_string(),
            minimap: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSettings {
    pub default_shell: String,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            default_shell: "auto".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneralSettings {
    pub restore_last_workspace: bool,
    pub confirm_before_close: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            restore_last_workspace: true,
            confirm_before_close: true,
        }
    }
}

fn defaults() -> HashMap<String, String> {
    KEYBINDING_DEFAULTS
        .iter()
        .map(|(action, chord)| (action.to_string(), chord.to_string()))
        .collect()
}

fn sanitize_word_wrap(value: &str) -> String {
    match value {
        "off" | "on" | "wordWrapColumn" => value.to_string(),
        _ => "off".to_string(),
    }
}

/// Clamp and fill optional user file values before persisting them.
fn sanitize_file(mut file: UserConfigFile) -> UserConfigFile {
    let e = &mut file.editor;
    e.font_size = Some(e.font_size.unwrap_or(14).clamp(6, 64));
    e.tab_size = Some(e.tab_size.unwrap_or(2).clamp(1, 16));
    e.word_wrap = Some(sanitize_word_wrap(e.word_wrap.as_deref().unwrap_or("off")));
    e.minimap = Some(e.minimap.unwrap_or(false));

    let t = &mut file.terminal;
    let shell = t
        .default_shell
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    t.default_shell = Some(shell);

    let g = &mut file.general;
    g.restore_last_workspace = Some(g.restore_last_workspace.unwrap_or(true));
    g.confirm_before_close = Some(g.confirm_before_close.unwrap_or(true));

    file
}

fn parse_user_config(text: &str) -> UserConfig {
    let keybindings = defaults();
    let editor = EditorSettings::default();
    let terminal = TerminalSettings::default();
    let general = GeneralSettings::default();
    match serde_json::from_str::<UserConfigFile>(text) {
        Ok(file) => {
            let file = sanitize_file(file);
            let mut keybindings = keybindings;
            for (action, chord) in &file.keybindings {
                // Unknown actions are ignored so they never leak into the map.
                if keybindings.contains_key(action) {
                    keybindings.insert(action.clone(), chord.clone());
                }
            }
            UserConfig {
                keybindings,
                editor: EditorSettings {
                    font_size: file.editor.font_size.unwrap_or(14),
                    tab_size: file.editor.tab_size.unwrap_or(2),
                    word_wrap: file.editor.word_wrap.unwrap_or_else(|| "off".to_string()),
                    minimap: file.editor.minimap.unwrap_or(false),
                },
                terminal: TerminalSettings {
                    default_shell: file
                        .terminal
                        .default_shell
                        .unwrap_or_else(|| "auto".to_string()),
                },
                general: GeneralSettings {
                    restore_last_workspace: file
                        .general
                        .restore_last_workspace
                        .unwrap_or(true),
                    confirm_before_close: file.general.confirm_before_close.unwrap_or(true),
                },
                config_dir: String::new(),
                notice: None,
            }
        }
        Err(_) => UserConfig {
            keybindings,
            editor,
            terminal,
            general,
            config_dir: String::new(),
            notice: Some("user.json 格式错误，已使用默认配置".to_string()),
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
/// created or overwritten by loading.
pub fn load(app: &AppHandle) -> UserConfig {
    let config_dir = app_config_dir(app)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let defaults = || UserConfig {
        keybindings: defaults(),
        editor: EditorSettings::default(),
        terminal: TerminalSettings::default(),
        general: GeneralSettings::default(),
        config_dir: config_dir.clone(),
        notice: None,
    };
    let Some(path) = user_config_path(app) else {
        return defaults();
    };
    match fs::read_to_string(&path) {
        Ok(text) => {
            let mut cfg = parse_user_config(&text);
            cfg.config_dir = config_dir;
            cfg
        }
        Err(_) => defaults(),
    }
}

/// Persist the user configuration to `user.json`, creating the config
/// directory when needed. The stored values are clamped/sanitized first.
pub fn save(app: &AppHandle, file: UserConfigFile) -> Result<(), String> {
    let path = user_config_path(app).ok_or_else(|| "无法解析配置目录".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "Invalid config file path".to_string())?;
    fs::create_dir_all(dir)
        .map_err(|err| io_error_msg("create the config directory", &err.to_string()))?;

    let cleaned = sanitize_file(file);
    let text = serde_json::to_string_pretty(&cleaned)
        .map_err(|err| format!("Failed to serialize the config: {err}"))?;
    fs::write(&path, text).map_err(|err| io_error_msg("write the config file", &err.to_string()))
}

fn io_error_msg(action: &str, err: &str) -> String {
    format!("Failed to {action}: {err}")
}

/// The shell new terminal sessions should launch: the user-configured one when
/// it still exists on disk, otherwise the platform's auto-detected shell.
pub fn configured_shell(app: &AppHandle) -> String {
    let configured = load(app).terminal.default_shell;
    if !configured.is_empty()
        && configured != "auto"
        && PathBuf::from(&configured).is_file()
    {
        configured
    } else {
        crate::shell::current_shell()
    }
}

#[cfg(test)]
mod tests {
    use super::{defaults, parse_user_config, sanitize_file, UserConfigFile};

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
    fn parses_editor_terminal_and_general_overrides() {
        let cfg = parse_user_config(
            r#"{"editor":{"fontSize":18,"tabSize":4,"wordWrap":"on","minimap":true},"terminal":{"defaultShell":"cmd.exe"},"general":{"restoreLastWorkspace":false,"confirmBeforeClose":false}}"#,
        );
        assert_eq!(cfg.notice, None);
        assert_eq!(cfg.editor.font_size, 18);
        assert_eq!(cfg.editor.tab_size, 4);
        assert_eq!(cfg.editor.word_wrap, "on");
        assert!(cfg.editor.minimap);
        assert_eq!(cfg.terminal.default_shell, "cmd.exe");
        assert!(!cfg.general.restore_last_workspace);
        assert!(!cfg.general.confirm_before_close);
    }

    #[test]
    fn missing_sections_fall_back_to_defaults() {
        let cfg = parse_user_config("{}");
        assert_eq!(cfg.editor.font_size, 14);
        assert_eq!(cfg.editor.tab_size, 2);
        assert_eq!(cfg.editor.word_wrap, "off");
        assert!(!cfg.editor.minimap);
        assert_eq!(cfg.terminal.default_shell, "auto");
        assert!(cfg.general.restore_last_workspace);
        assert!(cfg.general.confirm_before_close);
        assert_eq!(cfg.notice, None);
    }

    #[test]
    fn clamps_out_of_range_editor_values() {
        let cfg = parse_user_config(
            r#"{"editor":{"fontSize":500,"tabSize":0,"wordWrap":"bogus","minimap":false}}"#,
        );
        assert_eq!(cfg.editor.font_size, 64);
        assert_eq!(cfg.editor.tab_size, 1);
        assert_eq!(cfg.editor.word_wrap, "off");
    }

    #[test]
    fn empty_terminal_shell_falls_back_to_auto() {
        let cfg = parse_user_config(r#"{"terminal":{"defaultShell":""}}"#);
        assert_eq!(cfg.terminal.default_shell, "auto");
    }

    #[test]
    fn sanitize_fills_missing_values_with_defaults() {
        let file = sanitize_file(UserConfigFile::default());
        assert_eq!(file.editor.font_size, Some(14));
        assert_eq!(file.editor.tab_size, Some(2));
        assert_eq!(file.editor.word_wrap.as_deref(), Some("off"));
        assert_eq!(file.editor.minimap, Some(false));
        assert_eq!(file.terminal.default_shell.as_deref(), Some("auto"));
        assert_eq!(file.general.restore_last_workspace, Some(true));
        assert_eq!(file.general.confirm_before_close, Some(true));
    }

    #[test]
    fn sanitize_survives_full_user_file() {
        let file = UserConfigFile::default();
        let cleaned = sanitize_file(file);
        assert_eq!(cleaned.editor.font_size, Some(14));
        assert_eq!(cleaned.terminal.default_shell.as_deref(), Some("auto"));
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