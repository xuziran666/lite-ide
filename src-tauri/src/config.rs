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
    ("quickOpen", "Ctrl+P"),
    ("globalSearch", "Ctrl+Shift+F"),
    ("renameSymbol", "F2"),
    ("findReferences", "Shift+F12"),
    ("codeActions", "Ctrl+."),
    ("formatDocument", "Shift+Alt+F"),
    ("signatureHelp", "Ctrl+Shift+Space"),
    ("deleteLine", "Ctrl+Y"),
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
    #[serde(default)]
    pub lsp: LspConfigFile,
    #[serde(default)]
    pub files: FilesConfigFile,
}

/// Per-language language-server invocation stored in `user.json`. Missing parts
/// fall back to the built-in defaults (`rust-analyzer`, `clangd`,
/// `typescript-language-server --stdio`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerFile {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfigFile {
    #[serde(default)]
    pub rust: Option<LspServerFile>,
    #[serde(default)]
    pub cpp: Option<LspServerFile>,
    #[serde(default)]
    pub typescript: Option<LspServerFile>,
}

/// `editor.guides.*` in `user.json`, nested so more guide options can be added
/// later without breaking stored files.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidesConfigFile {
    #[serde(default)]
    pub indentation: Option<bool>,
}

/// `editor.bracketPairColorization.*` in `user.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketPairColorizationConfigFile {
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfigFile {
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<u32>,
    #[serde(default)]
    pub font_ligatures: Option<bool>,
    #[serde(default)]
    pub tab_size: Option<u32>,
    #[serde(default)]
    pub word_wrap: Option<String>,
    #[serde(default)]
    pub minimap: Option<bool>,
    #[serde(default)]
    pub line_numbers: Option<String>,
    #[serde(default)]
    pub render_whitespace: Option<String>,
    #[serde(default)]
    pub render_line_highlight: Option<String>,
    #[serde(default)]
    pub guides: Option<GuidesConfigFile>,
    #[serde(default)]
    pub folding: Option<bool>,
    #[serde(default)]
    pub match_brackets: Option<String>,
    #[serde(default)]
    pub smooth_scrolling: Option<bool>,
    #[serde(default)]
    pub cursor_style: Option<String>,
    #[serde(default)]
    pub cursor_blinking: Option<String>,
    #[serde(default)]
    pub format_on_paste: Option<bool>,
    #[serde(default)]
    pub format_on_type: Option<bool>,
    #[serde(default)]
    pub auto_closing_brackets: Option<String>,
    #[serde(default)]
    pub auto_closing_quotes: Option<String>,
    #[serde(default)]
    pub auto_surround: Option<String>,
    #[serde(default)]
    pub trim_auto_whitespace: Option<bool>,
    #[serde(default)]
    pub drag_and_drop: Option<bool>,
    #[serde(default)]
    pub copy_with_syntax_highlighting: Option<bool>,
    #[serde(default)]
    pub bracket_pair_colorization: Option<BracketPairColorizationConfigFile>,
    #[serde(default)]
    pub mouse_wheel_zoom: Option<bool>,
    #[serde(default)]
    pub theme: Option<String>,
}

/// `files.autoSave`: each trigger is independent, so any enabled trigger saves
/// the dirty editors (VS Code's single-choice setting is split into flags here).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveConfigFile {
    #[serde(default)]
    pub after_delay: Option<bool>,
    #[serde(default)]
    pub on_focus_change: Option<bool>,
    #[serde(default)]
    pub on_window_change: Option<bool>,
    #[serde(default)]
    pub delay: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesConfigFile {
    #[serde(default)]
    pub auto_save: AutoSaveConfigFile,
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
    #[serde(default)]
    pub theme: Option<String>,
}

/// The resolved config sent to the frontend: defaults merged with `user.json`
/// overrides, plus an optional notice when the stored file was unreadable.
/// Serialized with camelCase keys so the frontend sees `configDir`, `fontSize`,
/// `tabSize`, `wordWrap`, `defaultShell`, `restoreLastWorkspace` and
/// `confirmBeforeClose`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfig {
    pub keybindings: HashMap<String, String>,
    pub editor: EditorSettings,
    pub terminal: TerminalSettings,
    pub general: GeneralSettings,
    pub lsp: LspSettings,
    pub files: FilesSettings,
    pub config_dir: String,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: u32,
    pub font_ligatures: bool,
    pub tab_size: u32,
    pub word_wrap: String,
    pub minimap: bool,
    pub line_numbers: String,
    pub render_whitespace: String,
    pub render_line_highlight: String,
    pub guides: GuidesSettings,
    pub folding: bool,
    pub match_brackets: String,
    pub smooth_scrolling: bool,
    pub cursor_style: String,
    pub cursor_blinking: String,
    pub format_on_paste: bool,
    pub format_on_type: bool,
    pub auto_closing_brackets: String,
    pub auto_closing_quotes: String,
    pub auto_surround: String,
    pub trim_auto_whitespace: bool,
    pub drag_and_drop: bool,
    pub copy_with_syntax_highlighting: bool,
    pub bracket_pair_colorization: BracketPairColorizationSettings,
    pub mouse_wheel_zoom: bool,
    pub theme: String,
}

/// Resolved `editor.guides.*` values.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidesSettings {
    pub indentation: bool,
}

impl Default for GuidesSettings {
    fn default() -> Self {
        Self { indentation: true }
    }
}

/// Resolved `editor.bracketPairColorization.*` values.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BracketPairColorizationSettings {
    pub enabled: bool,
}

impl Default for BracketPairColorizationSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_family: DEFAULT_FONT_FAMILY.to_string(),
            font_size: 14,
            font_ligatures: false,
            tab_size: 2,
            word_wrap: "off".to_string(),
            minimap: false,
            line_numbers: "on".to_string(),
            render_whitespace: "selection".to_string(),
            render_line_highlight: "line".to_string(),
            guides: GuidesSettings::default(),
            folding: true,
            match_brackets: "near".to_string(),
            smooth_scrolling: false,
            cursor_style: "line".to_string(),
            cursor_blinking: "blink".to_string(),
            format_on_paste: false,
            format_on_type: false,
            auto_closing_brackets: "languageDefined".to_string(),
            auto_closing_quotes: "languageDefined".to_string(),
            auto_surround: "languageDefined".to_string(),
            trim_auto_whitespace: true,
            drag_and_drop: true,
            copy_with_syntax_highlighting: true,
            bracket_pair_colorization: BracketPairColorizationSettings::default(),
            mouse_wheel_zoom: false,
            theme: "vs-dark".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveSettings {
    pub after_delay: bool,
    pub on_focus_change: bool,
    pub on_window_change: bool,
    pub delay: u32,
}

impl Default for AutoSaveSettings {
    fn default() -> Self {
        Self {
            after_delay: false,
            on_focus_change: false,
            on_window_change: false,
            delay: 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesSettings {
    pub auto_save: AutoSaveSettings,
}

impl Default for FilesSettings {
    fn default() -> Self {
        Self {
            auto_save: AutoSaveSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    pub restore_last_workspace: bool,
    pub confirm_before_close: bool,
    pub theme: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            restore_last_workspace: true,
            confirm_before_close: true,
            theme: "dark".to_string(),
        }
    }
}

/// A fully-resolved language-server invocation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspServerSettings {
    pub command: String,
    pub args: Vec<String>,
}

/// The resolved LSP configuration for every language this app supports.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LspSettings {
    pub rust: LspServerSettings,
    pub cpp: LspServerSettings,
    pub typescript: LspServerSettings,
}

fn server(command: &str, args: &[&str]) -> LspServerSettings {
    LspServerSettings {
        command: command.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
    }
}

impl Default for LspSettings {
    fn default() -> Self {
        Self {
            rust: server("rust-analyzer", &[]),
            cpp: server("clangd", &[]),
            typescript: server("typescript-language-server", &["--stdio"]),
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

/// The fallback font stack when `editor.fontFamily` is missing or blank.
const DEFAULT_FONT_FAMILY: &str = "Consolas, 'Courier New', monospace";

/// Keep only values Monaco actually accepts; anything else falls back.
fn sanitize_enum(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

/// A blank font family would make the editor fall back to its own default
/// silently, so store the documented default instead.
fn sanitize_font_family(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_FONT_FAMILY.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Whitelist the Monaco theme; anything unknown falls back to the default.
fn sanitize_theme(value: &str) -> String {
    match value {
        "vs" | "vs-dark" | "hc-black" | "hc-light" => value.to_string(),
        _ => "vs-dark".to_string(),
    }
}

fn server_file(settings: &LspServerSettings) -> LspServerFile {
    LspServerFile {
        command: Some(settings.command.clone()),
        args: Some(settings.args.clone()),
    }
}

/// Merge one stored server with its default: a blank command or an all-blank
/// args list falls back to the default, so a half-edited entry never yields an
/// unspawnable server.
fn sanitize_server(
    stored: Option<LspServerFile>,
    default: &LspServerSettings,
) -> LspServerSettings {
    match stored {
        Some(entry) => {
            let command = entry
                .command
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| default.command.clone());
            let args = entry
                .args
                .unwrap_or_else(|| default.args.clone())
                .into_iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            LspServerSettings { command, args }
        }
        None => default.clone(),
    }
}

fn resolve_lsp(file: &LspConfigFile) -> LspSettings {
    let defaults = LspSettings::default();
    LspSettings {
        rust: sanitize_server(file.rust.clone(), &defaults.rust),
        cpp: sanitize_server(file.cpp.clone(), &defaults.cpp),
        typescript: sanitize_server(file.typescript.clone(), &defaults.typescript),
    }
}

/// Clamp and fill optional user file values before persisting them.
fn sanitize_file(mut file: UserConfigFile) -> UserConfigFile {
    let e = &mut file.editor;
    e.font_family = Some(sanitize_font_family(
        e.font_family.as_deref().unwrap_or(DEFAULT_FONT_FAMILY),
    ));
    e.font_size = Some(e.font_size.unwrap_or(14).clamp(6, 64));
    e.font_ligatures = Some(e.font_ligatures.unwrap_or(false));
    e.tab_size = Some(e.tab_size.unwrap_or(2).clamp(1, 16));
    e.word_wrap = Some(sanitize_word_wrap(e.word_wrap.as_deref().unwrap_or("off")));
    e.minimap = Some(e.minimap.unwrap_or(false));
    e.line_numbers = Some(sanitize_enum(
        e.line_numbers.as_deref().unwrap_or("on"),
        &["on", "off", "relative"],
        "on",
    ));
    e.render_whitespace = Some(sanitize_enum(
        e.render_whitespace.as_deref().unwrap_or("selection"),
        &["none", "boundary", "selection", "all", "trailing"],
        "selection",
    ));
    e.render_line_highlight = Some(sanitize_enum(
        e.render_line_highlight.as_deref().unwrap_or("line"),
        &["none", "gutter", "line", "all"],
        "line",
    ));
    e.guides = Some(GuidesConfigFile {
        indentation: Some(e.guides.as_ref().and_then(|g| g.indentation).unwrap_or(true)),
    });
    e.folding = Some(e.folding.unwrap_or(true));
    e.match_brackets = Some(sanitize_enum(
        e.match_brackets.as_deref().unwrap_or("near"),
        &["always", "never", "near"],
        "near",
    ));
    e.smooth_scrolling = Some(e.smooth_scrolling.unwrap_or(false));
    e.cursor_style = Some(sanitize_enum(
        e.cursor_style.as_deref().unwrap_or("line"),
        &[
            "line",
            "block",
            "underline",
            "line-thin",
            "block-outline",
            "underline-thin",
        ],
        "line",
    ));
    e.cursor_blinking = Some(sanitize_enum(
        e.cursor_blinking.as_deref().unwrap_or("blink"),
        &["blink", "smooth", "phase", "expand", "solid"],
        "blink",
    ));
    e.format_on_paste = Some(e.format_on_paste.unwrap_or(false));
    e.format_on_type = Some(e.format_on_type.unwrap_or(false));
    e.auto_closing_brackets = Some(sanitize_enum(
        e.auto_closing_brackets.as_deref().unwrap_or("languageDefined"),
        &["always", "languageDefined", "beforeWhitespace", "never"],
        "languageDefined",
    ));
    e.auto_closing_quotes = Some(sanitize_enum(
        e.auto_closing_quotes.as_deref().unwrap_or("languageDefined"),
        &["always", "languageDefined", "beforeWhitespace", "never"],
        "languageDefined",
    ));
    e.auto_surround = Some(sanitize_enum(
        e.auto_surround.as_deref().unwrap_or("languageDefined"),
        &["languageDefined", "quotes", "brackets", "never"],
        "languageDefined",
    ));
    e.trim_auto_whitespace = Some(e.trim_auto_whitespace.unwrap_or(true));
    e.drag_and_drop = Some(e.drag_and_drop.unwrap_or(true));
    e.copy_with_syntax_highlighting =
        Some(e.copy_with_syntax_highlighting.unwrap_or(true));
    e.bracket_pair_colorization = Some(BracketPairColorizationConfigFile {
        enabled: Some(
            e.bracket_pair_colorization
                .as_ref()
                .and_then(|b| b.enabled)
                .unwrap_or(true),
        ),
    });
    e.mouse_wheel_zoom = Some(e.mouse_wheel_zoom.unwrap_or(false));
    e.theme = Some(sanitize_theme(e.theme.as_deref().unwrap_or("vs-dark")));

    let a = &mut file.files.auto_save;
    a.after_delay = Some(a.after_delay.unwrap_or(false));
    a.on_focus_change = Some(a.on_focus_change.unwrap_or(false));
    a.on_window_change = Some(a.on_window_change.unwrap_or(false));
    a.delay = Some(a.delay.unwrap_or(1000).clamp(100, 60000));

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
    let ui_theme = g
        .theme
        .as_deref()
        .unwrap_or("dark")
        .trim()
        .to_ascii_lowercase();
    g.theme = Some(match ui_theme.as_str() {
        "light" | "dark" | "system" => ui_theme,
        _ => "dark".to_string(),
    });

    let lsp = resolve_lsp(&file.lsp);
    file.lsp = LspConfigFile {
        rust: Some(server_file(&lsp.rust)),
        cpp: Some(server_file(&lsp.cpp)),
        typescript: Some(server_file(&lsp.typescript)),
    };

    file
}

fn parse_user_config(text: &str) -> UserConfig {
    let keybindings = defaults();
    let editor = EditorSettings::default();
    let terminal = TerminalSettings::default();
    let general = GeneralSettings::default();
    let lsp = LspSettings::default();
    match serde_json::from_str::<UserConfigFile>(text) {
        Ok(file) => {
            let lsp = resolve_lsp(&file.lsp);
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
                    font_family: file
                        .editor
                        .font_family
                        .unwrap_or_else(|| DEFAULT_FONT_FAMILY.to_string()),
                    font_size: file.editor.font_size.unwrap_or(14),
                    font_ligatures: file.editor.font_ligatures.unwrap_or(false),
                    tab_size: file.editor.tab_size.unwrap_or(2),
                    word_wrap: file.editor.word_wrap.unwrap_or_else(|| "off".to_string()),
                    minimap: file.editor.minimap.unwrap_or(false),
                    line_numbers: file
                        .editor
                        .line_numbers
                        .unwrap_or_else(|| "on".to_string()),
                    render_whitespace: file
                        .editor
                        .render_whitespace
                        .unwrap_or_else(|| "selection".to_string()),
                    render_line_highlight: file
                        .editor
                        .render_line_highlight
                        .unwrap_or_else(|| "line".to_string()),
                    guides: GuidesSettings {
                        indentation: file
                            .editor
                            .guides
                            .as_ref()
                            .and_then(|g| g.indentation)
                            .unwrap_or(true),
                    },
                    folding: file.editor.folding.unwrap_or(true),
                    match_brackets: file
                        .editor
                        .match_brackets
                        .unwrap_or_else(|| "near".to_string()),
                    smooth_scrolling: file.editor.smooth_scrolling.unwrap_or(false),
                    cursor_style: file
                        .editor
                        .cursor_style
                        .unwrap_or_else(|| "line".to_string()),
                    cursor_blinking: file
                        .editor
                        .cursor_blinking
                        .unwrap_or_else(|| "blink".to_string()),
                    format_on_paste: file.editor.format_on_paste.unwrap_or(false),
                    format_on_type: file.editor.format_on_type.unwrap_or(false),
                    auto_closing_brackets: file
                        .editor
                        .auto_closing_brackets
                        .unwrap_or_else(|| "languageDefined".to_string()),
                    auto_closing_quotes: file
                        .editor
                        .auto_closing_quotes
                        .unwrap_or_else(|| "languageDefined".to_string()),
                    auto_surround: file
                        .editor
                        .auto_surround
                        .unwrap_or_else(|| "languageDefined".to_string()),
                    trim_auto_whitespace: file.editor.trim_auto_whitespace.unwrap_or(true),
                    drag_and_drop: file.editor.drag_and_drop.unwrap_or(true),
                    copy_with_syntax_highlighting: file
                        .editor
                        .copy_with_syntax_highlighting
                        .unwrap_or(true),
                    bracket_pair_colorization: BracketPairColorizationSettings {
                        enabled: file
                            .editor
                            .bracket_pair_colorization
                            .as_ref()
                            .and_then(|b| b.enabled)
                            .unwrap_or(true),
                    },
                    mouse_wheel_zoom: file.editor.mouse_wheel_zoom.unwrap_or(false),
                    theme: file.editor.theme.unwrap_or_else(|| "vs-dark".to_string()),
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
                    theme: file.general.theme.unwrap_or_else(|| "dark".to_string()),
                },
                lsp,
                files: FilesSettings {
                    auto_save: AutoSaveSettings {
                        after_delay: file.files.auto_save.after_delay.unwrap_or(false),
                        on_focus_change: file.files.auto_save.on_focus_change.unwrap_or(false),
                        on_window_change: file.files.auto_save.on_window_change.unwrap_or(false),
                        delay: file.files.auto_save.delay.unwrap_or(1000),
                    },
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
            lsp,
            files: FilesSettings::default(),
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
        lsp: LspSettings::default(),
        files: FilesSettings::default(),
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
    use super::{
        defaults, parse_user_config, sanitize_file, AutoSaveSettings,
        BracketPairColorizationSettings, EditorSettings, FilesSettings, GeneralSettings,
        GuidesSettings, LspSettings, TerminalSettings, UserConfig, UserConfigFile,
        DEFAULT_FONT_FAMILY,
    };

    #[test]
    fn defaults_cover_every_action() {
        let map = defaults();
        assert_eq!(map.len(), 16);
        assert_eq!(map.get("toggleExplorer").map(String::as_str), Some("Ctrl+B"));
        assert_eq!(
            map.get("openTaskCenter").map(String::as_str),
            Some("Ctrl+Ctrl")
        );
        assert_eq!(map.get("quickOpen").map(String::as_str), Some("Ctrl+P"));
        assert_eq!(
            map.get("globalSearch").map(String::as_str),
            Some("Ctrl+Shift+F")
        );
        assert_eq!(map.get("renameSymbol").map(String::as_str), Some("F2"));
        assert_eq!(
            map.get("findReferences").map(String::as_str),
            Some("Shift+F12")
        );
        assert_eq!(map.get("codeActions").map(String::as_str), Some("Ctrl+."));
        assert_eq!(
            map.get("formatDocument").map(String::as_str),
            Some("Shift+Alt+F")
        );
        assert_eq!(map.get("deleteLine").map(String::as_str), Some("Ctrl+Y"));
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
            r#"{"editor":{"fontFamily":"Fira Code, monospace","fontSize":18,"fontLigatures":true,"tabSize":4,"wordWrap":"on","minimap":true,"lineNumbers":"relative","renderWhitespace":"all","renderLineHighlight":"gutter","guides":{"indentation":false},"folding":false,"matchBrackets":"always","smoothScrolling":true,"cursorStyle":"block","cursorBlinking":"smooth"},"terminal":{"defaultShell":"cmd.exe"},"general":{"restoreLastWorkspace":false,"confirmBeforeClose":false}}"#,
        );
        assert_eq!(cfg.notice, None);
        assert_eq!(cfg.editor.font_family, "Fira Code, monospace");
        assert_eq!(cfg.editor.font_size, 18);
        assert!(cfg.editor.font_ligatures);
        assert_eq!(cfg.editor.tab_size, 4);
        assert_eq!(cfg.editor.word_wrap, "on");
        assert!(cfg.editor.minimap);
        assert_eq!(cfg.editor.line_numbers, "relative");
        assert_eq!(cfg.editor.render_whitespace, "all");
        assert_eq!(cfg.editor.render_line_highlight, "gutter");
        assert!(!cfg.editor.guides.indentation);
        assert!(!cfg.editor.folding);
        assert_eq!(cfg.editor.match_brackets, "always");
        assert!(cfg.editor.smooth_scrolling);
        assert_eq!(cfg.editor.cursor_style, "block");
        assert_eq!(cfg.editor.cursor_blinking, "smooth");
        assert_eq!(cfg.terminal.default_shell, "cmd.exe");
        assert!(!cfg.general.restore_last_workspace);
        assert!(!cfg.general.confirm_before_close);
        assert_eq!(cfg.general.theme, "dark");
    }

    #[test]
    fn general_theme_is_whitelisted() {
        let cfg = parse_user_config(
            r#"{"general":{"theme":"system"},"editor":{"theme":"bogus"}}"#,
        );
        assert_eq!(cfg.general.theme, "system");
        assert_eq!(cfg.editor.theme, "vs-dark");
        let cfg = parse_user_config(r#"{"general":{"theme":"bogus"}}"#);
        assert_eq!(cfg.general.theme, "dark");
    }

    #[test]
    fn missing_sections_fall_back_to_defaults() {
        let cfg = parse_user_config("{}");
        assert_eq!(cfg.editor.font_size, 14);
        assert_eq!(cfg.editor.tab_size, 2);
        assert_eq!(cfg.editor.word_wrap, "off");
        assert!(!cfg.editor.minimap);
        assert!(!cfg.editor.mouse_wheel_zoom);
        assert_eq!(cfg.editor.theme, "vs-dark");
        assert_eq!(cfg.editor.font_family, DEFAULT_FONT_FAMILY);
        assert!(!cfg.editor.font_ligatures);
        assert_eq!(cfg.editor.line_numbers, "on");
        assert_eq!(cfg.editor.render_whitespace, "selection");
        assert_eq!(cfg.editor.render_line_highlight, "line");
        assert!(cfg.editor.guides.indentation);
        assert!(cfg.editor.folding);
        assert_eq!(cfg.editor.match_brackets, "near");
        assert!(!cfg.editor.smooth_scrolling);
        assert_eq!(cfg.editor.cursor_style, "line");
        assert_eq!(cfg.editor.cursor_blinking, "blink");
        assert!(!cfg.editor.format_on_paste);
        assert!(!cfg.editor.format_on_type);
        assert_eq!(cfg.editor.auto_closing_brackets, "languageDefined");
        assert_eq!(cfg.editor.auto_closing_quotes, "languageDefined");
        assert_eq!(cfg.editor.auto_surround, "languageDefined");
        assert!(cfg.editor.trim_auto_whitespace);
        assert!(cfg.editor.drag_and_drop);
        assert!(cfg.editor.copy_with_syntax_highlighting);
        assert!(cfg.editor.bracket_pair_colorization.enabled);
        assert_eq!(cfg.terminal.default_shell, "auto");
        assert!(cfg.general.restore_last_workspace);
        assert!(cfg.general.confirm_before_close);
        assert!(!cfg.files.auto_save.after_delay);
        assert!(!cfg.files.auto_save.on_focus_change);
        assert!(!cfg.files.auto_save.on_window_change);
        assert_eq!(cfg.files.auto_save.delay, 1000);
        assert_eq!(cfg.notice, None);
    }

    #[test]
    fn parses_mouse_wheel_zoom_and_auto_save() {
        let cfg = parse_user_config(
            r#"{"editor":{"mouseWheelZoom":true},"files":{"autoSave":{"afterDelay":true,"onFocusChange":true,"onWindowChange":false,"delay":500}}}"#,
        );
        assert!(cfg.editor.mouse_wheel_zoom);
        assert!(cfg.files.auto_save.after_delay);
        assert!(cfg.files.auto_save.on_focus_change);
        assert!(!cfg.files.auto_save.on_window_change);
        assert_eq!(cfg.files.auto_save.delay, 500);
    }

    #[test]
    fn clamps_auto_save_delay() {
        let low = parse_user_config(r#"{"files":{"autoSave":{"delay":10}}}"#);
        assert_eq!(low.files.auto_save.delay, 100);
        let high = parse_user_config(r#"{"files":{"autoSave":{"delay":999999}}}"#);
        assert_eq!(high.files.auto_save.delay, 60000);
    }

    #[test]
    fn clamps_out_of_range_editor_values() {
        let cfg = parse_user_config(
            r#"{"editor":{"fontSize":500,"tabSize":0,"wordWrap":"bogus","minimap":false,"theme":"bogus"}}"#,
        );
        assert_eq!(cfg.editor.font_size, 64);
        assert_eq!(cfg.editor.tab_size, 1);
        assert_eq!(cfg.editor.word_wrap, "off");
        assert_eq!(cfg.editor.theme, "vs-dark");
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
        assert_eq!(file.editor.mouse_wheel_zoom, Some(false));
        assert_eq!(file.editor.theme.as_deref(), Some("vs-dark"));
        assert_eq!(file.editor.font_family.as_deref(), Some(DEFAULT_FONT_FAMILY));
        assert_eq!(file.editor.font_ligatures, Some(false));
        assert_eq!(file.editor.line_numbers.as_deref(), Some("on"));
        assert_eq!(file.editor.render_whitespace.as_deref(), Some("selection"));
        assert_eq!(file.editor.render_line_highlight.as_deref(), Some("line"));
        assert_eq!(
            file.editor.guides.as_ref().and_then(|g| g.indentation),
            Some(true)
        );
        assert_eq!(file.editor.folding, Some(true));
        assert_eq!(file.editor.match_brackets.as_deref(), Some("near"));
        assert_eq!(file.editor.smooth_scrolling, Some(false));
        assert_eq!(file.editor.cursor_style.as_deref(), Some("line"));
        assert_eq!(file.editor.cursor_blinking.as_deref(), Some("blink"));
        assert_eq!(file.editor.format_on_paste, Some(false));
        assert_eq!(file.editor.format_on_type, Some(false));
        assert_eq!(
            file.editor.auto_closing_brackets.as_deref(),
            Some("languageDefined")
        );
        assert_eq!(
            file.editor.auto_closing_quotes.as_deref(),
            Some("languageDefined")
        );
        assert_eq!(
            file.editor.auto_surround.as_deref(),
            Some("languageDefined")
        );
        assert_eq!(file.editor.trim_auto_whitespace, Some(true));
        assert_eq!(file.editor.drag_and_drop, Some(true));
        assert_eq!(file.editor.copy_with_syntax_highlighting, Some(true));
        assert_eq!(
            file.editor
                .bracket_pair_colorization
                .as_ref()
                .and_then(|b| b.enabled),
            Some(true)
        );
        assert_eq!(file.terminal.default_shell.as_deref(), Some("auto"));
        assert_eq!(file.general.restore_last_workspace, Some(true));
        assert_eq!(file.general.confirm_before_close, Some(true));
        assert_eq!(file.files.auto_save.after_delay, Some(false));
        assert_eq!(file.files.auto_save.on_focus_change, Some(false));
        assert_eq!(file.files.auto_save.on_window_change, Some(false));
        assert_eq!(file.files.auto_save.delay, Some(1000));
        assert_eq!(
            file.lsp.rust.as_ref().and_then(|s| s.command.as_deref()),
            Some("rust-analyzer")
        );
        assert_eq!(
            file.lsp.cpp.as_ref().and_then(|s| s.command.as_deref()),
            Some("clangd")
        );
        assert_eq!(
            file.lsp
                .typescript
                .as_ref()
                .and_then(|s| s.args.clone()),
            Some(vec!["--stdio".to_string()])
        );
    }

    #[test]
    fn lsp_defaults_are_used_when_missing() {
        let cfg = parse_user_config("{}");
        assert_eq!(cfg.lsp.rust.command, "rust-analyzer");
        assert!(cfg.lsp.rust.args.is_empty());
        assert_eq!(cfg.lsp.cpp.command, "clangd");
        assert!(cfg.lsp.cpp.args.is_empty());
        assert_eq!(cfg.lsp.typescript.command, "typescript-language-server");
        assert_eq!(cfg.lsp.typescript.args, vec!["--stdio".to_string()]);
    }

    #[test]
    fn parses_lsp_overrides_and_fills_blanks() {
        let cfg = parse_user_config(
            r#"{"lsp":{"cpp":{"command":"  C:\\tools\\clangd.exe  ","args":["--background-index"]},"rust":{"command":"  "}}}"#,
        );
        assert_eq!(cfg.lsp.cpp.command, r"C:\tools\clangd.exe");
        assert_eq!(cfg.lsp.cpp.args, vec!["--background-index".to_string()]);
        // A blank command falls back to the default, and missing args inherit.
        assert_eq!(cfg.lsp.rust.command, "rust-analyzer");
        assert_eq!(cfg.lsp.typescript.command, "typescript-language-server");
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
        assert_eq!(cfg.keybindings.len(), 16);
    }

    #[test]
    fn unknown_actions_are_ignored() {
        let cfg = parse_user_config(r#"{"keybindings":{"no-such-action":"Ctrl+Z"}}"#);
        assert!(!cfg.keybindings.contains_key("no-such-action"));
    }

    #[test]
    fn serializes_settings_with_camel_case_keys() {
        let cfg = UserConfig {
            keybindings: defaults(),
            editor: EditorSettings {
                font_family: "Fira Code, monospace".to_string(),
                font_size: 18,
                font_ligatures: true,
                tab_size: 4,
                word_wrap: "on".to_string(),
                minimap: true,
                line_numbers: "relative".to_string(),
                render_whitespace: "all".to_string(),
                render_line_highlight: "gutter".to_string(),
                guides: GuidesSettings { indentation: false },
                folding: false,
                match_brackets: "always".to_string(),
                smooth_scrolling: true,
                cursor_style: "block".to_string(),
                cursor_blinking: "smooth".to_string(),
                format_on_paste: true,
                format_on_type: true,
                auto_closing_brackets: "never".to_string(),
                auto_closing_quotes: "beforeWhitespace".to_string(),
                auto_surround: "quotes".to_string(),
                trim_auto_whitespace: false,
                drag_and_drop: false,
                copy_with_syntax_highlighting: false,
                bracket_pair_colorization: BracketPairColorizationSettings { enabled: false },
                mouse_wheel_zoom: true,
                theme: "hc-black".to_string(),
            },
            terminal: TerminalSettings {
                default_shell: "cmd.exe".to_string(),
            },
            general: GeneralSettings {
                restore_last_workspace: false,
                confirm_before_close: false,
                theme: "dark".to_string(),
            },
            lsp: LspSettings::default(),
            files: FilesSettings {
                auto_save: AutoSaveSettings {
                    after_delay: true,
                    on_focus_change: false,
                    on_window_change: false,
                    delay: 1000,
                },
            },
            config_dir: r"C:\Users\test\AppData\Roaming\com.longanl.lite-ide".to_string(),
            notice: None,
        };
        let text = serde_json::to_string(&cfg).unwrap();
        // The frontend reads camelCase keys; snake_case fields here would be
        // silently dropped (which broke "打开 tasks.json").
        assert!(text.contains(r#""configDir":"#), "{text}");
        assert!(text.contains(r#""fontSize":18"#), "{text}");
        assert!(
            text.contains(r#""fontFamily":"Fira Code, monospace","fontSize":18"#),
            "{text}"
        );
        assert!(text.contains(r#""fontLigatures":true"#), "{text}");
        assert!(text.contains(r#""tabSize":4"#), "{text}");
        assert!(text.contains(r#""lineNumbers":"relative""#), "{text}");
        assert!(text.contains(r#""renderWhitespace":"all""#), "{text}");
        assert!(text.contains(r#""renderLineHighlight":"gutter""#), "{text}");
        assert!(text.contains(r#""guides":{"indentation":false}"#), "{text}");
        assert!(text.contains(r#""folding":false"#), "{text}");
        assert!(text.contains(r#""matchBrackets":"always""#), "{text}");
        assert!(text.contains(r#""smoothScrolling":true"#), "{text}");
        assert!(text.contains(r#""cursorStyle":"block""#), "{text}");
        assert!(text.contains(r#""cursorBlinking":"smooth""#), "{text}");
        assert!(text.contains(r#""formatOnPaste":true"#), "{text}");
        assert!(text.contains(r#""formatOnType":true"#), "{text}");
        assert!(text.contains(r#""autoClosingBrackets":"never""#), "{text}");
        assert!(
            text.contains(r#""autoClosingQuotes":"beforeWhitespace""#),
            "{text}"
        );
        assert!(text.contains(r#""autoSurround":"quotes""#), "{text}");
        assert!(text.contains(r#""trimAutoWhitespace":false"#), "{text}");
        assert!(text.contains(r#""dragAndDrop":false"#), "{text}");
        assert!(
            text.contains(r#""copyWithSyntaxHighlighting":false"#),
            "{text}"
        );
        assert!(
            text.contains(r#""bracketPairColorization":{"enabled":false}"#),
            "{text}"
        );
        assert!(text.contains(r#""wordWrap":"on""#), "{text}");
        assert!(text.contains(r#""minimap":true"#), "{text}");
        assert!(text.contains(r#""mouseWheelZoom":true"#), "{text}");
        assert!(text.contains(r#""theme":"hc-black""#), "{text}");
        assert!(text.contains(r#""defaultShell":"cmd.exe""#), "{text}");
        assert!(text.contains(r#""restoreLastWorkspace":false"#), "{text}");
        assert!(text.contains(r#""confirmBeforeClose":false"#), "{text}");
        assert!(text.contains(r#""autoSave":{"afterDelay":true"#), "{text}");
        assert!(text.contains(r#""delay":1000"#), "{text}");
        assert!(text.contains(r#""typescript":{"command":"typescript-language-server","args":["--stdio"]}"#), "{text}");
        assert!(!text.contains("config_dir"), "{text}");
        assert!(!text.contains("font_size"), "{text}");
        assert!(!text.contains("mouse_wheel_zoom"), "{text}");
        assert!(!text.contains("font_family"), "{text}");
        assert!(!text.contains("line_numbers"), "{text}");
        assert!(!text.contains("render_whitespace"), "{text}");
        assert!(!text.contains("render_line_highlight"), "{text}");
        assert!(!text.contains("match_brackets"), "{text}");
        assert!(!text.contains("smooth_scrolling"), "{text}");
        assert!(!text.contains("cursor_style"), "{text}");
        assert!(!text.contains("cursor_blinking"), "{text}");
        assert!(!text.contains("format_on_paste"), "{text}");
        assert!(!text.contains("auto_closing_brackets"), "{text}");
        assert!(!text.contains("auto_surround"), "{text}");
        assert!(!text.contains("trim_auto_whitespace"), "{text}");
        assert!(!text.contains("drag_and_drop"), "{text}");
        assert!(!text.contains("bracket_pair_colorization"), "{text}");
    }

    #[test]
    fn parses_editor_display_section() {
        let cfg = parse_user_config(
            r#"{"editor":{"lineNumbers":"off","renderWhitespace":"trailing","renderLineHighlight":"none","guides":{"indentation":true},"folding":true,"matchBrackets":"never","smoothScrolling":false,"cursorStyle":"underline-thin","cursorBlinking":"phase"}}"#,
        );
        assert_eq!(cfg.editor.line_numbers, "off");
        assert_eq!(cfg.editor.render_whitespace, "trailing");
        assert_eq!(cfg.editor.render_line_highlight, "none");
        assert!(cfg.editor.guides.indentation);
        assert!(cfg.editor.folding);
        assert_eq!(cfg.editor.match_brackets, "never");
        assert!(!cfg.editor.smooth_scrolling);
        assert_eq!(cfg.editor.cursor_style, "underline-thin");
        assert_eq!(cfg.editor.cursor_blinking, "phase");
    }

    #[test]
    fn sanitizes_unknown_editor_display_values() {
        let cfg = parse_user_config(
            r#"{"editor":{"lineNumbers":"bogus","renderWhitespace":"bogus","renderLineHighlight":"bogus","matchBrackets":"bogus","cursorStyle":"bogus","cursorBlinking":"bogus"}}"#,
        );
        assert_eq!(cfg.editor.line_numbers, "on");
        assert_eq!(cfg.editor.render_whitespace, "selection");
        assert_eq!(cfg.editor.render_line_highlight, "line");
        assert_eq!(cfg.editor.match_brackets, "near");
        assert_eq!(cfg.editor.cursor_style, "line");
        assert_eq!(cfg.editor.cursor_blinking, "blink");
        // The guides section is optional and defaults to enabled.
        assert!(cfg.editor.guides.indentation);
    }

    #[test]
    fn blank_font_family_falls_back_to_default() {
        let blank = parse_user_config(r#"{"editor":{"fontFamily":""}}"#);
        assert_eq!(blank.editor.font_family, DEFAULT_FONT_FAMILY);
        let spaces = parse_user_config(r#"{"editor":{"fontFamily":"   "}}"#);
        assert_eq!(spaces.editor.font_family, DEFAULT_FONT_FAMILY);
        let kept = parse_user_config(r#"{"editor":{"fontFamily":"  JetBrains Mono  "}}"#);
        assert_eq!(kept.editor.font_family, "JetBrains Mono");
    }

    #[test]
    fn parses_editor_editing_section() {
        let cfg = parse_user_config(
            r#"{"editor":{"formatOnPaste":true,"formatOnType":true,"autoClosingBrackets":"beforeWhitespace","autoClosingQuotes":"never","autoSurround":"brackets","trimAutoWhitespace":false,"dragAndDrop":false,"copyWithSyntaxHighlighting":false,"bracketPairColorization":{"enabled":false}}}"#,
        );
        assert!(cfg.editor.format_on_paste);
        assert!(cfg.editor.format_on_type);
        assert_eq!(cfg.editor.auto_closing_brackets, "beforeWhitespace");
        assert_eq!(cfg.editor.auto_closing_quotes, "never");
        assert_eq!(cfg.editor.auto_surround, "brackets");
        assert!(!cfg.editor.trim_auto_whitespace);
        assert!(!cfg.editor.drag_and_drop);
        assert!(!cfg.editor.copy_with_syntax_highlighting);
        assert!(!cfg.editor.bracket_pair_colorization.enabled);
    }

    #[test]
    fn sanitizes_unknown_editor_editing_values() {
        let cfg = parse_user_config(
            r#"{"editor":{"autoClosingBrackets":"bogus","autoClosingQuotes":"bogus","autoSurround":"bogus","bracketPairColorization":{}}}"#,
        );
        assert_eq!(cfg.editor.auto_closing_brackets, "languageDefined");
        assert_eq!(cfg.editor.auto_closing_quotes, "languageDefined");
        assert_eq!(cfg.editor.auto_surround, "languageDefined");
        // An empty bracketPairColorization object still enables colorization.
        assert!(cfg.editor.bracket_pair_colorization.enabled);

        // `always` is a valid autoClosing* strategy but NOT an autoSurround one.
        let cross = parse_user_config(
            r#"{"editor":{"autoClosingBrackets":"always","autoSurround":"always"}}"#,
        );
        assert_eq!(cross.editor.auto_closing_brackets, "always");
        assert_eq!(cross.editor.auto_surround, "languageDefined");
    }
}