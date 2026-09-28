//! End-to-end proof of the **pty + attach** debug architecture.
//!
//! ```text
//! Debug Terminal pty  <-->  debuggee (stdin/stdout/stderr)
//! DAP                 <-->  debug adapter  <-->  gdb  --attach-->  debuggee pid
//! ```
//!
//! Every other debug test drives the protocol with hand-built JSON. This one
//! wires the two halves the way the IDE does and checks the thing that is easy
//! to get wrong and impossible to see in a unit test: that the debuggee's own
//! stdin/stdout are a real terminal that is completely independent of the
//! adapter's stdio, so
//!
//! 1. the program prints a prompt and blocks on `std::cin`,
//! 2. text typed into the pty reaches the program,
//! 3. the program then hits a breakpoint, and its variables are readable,
//! 4. continuing prints the result — all on the program's own stdout,
//! 5. and none of the adapter's own chatter (`[New Thread …]`, the GDB banner,
//!     `attached to process …`) is mixed into that stdout.
//!
//! The toolchain (compiler, adapter, and the adapter's launcher) is looked up on
//! `PATH`, so the suite still runs on a machine without a C++ toolchain.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use lite_ide_lib::debug::session::DebugSession;
use lite_ide_lib::terminal::TerminalSession;

/// The fixture. Line 7 is the breakpoint; `std::cin` before it is what makes the
/// program's stdin genuinely interactive, and what keeps the process alive long
/// enough for the adapter to attach to it.
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

/// Everything the program has printed on the pty so far.
type PtyLog = Arc<Mutex<Vec<u8>>>;

#[test]
fn attaches_a_debug_adapter_to_a_pty_spawned_program() {
    let Some(compiler) = find_tool("g++").or_else(|| find_tool("clang++")) else {
        eprintln!("skipping pty+attach test: no g++/clang++ on PATH");
        return;
    };
    let Some(adapter) = find_adapter() else {
        eprintln!("skipping pty+attach test: cdtDebugAdapter not on PATH");
        return;
    };

    let dir = TempDir::new("lite-ide-dap-pty-attach");
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

    // 1. The debuggee runs in a real pty — the Debug Terminal. Nothing about it
    //    is a shell: `stdin`/`stdout`/`stderr` are the pty itself.
    let log: PtyLog = Arc::new(Mutex::new(Vec::new()));
    let sink_log = Arc::clone(&log);
    let dsr = Arc::new(AtomicBool::new(false));
    let sink: lite_ide_lib::terminal::OutputSink = Arc::new(move |data: Vec<u8>| {
        if data.is_empty() {
            return;
        }
        sink_log.lock().unwrap().extend_from_slice(&data);
    });
    let args: Vec<String> = Vec::new();
    let env: Vec<(String, String)> = Vec::new();
    let terminal = TerminalSession::spawn_program(
        &binary.to_string_lossy(),
        &args,
        Some(dir.path().to_path_buf()),
        &env,
        sink,
    )
    .expect("spawn the debuggee in a pty");
    let terminal = Arc::new(Mutex::new(terminal));

    // Stand in for the browser: a pty child on Windows asks the terminal where
    // the cursor is (`ESC[6n`) and *blocks* until it is answered, so a driver
    // that stays silent would hang the program before its first print. xterm.js
    // answers this on its own; a headless test has to.
    let responder = {
        let terminal = Arc::clone(&terminal);
        let log = Arc::clone(&log);
        let dsr = Arc::clone(&dsr);
        std::thread::spawn(move || {
            while !dsr.load(Ordering::Relaxed) {
                if !log.lock().unwrap().windows(4).any(|w| w == b"\x1b[6n") {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                dsr.store(false, Ordering::Relaxed);
                if let Ok(mut terminal) = terminal.lock() {
                    let _ = terminal.write("\u{1b}[1;1R");
                }
            }
        })
    };

    // 2. The pid is the pty child's *own* pid, read from the child handle — not
    //    guessed, and not a shell wrapper's. The adapter attaches to exactly
    //    this process, so a wrong pid here would silently debug the wrong thing.
    let pid = terminal
        .lock()
        .unwrap()
        .process_id()
        .unwrap_or_else(|| panic!("the pty child reported no process id"));
    assert_ne!(pid, 0, "the pty child reported a zero pid");
    println!("debuggee pid = {pid}");

    let session = DebugSession::start(None, "cpp", &adapter).expect("start the debug adapter");
    session
        .request("setExceptionBreakpoints", json!({ "filters": [] }))
        .expect("setExceptionBreakpoints");

    // 3. Attach to the running program. `program` is still sent (it is what loads
    //    the executable's symbols); the arguments are not, because this program
    //    was already given its command line by the pty spawn.
    let attached = session.request(
        "attach",
        json!({
            "processId": pid,
            "program": binary.to_string_lossy(),
            "cwd": dir.path().to_string_lossy(),
        }),
    );
    assert!(
        attached.is_ok(),
        "attach to pid {pid} failed: {:?}",
        attached.err()
    );
    session.await_initialized();

    let set = session
        .request(
            "setBreakpoints",
            json!({
                "source": { "path": source.to_string_lossy() },
                "breakpoints": [{ "line": BREAKPOINT_LINE }],
                "sourceModified": false,
            }),
        )
        .expect("setBreakpoints");
    assert_eq!(
        set["breakpoints"][0]["verified"], true,
        "the adapter did not bind the breakpoint to the attached process: {set}"
    );
    session
        .request("configurationDone", Value::Null)
        .expect("configurationDone");

    // 4. The program's own prompt appears on the pty, and it blocks there — the
    //    adapter did not steal the program's stdin.
    let printed = wait_for(
        || {
            let text = pty_text(&log);
            if text.contains("waiting input...") {
                Some(text)
            } else {
                None
            }
        },
        Duration::from_secs(20),
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

    // 5. Text typed into the Debug Terminal arrives at the program, which then
    //    hits the breakpoint. This single step is the whole point of the split:
    //    the debuggee's stdin and the adapter's DAP/MI stdin are separate fds.
    //    `\r` is what a real terminal sends for Enter, and on Windows it — not
    //    `\n` — is what ends a console line read.
    terminal
        .lock()
        .unwrap()
        .write("123\r")
        .expect("write to the debug terminal");
    let thread = wait_for(
        || first_thread(&session).ok(),
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| {
        panic!(
            "the program never stopped after its input; pty had {:?}",
            pty_text(&log)
        )
    });
    let (frame_id, line) = wait_for(
        || top_frame(&session, thread),
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| panic!("the program never stopped at line {BREAKPOINT_LINE}"));
    assert_eq!(line, BREAKPOINT_LINE as i64, "stopped at the wrong line");

    // 6. The value the user typed is visible in the stopped frame.
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

    // 7. Continue: the result the program prints must arrive on the pty.
    session
        .request("continue", json!({ "threadId": thread }))
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

    // 8. The adapter is gone but the program is not: this adapter reports
    //    `supportsTerminateRequest: false` for a local target, so the debuggee
    //    outlives it and *the IDE* has to be the one that ends the session.
    session.shutdown();
    terminal.lock().unwrap().kill();
    let _ = responder;
}

/// The pty bytes collected so far, as lossy UTF-8.
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

/// The argv that starts `cdtDebugAdapter`.
///
/// On Windows the pnpm/npm install puts a `cdtDebugAdapter.cmd` shim on `PATH`.
/// `std::process::Command` does not apply `PATHEXT`, so a batch file cannot be
/// spawned directly and has to go through `cmd /c` — the same reason a shell
/// script is not executable on Unix either.
fn find_adapter() -> Option<Vec<String>> {
    let shim = find_tool("cdtDebugAdapter")
        .or_else(|| find_tool("cdtDebugAdapter.cmd"))
        .or_else(|| find_tool("cdtDebugAdapter.exe"))?;
    let shim = shim.to_string_lossy().into_owned();
    if cfg!(windows) && (shim.ends_with(".cmd") || shim.ends_with(".bat")) {
        return Some(vec![
            find_tool("cmd")?.to_string_lossy().into_owned(),
            "/c".to_string(),
            shim,
        ]);
    }
    Some(vec![shim])
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

/// A scratch directory that removes itself, so a failed assertion cannot leave
/// build artifacts behind.
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
