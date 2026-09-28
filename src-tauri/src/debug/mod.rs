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
//! The one place a debugger's identity is read is [`attach_pid_field`], and it
//! reads the *adapter command line* rather than any configuration key: DAP does
//! not standardize the name of the "attach to this pid" field, and GDB's own DAP
//! server is the outlier that refuses the conventional one. Keying that off a
//! type or a language would mean hardcoding a debugger table that is wrong as
//! soon as someone registers the same debugger under a second name, so the
//! command line — the one thing that states which debugger is about to run —
//! is the input instead. Nothing else in the client knows GDB exists.
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
    pub session_id: u64,
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
            // Order matters: a real executable first, then the batch shims that
            // `npm`/`pnpm`/`yarn` install, then the bare name. The bare name is
            // last because on Windows it is usually the *shell* shim sitting
            // beside the `.cmd` one, and spawning a shell script through
            // `CreateProcess` fails.
            vec![
                format!("{program}.exe"),
                format!("{program}.cmd"),
                format!("{program}.bat"),
                program.to_string(),
            ]
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

/// Whether a program has to be started through a command interpreter.
///
/// On Windows `std::process::Command` does not apply `PATHEXT`, so a `.cmd` /
/// `.bat` shim cannot be executed directly — it needs `cmd /c`. Every adapter
/// installed with `npm`, `pnpm` or `yarn` is one of these shims, so without this
/// the most common way of installing a debug adapter would simply not start.
pub fn needs_command_interpreter(program: &str) -> bool {
    cfg!(windows)
        && (program.to_ascii_lowercase().ends_with(".cmd")
            || program.to_ascii_lowercase().ends_with(".bat"))
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

/// The debuggee to run in the Debug Terminal, taken from an ordinary
/// `launch.json` configuration.
///
/// This is what makes the split work without the user touching their config:
/// the fields the user wrote to describe *their program* — `program`, `args`,
/// `cwd`, `env` — are read here and used to spawn the debuggee in a pty, while
/// the same configuration keeps going to the adapter as DAP arguments. Nothing
/// language-specific is involved: these are generic launch fields, and anything
/// else the user wrote still reaches the adapter untouched.
#[derive(Debug, Clone, PartialEq)]
pub struct DebuggeeSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl DebuggeeSpec {
    /// The `attach` arguments for this debuggee, built on top of the user's own
    /// launch configuration.
    ///
    /// The configuration is the starting point, not something to discard:
    /// adapter-specific keys the user set (`MIMode`, `initCommands`, a
    /// `MIMode`-specific `stopOnEntry`, …) still describe how the adapter should
    /// debug *this* program, and used to reach it on the `launch` request. So
    /// they are kept.
    ///
    /// Three things are then corrected. The pid is the one the pty actually
    /// produced, written under whichever name this adapter expects (see
    /// [`AttachPidField`]); `program` and `cwd` are re-asserted because they are
    /// how the adapter makes sense of a process it did not start: `program` is
    /// the only way it can learn the executable's symbols, and `cwd` is what
    /// relative paths inside the program resolve against.
    ///
    /// `args` and `env` are *dropped*: that command line and that environment
    /// were already given to the process by the pty spawn, so sending them again
    /// would describe a run that is not happening and could tempt an adapter
    /// into starting a second copy.
    pub fn attach_arguments(&self, process_id: u32, launch: &Value, pid_field: AttachPidField) -> Value {
        let mut arguments = if launch.is_object() {
            launch.clone()
        } else {
            json!({})
        };
        let object = arguments.as_object_mut().expect("built as an object");
        object.remove("args");
        object.remove("env");
        object.remove("request");
        // The two spellings are mutually exclusive: leaving the other one behind
        // would be a stale key the adapter never asked for, and a `pid` the
        // pty no longer owns.
        match pid_field {
            AttachPidField::ProcessId => {
                object.remove("pid");
                object.insert("processId".to_string(), json!(process_id.to_string()));
            }
            AttachPidField::GdbPid => {
                object.remove("processId");
                object.insert("pid".to_string(), json!(process_id));
            }
        }
        object.insert("program".to_string(), json!(self.program));
        if let Some(cwd) = &self.cwd {
            object.insert("cwd".to_string(), json!(cwd.to_string_lossy()));
        }
        arguments
    }
}

/// Which key an adapter's `attach` request expects for "attach to this pid".
///
/// DAP itself does not standardize this: it names the field in the *request*, not
/// in `AttachRequestArguments`, and adapters disagree. `cdt-gdb-adapter`,
/// `lldb-dap` and every adapter written against the DAP convention use
/// `processId`. GDB's own DAP server does not, and the difference is not
/// cosmetic — with `processId` it refuses the request outright:
///
/// ```text
/// attach: attach requires either 'pid' or 'target'
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachPidField {
    /// The DAP-conventional `processId`, sent as a string.
    ProcessId,
    /// GDB's DAP server names it `pid`, and accepts **only a JSON integer** —
    /// `"pid": "1234"` is rejected with
    /// `value for 'pid' does not have expected type 'int | None'`.
    GdbPid,
}

/// Which `attach` pid spelling the adapter at `argv` expects.
///
/// This reads the adapter *command line*, not the configuration's `type`: a type
/// is just the key the user filed the adapter under (`cpp-gdb`, `cpp`, `c`…), so
/// keying off it would hardcode a language-to-debugger table that is wrong the
/// moment someone registers the same debugger twice or renames a type. The
/// command line is the only thing that actually says which debugger is about to
/// be spawned.
///
/// Only GDB's own DAP server is special-cased, and only when it is recognisably
/// that: a `gdb` executable (including a cross-prefixed `…-gdb`) whose *own*
/// arguments select the DAP interpreter. Anything else — `lldb-dap`,
/// `cdtDebugAdapter`, a wrapper we cannot see into, a future adapter we have
/// never heard of — keeps the conventional `processId`, i.e. today's behaviour.
///
/// A wrapper is handled by looking past the first argument: `cmd /c gdb -i dap`
/// is found because the scan accepts a gdb executable at *any* position and
/// then reads the arguments that follow it, which is where that gdb's own
/// arguments begin. A wrapper puts its own options *before* the program it
/// launches, so nothing ahead of the executable can be mistaken for GDB's.
pub fn attach_pid_field(argv: &[String]) -> AttachPidField {
    for (index, arg) in argv.iter().enumerate() {
        if !is_gdb_executable(arg) {
            continue;
        }
        if selects_dap_interpreter(&argv[index + 1..]) {
            return AttachPidField::GdbPid;
        }
    }
    AttachPidField::ProcessId
}

/// Whether a program is GDB, however it is spelled or prefixed.
fn is_gdb_executable(arg: &str) -> bool {
    let name = arg.rsplit(['/', '\\']).next().unwrap_or(arg);
    let stem = name
        .rsplit_once('.')
        .map(|(stem, _extension)| stem)
        .unwrap_or(name)
        .to_ascii_lowercase();
    stem == "gdb" || stem.ends_with("-gdb")
}

/// Whether these arguments leave GDB in its DAP server mode.
///
/// The three spellings GDB accepts for its interpreter option, and nothing else.
/// A repeated option is resolved the way GDB itself resolves it — the last one
/// wins — so `gdb -i dap -i mi2` is correctly *not* DAP, which is what that
/// gdb will actually do once it starts.
fn selects_dap_interpreter(args: &[String]) -> bool {
    let mut selected: Option<&str> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == "-i" || arg == "--interpreter" {
            if let Some(value) = args.get(index + 1) {
                selected = Some(value.as_str());
                index += 1;
            }
        } else if let Some(value) = arg.strip_prefix("--interpreter=") {
            selected = Some(value);
        }
        index += 1;
    }
    selected == Some("dap")
}

/// Read the debuggee out of a launch configuration, or `None` when there is
/// nothing to run.
///
/// `None` means "keep the previous behaviour": a configuration without a
/// `program` is an attach-shaped config (attach to a pid, or to a process the
/// adapter itself starts), so there is no process for the pty to own.
pub fn debuggee_spec(launch: &Value) -> Option<DebuggeeSpec> {
    let program = launch
        .get("program")
        .and_then(Value::as_str)
        .filter(|program| !program.is_empty())?;
    let args = launch
        .get("args")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let cwd = launch
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .map(PathBuf::from);
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(map) = launch.get("env").and_then(Value::as_object) {
        for (key, value) in map {
            // `null` means "unset this variable for the child", which is
            // expressed by simply not inheriting it into the pty.
            if let Some(value) = value.as_str() {
                env.push((key.clone(), value.to_string()));
            }
        }
    }
    Some(DebuggeeSpec {
        program: program.to_string(),
        args,
        cwd,
        env,
    })
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
    fn a_launch_config_yields_the_debuggee_the_user_described() {
        let spec = debuggee_spec(&json!({
            "program": "/proj/app",
            "args": ["--flag", "1"],
            "cwd": "/proj",
            "env": { "A": "1", "B": null, "C": "x" },
            "stopOnEntry": false,
            "console": "integratedTerminal",
        }))
        .unwrap();
        assert_eq!(spec.program, "/proj/app");
        assert_eq!(spec.args, vec!["--flag".to_string(), "1".to_string()]);
        assert_eq!(spec.cwd.as_deref(), Some(Path::new("/proj")));
        // `null` unsets, so it is not forwarded as a variable.
        assert_eq!(
            spec.env,
            vec![("A".to_string(), "1".to_string()), ("C".to_string(), "x".to_string())]
        );
    }

    #[test]
    fn a_config_without_a_program_stays_with_the_adapter() {
        // Attach-shaped configs name a process, not a binary to launch, so
        // there is nothing for the pty to own.
        assert!(debuggee_spec(&json!({})).is_none());
        assert!(debuggee_spec(&json!({ "program": "" })).is_none());
        assert!(debuggee_spec(&json!({ "processId": "1234" })).is_none());
        assert!(debuggee_spec(&Value::Null).is_none());
    }

    #[test]
    fn missing_launch_fields_fall_back_to_neutral_values() {
        let spec = debuggee_spec(&json!({ "program": "app" })).unwrap();
        assert!(spec.args.is_empty());
        assert!(spec.cwd.is_none());
        assert!(spec.env.is_empty());
    }

    #[test]
    fn attach_arguments_carry_the_pid_and_symbols_but_not_the_command_line() {
        let launch = json!({
            "program": "/proj/app",
            "args": ["--flag"],
            "cwd": "/proj",
        });
        let spec = debuggee_spec(&launch).unwrap();
        let arguments = spec.attach_arguments(4321, &launch, AttachPidField::ProcessId);
        // The pid is a string per the DAP schema; real adapters also accept a
        // number, but the schema is what we follow.
        assert_eq!(arguments["processId"], "4321");
        assert_eq!(arguments["program"], "/proj/app");
        assert_eq!(arguments["cwd"], "/proj");
        // The command line was already given to the process by the spawn; an
        // attach must not try to re-run it.
        assert!(arguments.get("args").is_none());
    }

    #[test]
    fn attach_arguments_keep_the_users_adapter_specific_settings() {
        // These describe how the adapter should debug the program, and used to
        // reach it on the `launch` request, so they must survive the switch.
        let launch = json!({
            "type": "cpp-gdb",
            "program": "/proj/app",
            "args": ["--flag"],
            "cwd": "/proj",
            "stopOnEntry": true,
            "MIMode": "gdb",
            "initCommands": ["set print pretty on"],
        });
        let spec = debuggee_spec(&launch).unwrap();
        let arguments = spec.attach_arguments(99, &launch, AttachPidField::ProcessId);
        assert_eq!(arguments["type"], "cpp-gdb");
        assert_eq!(arguments["stopOnEntry"], true);
        assert_eq!(arguments["MIMode"], "gdb");
        assert_eq!(arguments["initCommands"][0], "set print pretty on");
        // The pty already handed the process its command line and environment.
        assert!(arguments.get("args").is_none());
        assert!(arguments.get("env").is_none());
    }

    #[test]
    fn attach_arguments_drop_the_request_selector() {
        // `request` picks which DAP request to send; sending it as an argument
        // too would hand the adapter a key it never asked for.
        let launch = json!({ "request": "launch", "program": "app" });
        let spec = debuggee_spec(&launch).unwrap();
        let arguments = spec.attach_arguments(5, &launch, AttachPidField::ProcessId);
        assert!(arguments.get("request").is_none());
        assert_eq!(arguments["processId"], "5");
    }

    #[test]
    fn attach_arguments_omit_an_absent_cwd() {
        let launch = json!({ "program": "app" });
        let spec = debuggee_spec(&launch).unwrap();
        let arguments = spec.attach_arguments(7, &launch, AttachPidField::ProcessId);
        assert!(arguments.get("cwd").is_none());
        assert_eq!(arguments["processId"], "7");
    }

    #[test]
    fn gdb_dap_gets_a_numeric_pid_and_never_a_process_id() {
        // `gdb -i dap` rejects `processId` outright ("attach requires either
        // 'pid' or 'target'") and rejects a *string* `pid` ("value for 'pid'
        // does not have expected type 'int | None'"), so both halves of this
        // mapping are load-bearing.
        let launch = json!({ "program": "/proj/app", "cwd": "/proj" });
        let spec = debuggee_spec(&launch).unwrap();
        let arguments = spec.attach_arguments(4321, &launch, AttachPidField::GdbPid);
        assert_eq!(arguments["pid"], json!(4321));
        assert!(arguments["pid"].is_number());
        assert!(arguments.get("processId").is_none());
        // Everything else about the request is unchanged by the spelling.
        assert_eq!(arguments["program"], "/proj/app");
        assert_eq!(arguments["cwd"], "/proj");
    }

    #[test]
    fn the_pid_field_the_adapter_never_asked_for_is_dropped() {
        // A configuration that names a pid itself keeps only the one this
        // adapter can read: two spellings would be a stale key, and the losing
        // one still points at a process that is no longer there.
        let launch = json!({ "program": "app", "processId": "1", "pid": 2 });
        let spec = debuggee_spec(&launch).unwrap();
        let conventional = spec.attach_arguments(7, &launch, AttachPidField::ProcessId);
        assert_eq!(conventional["processId"], "7");
        assert!(conventional.get("pid").is_none());

        let gdb = spec.attach_arguments(7, &launch, AttachPidField::GdbPid);
        assert_eq!(gdb["pid"], json!(7));
        assert!(gdb.get("processId").is_none());
    }

    #[test]
    fn the_pid_field_comes_from_the_adapter_command_not_the_type() {
        // Everything a user might reasonably register a GDB DAP under has to
        // resolve the same way, because the type is only the config key.
        for gdb in [
            "gdb",
            "gdb.exe",
            "D:/tools/gdb.exe",
            "C:/Program Files/mingw64/bin/x86_64-w64-mingw32-gdb.exe",
            "arm-none-eabi-gdb",
        ] {
            for selector in [
                &["-i", "dap"][..],
                &["--interpreter=dap"][..],
                &["--interpreter", "dap"][..],
            ] {
                let full = argv(&[gdb, selector[0], selector[1]]);
                assert_eq!(
                    attach_pid_field(&full),
                    AttachPidField::GdbPid,
                    "expected GdbPid for {full:?}"
                );
            }
            // A gdb that is not in DAP mode stays conventional.
            let plain = argv(&[gdb]);
            assert_eq!(
                attach_pid_field(&plain),
                AttachPidField::ProcessId,
                "expected ProcessId for {plain:?}"
            );
        }
    }

    #[test]
    fn a_wrapped_gdb_dap_is_still_recognized() {
        // The scan does not assume the debugger is argv[0], and it reads the
        // arguments that follow the executable, because that is where that
        // gdb's own arguments begin.
        let wrapped = argv(&["cmd", "/c", "C:/tools/gdb.exe", "-i", "dap"]);
        assert_eq!(attach_pid_field(&wrapped), AttachPidField::GdbPid);
        // Only what follows the gdb is read: a wrapper's own options come first,
        // and are not the debugger's.
        let before = argv(&["-i", "dap", "gdb"]);
        assert_eq!(attach_pid_field(&before), AttachPidField::ProcessId);
    }

    #[test]
    fn a_repeated_interpreter_option_resolves_as_gdb_resolves_it() {
        // GDB lets the last one win, so a `dap` that a later option overrides
        // would send an adapter an `attach` it never asked for.
        assert_eq!(
            attach_pid_field(&argv(&["gdb", "-i", "dap", "-i", "mi2"])),
            AttachPidField::ProcessId
        );
        assert_eq!(
            attach_pid_field(&argv(&["gdb", "-i", "mi2", "--interpreter=dap"])),
            AttachPidField::GdbPid
        );
    }

    #[test]
    fn every_other_adapter_keeps_the_conventional_process_id() {
        // The default must be today's behaviour, so no adapter that works now
        // can be broken by the mapping.
        for command in [
            &["lldb-dap"][..],
            &["D:/bin/lldb-dap", "-f"][..],
            &["cdtDebugAdapter.cmd"][..],
            &["cmd", "/c", "C:/bin/cdtDebugAdapter.cmd", "--dtemplate"][..],
            // GDBs that are not in DAP mode, and an unrelated program that
            // merely mentions a gdb.
            &["gdb", "-i", "mi2"][..],
            &["gdb", "--interpreter=mi2"][..],
            &["gdbserver", "--once", ":2345"][..],
            &["--gdb-init", "gdb"][..],
            &["rgdb"][..],
        ] {
            let command = argv(command);
            assert_eq!(
                attach_pid_field(&command),
                AttachPidField::ProcessId,
                "expected ProcessId for {command:?}"
            );
        }
    }

    /// Adapter command lines are far more readable written as string literals
    /// than as `String::from` noise.
    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    #[test]
    fn batch_shims_are_recognized_so_they_can_be_run_through_a_shell() {
        // `pnpm`/`npm` install a `cdtDebugAdapter.cmd` next to the bare shell
        // shim; only the batch file can actually be started on Windows.
        assert!(needs_command_interpreter("C:/bin/cdtDebugAdapter.cmd"));
        assert!(needs_command_interpreter("C:/bin/lldb-dap.CMD"));
        assert!(needs_command_interpreter("C:/bin/tool.bat"));
        assert!(!needs_command_interpreter("C:/bin/lldb-dap.exe"));
        assert!(!needs_command_interpreter("lldb-dap"));
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
