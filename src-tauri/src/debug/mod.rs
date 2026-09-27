//! Built-in Debug Adapter Protocol client (phase 1).
//!
//! ```text
//! lite-ide ──DAP──▶ debug adapter process ──▶ GDB / LLDB / any debugger
//! ```
//!
//! Design rules for this phase:
//! - **DAP only.** There is no GDB/MI client and no debugger-specific logic
//!   anywhere; the adapter is an external process the user installs.
//! - **Language-agnostic.** Nothing in this module (or in the frontend
//!   `debug/` counterpart) branches on a language id. A language only ever
//!   appears as *data*: the `debug.adapters.<languageId>` config entry that
//!   names the adapter executable, and the launch-configuration fields merged
//!   into the DAP `launch` request. Adding Rust / Go / Python later is a
//!   `user.json` edit, not a code change.
//! - **Nothing runs until asked.** No adapter is spawned at workspace open and
//!   nothing is polled; a session exists only between `debug_start` and
//!   `debug_stop`.
//! - **A bad message can never take the IDE down.** Framing lives in
//!   [`crate::framing`], message shapes in [`transport`], and the reader thread
//!   reports failures instead of panicking (`panic = "abort"` is set for
//!   release builds, so a panic here would kill the app).
//!
//! Layering: this module owns adapter resolution and the `initialize` /
//! `launch` payloads; [`session`] owns the child process, request/response
//! correlation and lifecycle; the frontend owns protocol orchestration and the
//! state machine, exactly as it does for LSP.

pub mod session;
pub mod transport;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

/// The client id we announce to adapters. Adapters that need to recognize a
/// specific frontend (rather than a language) read this.
pub const CLIENT_ID: &str = "lite-ide";

/// What `debug_start` hands back once the adapter is spawned and the
/// `initialize` handshake has completed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStartResult {
    /// Display name of the adapter process, for logs and error messages.
    pub adapter: String,
    /// The `body.capabilities` object from the `initialize` response, so the
    /// frontend can degrade instead of sending requests the adapter refuses.
    pub capabilities: Value,
}

/// Resolve the adapter argv for a language id.
///
/// The frontend passes the configured `debug.adapters.<languageId>` entry
/// (mirroring how `lsp_start` receives the server command). There is
/// deliberately **no built-in default**: we never guess an adapter, so a
/// language with no configuration reports exactly that instead of failing
/// later with a confusing spawn error.
pub fn resolve_adapter_argv(
    language: &str,
    adapter: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let mut argv = adapter
        .map(|argv| argv.into_iter().filter(|a| !a.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if argv.is_empty() {
        return Err(format!("Debug adapter not configured: {language}"));
    }
    // Resolve a bare executable name against PATH so the adapter is spawned by
    // absolute path. This matters for `runInTerminal`: lldb-dap builds the
    // launcher command from its own `argv[0]`, and a bare name would become a
    // path relative to the IDE's cwd, which does not exist. An already-absolute
    // or explicitly-pathed program is left untouched.
    if let Some(resolved) = resolve_program_path(&argv[0]) {
        argv[0] = resolved;
    }
    Ok(argv)
}

/// Resolve a program to an absolute path: as given when it names a path, or by
/// searching `PATH` when it is a bare name. `None` when it cannot be found.
pub fn resolve_program_path(program: &str) -> Option<String> {
    let path = Path::new(program);
    if program.contains('/') || program.contains('\\') {
        return path.is_absolute().then(|| program.to_string());
    }
    let search = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        let has_ext = Path::new(program).extension().is_some();
        if has_ext {
            vec![program.to_string()]
        } else {
            vec![format!("{program}.exe"), program.to_string()]
        }
    } else {
        vec![program.to_string()]
    };
    for dir in std::env::split_paths(&search) {
        for name in &names {
            let candidate: PathBuf = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A program to run in the Debug Terminal, parsed from a DAP `runInTerminal`
/// request. By the spec the program is `args[0]` (not a separate `program`
/// field), which is also how lldb-dap builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalLaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// Parse a `runInTerminal` request into a launch spec.
///
/// `env` values of `null` mean "unset" per the spec; only string values are
/// forwarded, which keeps the common case simple.
pub fn parse_run_in_terminal(arguments: &Value) -> Result<TerminalLaunchSpec, String> {
    let args: Vec<String> = arguments
        .get("args")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let Some((program, rest)) = args.split_first() else {
        return Err("runInTerminal request has no program".to_string());
    };
    let cwd = arguments
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(map) = arguments.get("env").and_then(Value::as_object) {
        for (key, value) in map {
            if let Some(value) = value.as_str() {
                env.push((key.clone(), value.to_string()));
            }
        }
    }
    Ok(TerminalLaunchSpec {
        program: program.clone(),
        args: rest.to_vec(),
        cwd,
        env,
    })
}

/// The `initialize` arguments.
///
/// Two fields carry real weight for this client:
/// - `linesStartAt1` / `columnsStartAt1`: DAP lines are **1-based**, like
///   Monaco's, so no coordinate conversion is needed anywhere in the app.
/// - `pathFormat: "path"`: the adapter sends `Source.path` instead of an opaque
///   `sourceReference`, which is what lets the call stack and the stopped
///   location reuse the existing `openAndReveal` navigation (including files
///   outside the workspace).
///
/// The rest declares what this phase can actually do, so adapters do not offer
/// capabilities (terminal launch, memory, paginated variables) that would be
/// answered with an error.
pub fn initialize_arguments(adapter_id: &str) -> Value {
    json!({
        "clientID": CLIENT_ID,
        "clientName": CLIENT_ID,
        "adapterID": adapter_id,
        "locale": "en",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "pathFormat": "path",
        "supportsVariableType": true,
        "supportsVariablePaging": false,
        // Programming I/O belongs in a terminal, not the Output panel: advertising
        // this lets the adapter ask us (via a `runInTerminal` reverse request) to
        // launch the debuggee in the Debug Terminal, which is what makes
        // interactive `stdin` work. See `debug::session` for the handler.
        "supportsRunInTerminalRequest": true,
        "supportsStartDebuggingRequest": false,
        "supportsProgressReporting": false,
        "supportsInvalidatedEvent": false,
        "supportsMemoryReferences": false,
        "supportsArgsCanBeInterpretedByShell": false,
        "supportsMemoryEvent": false,
    })
}

/// The `launch` arguments the frontend already assembled.
///
/// The frontend owns the merge (defaults ⊕ `debug.launch.<languageId>` ⊕
/// variable expansion) because it knows the active file and the workspace; the
/// backend only forwards it, which keeps this layer free of any knowledge of
/// what a launch configuration means.
pub fn launch_arguments(launch: &Value) -> Value {
    if launch.is_object() {
        launch.clone()
    } else {
        json!({})
    }
}

/// Fail fast when the configured program is not on disk.
///
/// This is generic — it looks at nothing but the `program` field — but it
/// removes the most common phase-1 mistake: launching before the project has
/// been built. The alternative is an adapter-side launch failure whose wording
/// differs per adapter.
pub fn verify_program(launch: &Value) -> Result<(), String> {
    let Some(program) = launch.get("program").and_then(Value::as_str) else {
        return Ok(());
    };
    if program.is_empty() || std::path::Path::new(program).exists() {
        return Ok(());
    }
    Err(format!(
        "program not found: {program} (build the project first, or set debug.launch.program)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_adapter_is_reported_with_the_language_id() {
        let err = resolve_adapter_argv("cpp", None).unwrap_err();
        assert_eq!(err, "Debug adapter not configured: cpp");
        // The message must name whatever language the user is editing, not a
        // hardcoded one.
        let err = resolve_adapter_argv("rust", None).unwrap_err();
        assert_eq!(err, "Debug adapter not configured: rust");
    }

    #[test]
    fn blank_adapter_entries_count_as_unconfigured() {
        assert!(resolve_adapter_argv("cpp", Some(vec![])).is_err());
        assert!(resolve_adapter_argv("cpp", Some(vec![String::new()])).is_err());
    }

    #[test]
    fn adapter_argv_is_passed_through_for_an_explicit_path() {
        // An explicit path is not rewritten (only a bare name is resolved).
        let argv = resolve_adapter_argv(
            "cpp",
            Some(vec!["/opt/tools/lldb-dap".into(), "--foo".into()]),
        )
        .unwrap();
        assert_eq!(argv, vec!["/opt/tools/lldb-dap".to_string(), "--foo".to_string()]);
    }

    #[test]
    fn program_resolution_handles_paths_without_touching_path_env() {
        // An absolute path is returned as-is; a relative/unknown one is not
        // invented. (The bare-name PATH search is exercised for real by the
        // adapter E2E, which spawns `lldb-dap` by name.)
        let exe = std::env::current_exe().unwrap();
        let resolved = resolve_program_path(&exe.to_string_lossy()).unwrap();
        assert_eq!(Path::new(&resolved), exe.as_path());
        assert!(resolve_program_path("lite-ide-nonexistent-adapter-xyz").is_none());
    }

    #[test]
    fn parse_run_in_terminal_uses_args_zero_as_the_program() {
        // Shape taken from a real lldb-dap request.
        let spec = parse_run_in_terminal(&json!({
            "kind": "integrated",
            "cwd": "/proj",
            "args": ["/usr/bin/lldb-dap", "--comm-file", "/tmp/c", "--launch-target", "/proj/app"]
        }))
        .unwrap();
        assert_eq!(spec.program, "/usr/bin/lldb-dap");
        assert_eq!(
            spec.args,
            vec!["--comm-file", "/tmp/c", "--launch-target", "/proj/app"]
        );
        assert_eq!(spec.cwd.as_deref(), Some(Path::new("/proj")));
        assert!(spec.env.is_empty());
    }

    #[test]
    fn parse_run_in_terminal_rejects_a_missing_program() {
        assert!(parse_run_in_terminal(&json!({ "args": [] })).is_err());
        assert!(parse_run_in_terminal(&json!({})).is_err());
    }

    #[test]
    fn parse_run_in_terminal_keeps_only_string_env_values() {
        let spec = parse_run_in_terminal(&json!({
            "args": ["/bin/app"],
            "env": { "A": "1", "B": null, "C": "x" }
        }))
        .unwrap();
        assert_eq!(
            spec.env,
            vec![("A".to_string(), "1".to_string()), ("C".to_string(), "x".to_string())]
        );
    }

    #[test]
    fn initialize_declares_one_based_lines_and_path_format() {
        let args = initialize_arguments("cpp");
        assert_eq!(args["linesStartAt1"], true);
        assert_eq!(args["columnsStartAt1"], true);
        assert_eq!(args["pathFormat"], "path");
        assert_eq!(args["adapterID"], "cpp");
        assert_eq!(args["clientID"], CLIENT_ID);
        // This client can now run the program in the Debug Terminal, so it does
        // advertise `runInTerminal`; it still cannot read memory.
        assert_eq!(args["supportsRunInTerminalRequest"], true);
        assert_eq!(args["supportsMemoryReferences"], false);
    }

    #[test]
    fn launch_arguments_default_to_an_empty_object() {
        assert_eq!(launch_arguments(&Value::Null), json!({}));
        assert_eq!(launch_arguments(&json!("nope")), json!({}));
        assert_eq!(
            launch_arguments(&json!({"program": "/tmp/a"})),
            json!({"program": "/tmp/a"})
        );
    }

    #[test]
    fn a_missing_program_is_reported_before_launching() {
        let err = verify_program(&json!({"program": "/nonexistent/lite-ide-test-binary"}))
            .unwrap_err();
        assert!(err.contains("program not found"));
    }

    #[test]
    fn a_present_or_absent_program_field_is_accepted() {
        // No `program` (e.g. an attach-shaped config) is not our business.
        assert!(verify_program(&json!({})).is_ok());
        assert!(verify_program(&json!({"program": ""})).is_ok());
        assert!(verify_program(&json!({"program": std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned()}))
        .is_ok());
    }
}
