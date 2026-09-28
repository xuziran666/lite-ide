//! End-to-end proof of the **native GDB** debug architecture.
//!
//! ```text
//! Debug Terminal pty  <-->  debuggee (stdin/stdout/stderr)
//! DAP                 <-->  gdb -i dap  --attach-->  debuggee pid
//! ```
//!
//! `dap_attach_pty.rs` proves the same split for cdt-gdb-adapter. This one
//! proves it for GDB's own DAP server, which is where the protocol is *not* the
//! protocol everyone else speaks: its `attach` request wants a numeric `pid`,
//! not cdt's string `processId`. The `attach` body is therefore not hand-built
//! here but produced by the same [`DebuggeeSpec::attach_arguments`] the IDE
//! uses, so a regression in that mapping fails this test instead of only
//! showing up as a rejected request in the GUI.
//!
//! The toolchain is looked up on `PATH`, so the suite still runs on a machine
//! without a C++ toolchain or without gdb.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use lite_ide_lib::debug::session::DebugSession;
use lite_ide_lib::debug::{attach_pid_field, AttachPidField, DebuggeeSpec};
use lite_ide_lib::terminal::TerminalSession;

/// The fixture, shared with `dap_attach_pty.rs`: the read before the breakpoint
/// is what keeps the process alive long enough to be attached to.
const FIXTURE: &str = r#"#include <iostream>

int main() {
    int x;
    std::cout << "waiting input..." << std::endl;
    std::cin >> x;
    int y = x * 2;   // breakpoint
    std::cout << "result: " << y << std::endl;
    return 0;
}
"#;

/// 1-based line of `int y = x * 2;`.
const BREAKPOINT_LINE: u64 = 7;

type PtyLog = Arc<Mutex<Vec<u8>>>;

#[test]
fn attaches_native_gdb_dap_to_a_pty_spawned_program() {
    let Some(compiler) = find_tool("g++").or_else(|| find_tool("clang++")) else {
        eprintln!("skipping native gdb DAP test: no g++/clang++ on PATH");
        return;
    };
    let Some(gdb) = find_tool("gdb").or_else(|| find_tool("gdb.exe")) else {
        eprintln!("skipping native gdb DAP test: no gdb on PATH");
        return;
    };

    let dir = TempDir::new("lite-ide-dap-gdb-native");
    let source = dir.path().join("main.cpp");
    let binary = dir.path().join(if cfg!(windows) { "app.exe" } else { "app" });
    fs::write(&source, FIXTURE).expect("write fixture");
    let output = Command::new(&compiler)
        .args(["-g", "-O0", "-std=c++17"])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap_or_else(|err| panic!("failed to run {compiler:?}: {err}"));
    assert!(
        output.status.success(),
        "compiling the fixture failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let log: PtyLog = Arc::new(Mutex::new(Vec::new()));
    let sink_log = Arc::clone(&log);
    let sink: lite_ide_lib::terminal::OutputSink = Arc::new(move |data: Vec<u8>| {
        if data.is_empty() {
            return;
        }
        sink_log.lock().unwrap().extend_from_slice(&data);
    });
    let terminal = TerminalSession::spawn_program(
        &binary.to_string_lossy(),
        &Vec::new(),
        Some(dir.path().to_path_buf()),
        &Vec::new(),
        sink,
    )
    .expect("spawn the debuggee in a pty");
    let terminal = Arc::new(Mutex::new(terminal));

    let responder = dsr_responder(&terminal, &log);

    let pid = terminal
        .lock()
        .unwrap()
        .process_id()
        .unwrap_or_else(|| panic!("the pty child reported no process id"));
    assert_ne!(pid, 0, "the pty child reported a zero pid");
    println!("debuggee pid = {pid}");

    let argv = vec![
        gdb.to_string_lossy().into_owned(),
        "-i".to_string(),
        "dap".to_string(),
    ];

    let launch = json!({
        "type": "cpp-gdb",
        "request": "attach",
        "name": "attach (native gdb)",
        "program": binary.to_string_lossy(),
        "cwd": dir.path().to_string_lossy(),
        "MIMode": "gdb",
        "stopOnEntry": false,
        "args": ["--belongs-to-the-pty-spawn"],
    });
    let spec = DebuggeeSpec {
        program: binary.to_string_lossy().into_owned(),
        args: vec!["--belongs-to-the-pty-spawn".to_string()],
        cwd: Some(dir.path().to_path_buf()),
        env: Vec::new(),
    };

    let pid_field = attach_pid_field(&argv);
    assert_eq!(
        pid_field,
        AttachPidField::GdbPid,
        "gdb -i dap was not recognised as gdb's own DAP server"
    );
    let arguments = spec.attach_arguments(pid, &launch, pid_field);

    // GDB's DAP server wants the pid as a JSON number under `pid`; a string, or
    // cdt's `processId`, is rejected with "attach requires either 'pid' or
    // 'target'" / "does not have expected type 'int | None'". Assert the shape
    // so that regression is named here rather than surfacing as a hang.
    assert_eq!(
        arguments["pid"].as_u64(),
        Some(pid as u64),
        "attach did not carry the pty child's pid as a number: {arguments}"
    );
    assert!(
        arguments.get("processId").is_none(),
        "attach leaked cdt's processId into a gdb request: {arguments}"
    );
    assert!(arguments.get("args").is_none(), "{arguments}");
    assert_eq!(arguments["program"], binary.to_string_lossy().as_ref());

    let session = DebugSession::start(None, "cpp-gdb", &argv).expect("start gdb -i dap");
    session
        .request("setExceptionBreakpoints", json!({ "filters": [] }))
        .expect("setExceptionBreakpoints");

    session
        .send_request("attach", arguments)
        .expect("send attach");

    assert!(session.await_initialized(), "gdb never sent `initialized`");

    // GDB answers `verified: false` here: the source cannot be resolved until
    // the attach completes, which it only does after `configurationDone`. The
    // breakpoint is still installed, and the stop below is the real proof.
    session
        .request(
            "setBreakpoints",
            json!({
                "source": { "path": source.to_string_lossy() },
                "breakpoints": [{ "line": BREAKPOINT_LINE }],
                "sourceModified": false,
            }),
        )
        .expect("setBreakpoints");
    session
        .request("configurationDone", Value::Null)
        .expect("configurationDone");

    let printed = wait_for(
        || {
            let text = pty_text(&log);
            if text.contains("waiting input...") {
                Some(text)
            } else {
                None
            }
        },
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| {
        panic!(
            "the program never printed its prompt on the pty (got {:?})",
            pty_text(&log)
        )
    });
    assert!(
        !printed.contains("[New Thread") && !printed.contains("GNU gdb"),
        "adapter chatter reached the program's stdout: {printed:?}"
    );

    terminal
        .lock()
        .unwrap()
        .write("123\r")
        .expect("write to the debug terminal");

    // GDB stops the process the moment it attaches, inside the read syscall.
    // Leaving that stop is what Continue does in the IDE, so the test does it
    // too, until the top frame is the breakpoint.
    let frame_id = wait_for(
        || {
            let thread = first_thread(&session).ok()?;
            let (frame_id, line) = top_frame(&session, thread)?;
            if line == BREAKPOINT_LINE as i64 {
                return Some(frame_id);
            }
            let _ = session.request("continue", json!({ "threadId": thread }));
            None
        },
        Duration::from_secs(60),
    )
    .unwrap_or_else(|| {
        panic!(
            "gdb never stopped at line {BREAKPOINT_LINE}; pty had {:?}. \
             A rejected `attach` is reported by gdb as an `output` event, which \
             this test cannot see — rerun `gdb -i dap` by hand to see it.",
            pty_text(&log)
        )
    });

    let scopes = session
        .request("scopes", json!({ "frameId": frame_id }))
        .expect("scopes");
    let mut seen_x = false;
    for scope in scopes["scopes"].as_array().expect("scopes array") {
        let reference = scope["variablesReference"].as_i64().unwrap_or(0);
        if reference <= 0 {
            continue;
        }
        let variables = session
            .request("variables", json!({ "variablesReference": reference }))
            .expect("variables");
        for variable in variables["variables"].as_array().expect("variables") {
            if variable["name"] == "x" {
                assert_eq!(
                    variable["value"], "123",
                    "the program did not read the value typed into the Debug Terminal"
                );
                seen_x = true;
            }
        }
    }
    assert!(seen_x, "the stopped frame does not expose `x`");

    session
        .request("continue", json!({ "threadId": 1 }))
        .expect("continue");
    let final_text = wait_for(
        || {
            let text = pty_text(&log);
            if text.contains("result: 246") {
                Some(text)
            } else {
                None
            }
        },
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| {
        panic!(
            "the program never printed its result on the pty (got {:?})",
            pty_text(&log)
        )
    });
    assert!(
        !final_text.contains("[New Thread")
            && !final_text.contains("[Inferior")
            && !final_text.contains("GNU gdb")
            && !final_text.contains("attached to process"),
        "debugger output leaked into the Debug Terminal: {final_text:?}"
    );

    session.shutdown();
    terminal.lock().unwrap().kill();
    let _ = responder;
}

/// A pty child on Windows asks where the cursor is (`ESC[6n`) and blocks until
/// it is answered. xterm.js answers that on its own; a headless test has to.
fn dsr_responder(terminal: &Arc<Mutex<TerminalSession>>, log: &PtyLog) -> std::thread::JoinHandle<()> {
    let terminal = Arc::clone(terminal);
    let log = Arc::clone(log);
    std::thread::spawn(move || {
        while !log.lock().unwrap().windows(4).any(|w| w == b"\x1b[6n") {
            std::thread::sleep(Duration::from_millis(20));
        }
        if let Ok(mut terminal) = terminal.lock() {
            let _ = terminal.write("\u{1b}[1;1R");
        }
    })
}

fn pty_text(log: &PtyLog) -> String {
    String::from_utf8_lossy(&log.lock().unwrap()).into_owned()
}

fn first_thread(session: &DebugSession) -> Result<i64, String> {
    let threads = session.request("threads", Value::Null)?;
    threads["threads"][0]["id"]
        .as_i64()
        .ok_or_else(|| format!("no threads reported: {threads}"))
}

fn top_frame(session: &DebugSession, thread: i64) -> Option<(i64, i64)> {
    let trace = session
        .request(
            "stackTrace",
            json!({ "threadId": thread, "startFrame": 0, "levels": 1 }),
        )
        .ok()?;
    let frame = &trace["stackFrames"][0];
    Some((frame["id"].as_i64()?, frame["line"].as_i64()?))
}

fn wait_for<T>(mut probe: impl FnMut() -> Option<T>, timeout: Duration) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = probe() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        vec![
            name.to_string(),
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for candidate in &candidates {
            let full = dir.join(candidate);
            if is_executable(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
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

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
