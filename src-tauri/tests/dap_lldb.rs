//! End-to-end test against a **real** debug adapter.
//!
//! Everything else in the debug client is unit tested against hand-written
//! JSON, which proves the code parses what we *think* adapters send. This test
//! closes that gap: it compiles a C++ program, hands it to a real `lldb-dap`,
//! and checks the whole chain against a real adapter — spawn, the `initialize`
//! handshake, breakpoint installation, `launch`, a stop at the breakpoint, and
//! `stackTrace` / `scopes` / `variables` on the resulting frame.
//!
//! It is skipped, not failed, when the tools are absent, so the suite still
//! runs on a machine without a C++ toolchain. `cargo test` on a developer box
//! (or in CI with `lldb-dap` installed) runs it for real.
//!
//! Two behaviours of real adapters shape this test, both verified against
//! `lldb-dap` and neither obvious from the spec:
//!
//! 1. The `launch` response is deferred until the debuggee first stops, and the
//!    debuggee does not even start until the client sends `configurationDone`.
//!    Waiting for the `launch` response before configuring therefore deadlocks.
//! 2. Breakpoints are reported `verified: false` when the process does not exist
//!    yet; the adapter resolves them later (asynchronously) and says so with a
//!    `breakpoint` event.
//!
//! So the test sends `launch` without waiting, then configures, then polls the
//! adapter's own answers to prove the breakpoint binds. No language-specific
//! code lives in the test either: the compiler and the adapter are both looked
//! up on `PATH`, and the only C++ specifics are the fixture program and its
//! breakpoint line.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use lite_ide_lib::debug::session::DebugSession;

/// The fixture. Line 5 is the breakpoint; the sleep afterwards keeps the process
/// alive so a *missed* breakpoint shows up as a clear failure instead of a
/// silent "the program already exited".
const FIXTURE: &str = r#"
#include <chrono>
#include <cstdio>
#include <thread>

int compute(int x) { return x * 2 + 1; }

int main() {
    int value = compute(20);
    std::printf("value=%d\n", value);
    std::this_thread::sleep_for(std::chrono::seconds(30));
    return 0;
}
"#;

/// 1-based line of `return x * 2 + 1;` inside `compute` (the fixture starts
/// with a newline, so the includes occupy lines 2–4 and `compute` is line 6).
const BREAKPOINT_LINE: u64 = 6;

#[test]
fn launches_a_cpp_program_and_stops_at_a_breakpoint() {
    let Some(compiler) = find_tool("g++").or_else(|| find_tool("clang++")) else {
        eprintln!("skipping DAP end-to-end test: no g++/clang++ on PATH");
        return;
    };
    let Some(adapter) = find_tool("lldb-dap") else {
        eprintln!("skipping DAP end-to-end test: lldb-dap not on PATH");
        return;
    };

    let dir = TempDir::new("lite-ide-dap");
    let source = dir.path().join("main.cpp");
    let binary = dir.path().join(if cfg!(windows) { "app.exe" } else { "app" });
    fs::write(&source, FIXTURE).expect("write fixture");

    // `-g` is mandatory: without debug info the adapter cannot map an address
    // back to a source line, and the stack trace would be meaningless.
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

    // `app: None` — no Tauri runtime is needed; this drives the protocol
    // directly through the same `DebugSession` the app uses.
    let session = DebugSession::start(None, "cpp", &[adapter.to_string_lossy().into_owned()])
        .unwrap_or_else(|err| panic!("adapter {adapter:?} failed to start: {err}"));

    session
        .request("setExceptionBreakpoints", json!({ "filters": [] }))
        .expect("setExceptionBreakpoints");

    // Fire and forget: waiting for the `launch` response would deadlock against
    // the `configurationDone` the adapter is waiting for.
    session
        .send_request(
            "launch",
            json!({
                "program": binary.to_string_lossy(),
                "cwd": dir.path().to_string_lossy(),
                "stopOnEntry": true,
                "noDebug": false,
            }),
        )
        .expect("send launch");

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
        set["breakpoints"][0]["line"], BREAKPOINT_LINE,
        "adapter did not echo the breakpoint line: {set}"
    );
    assert_eq!(
        set["breakpoints"][0]["source"]["path"],
        source.to_string_lossy().as_ref(),
        "adapter did not echo the source path: {set}"
    );

    session
        .request("configurationDone", Value::Null)
        .expect("configurationDone");

    // The process now exists and is suspended at its entry point.
    let thread = wait_for(
        || {
            let thread = first_thread(&session).ok()?;
            top_frame(&session, thread).map(|_| thread)
        },
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| panic!("the debuggee never reached its entry stop"));

    session
        .request("continue", json!({ "threadId": thread }))
        .expect("continue");

    // Proof the breakpoint works, taken from the adapter itself: the thread is
    // suspended with the breakpoint line on top of the stack. A missed
    // breakpoint instead leaves a *running* thread, which this adapter refuses
    // to trace, so the poll keeps retrying and finally reports the failure.
    let (frame_id, line) = wait_for(
        || top_frame(&session, thread),
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| {
        panic!("the program never stopped at breakpoint line {BREAKPOINT_LINE}")
    });
    assert_eq!(line, BREAKPOINT_LINE as i64, "stopped at the wrong line");

    // Scopes/variables must work on a real frame: this is exactly what the
    // Variables panel asks for.
    let scopes = session
        .request("scopes", json!({ "frameId": frame_id }))
        .expect("scopes");
    assert!(
        scopes["scopes"]
            .as_array()
            .is_some_and(|s: &Vec<Value>| !s.is_empty()),
        "no scopes reported: {scopes}"
    );
    let locals = scopes["scopes"][0]["variablesReference"].as_i64();
    assert!(
        locals.is_some_and(|r| r > 0),
        "locals scope has no reference: {scopes}"
    );
    let variables = session
        .request("variables", json!({ "variablesReference": locals.unwrap() }))
        .expect("variables");
    let names: Vec<String> = variables["variables"]
        .as_array()
        .expect("variables array")
        .iter()
        .map(|v| v["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        names.iter().any(|n| n == "x"),
        "the frame's own argument is missing from {names:?}"
    );

    // One more round trip to prove the session is still healthy afterwards.
    session
        .request("next", json!({ "threadId": thread }))
        .expect("next");
}

/// A program that exits on its own, with no breakpoint to stop it. This is the
/// regression for "the debuggee already exited, but the next F5 is refused with
/// 'A debug session is already running'": after `terminated` the session must
/// finalize itself so a new one can start without an explicit Stop.
///
/// The adapter is real `lldb-dap`, which (unlike a naive expectation) stays alive
/// after the debuggee exits, waiting for `disconnect` — which is exactly why the
/// old code kept the session "running".
#[test]
fn an_exited_debuggee_finalizes_the_session_and_allows_a_restart() {
    let Some(compiler) = find_tool("g++").or_else(|| find_tool("clang++")) else {
        eprintln!("skipping DAP lifecycle test: no g++/clang++ on PATH");
        return;
    };
    let Some(adapter) = find_tool("lldb-dap") else {
        eprintln!("skipping DAP lifecycle test: lldb-dap not on PATH");
        return;
    };

    let dir = TempDir::new("lite-ide-dap-lifecycle");
    let source = dir.path().join("bye.cpp");
    let binary = dir.path().join(if cfg!(windows) { "bye.exe" } else { "bye" });
    fs::write(
        &source,
        "#include <cstdio>\nint main() { std::printf(\"bye\\n\"); return 0; }\n",
    )
    .expect("write fixture");
    let output = Command::new(&compiler)
        .args(["-g", "-O0", "-std=c++17"])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .output()
        .unwrap_or_else(|err| panic!("failed to run {compiler:?}: {err}"));
    assert!(
        output.status.success(),
        "compiling the lifecycle fixture failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let first = DebugSession::start(None, "cpp", &[adapter.to_string_lossy().into_owned()])
        .expect("start lldb-dap");
    first
        .request("setExceptionBreakpoints", json!({ "filters": [] }))
        .expect("setExceptionBreakpoints");
    first
        .send_request(
            "launch",
            json!({
                "program": binary.to_string_lossy(),
                "cwd": dir.path().to_string_lossy(),
                "stopOnEntry": false,
                "noDebug": false,
            }),
        )
        .expect("send launch");
    first.await_initialized();
    first
        .request("configurationDone", Value::Null)
        .expect("configurationDone");

    let finalized = wait_for(
        || if first.is_finished() { Some(()) } else { None },
        Duration::from_secs(30),
    );
    assert!(
        finalized.is_some(),
        "the session never finalized after its debuggee exited"
    );
    assert!(
        !first.is_running(),
        "a finished session must not report itself as running"
    );

    // The next F5: a new session must start even though the finished one is
    // still held here (`debug_start` only refuses a live, unfinished session).
    let second = DebugSession::start(None, "cpp", &[adapter.to_string_lossy().into_owned()])
        .expect("a finished session must not block a new one");
    assert!(second.is_running());
    second.shutdown();
}

/// With `console: "integratedTerminal"`, lldb-dap asks the client to run the
/// debuggee in a terminal via a `runInTerminal` reverse request — this is what
/// makes `stdin` interactive. The session here runs the launcher in a real pty
/// and answers the request; the test proves the adapter then proceeds, resolves
/// the breakpoint, and stops at it. (No Tauri app, so the pty is held by the
/// session and its output goes to stderr.)
#[test]
fn a_run_in_terminal_launch_stops_at_a_breakpoint() {
    let Some(compiler) = find_tool("g++").or_else(|| find_tool("clang++")) else {
        eprintln!("skipping DAP terminal test: no g++/clang++ on PATH");
        return;
    };
    let Some(adapter) = find_tool("lldb-dap") else {
        eprintln!("skipping DAP terminal test: lldb-dap not on PATH");
        return;
    };

    let dir = TempDir::new("lite-ide-dap-terminal");
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
        "compiling the terminal fixture failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let session = DebugSession::start(None, "cpp", &[adapter.to_string_lossy().into_owned()])
        .expect("start lldb-dap");
    session
        .request("setExceptionBreakpoints", json!({ "filters": [] }))
        .expect("setExceptionBreakpoints");
    session
        .send_request(
            "launch",
            json!({
                "program": binary.to_string_lossy(),
                "cwd": dir.path().to_string_lossy(),
                "stopOnEntry": false,
                "noDebug": false,
                "console": "integratedTerminal",
            }),
        )
        .expect("send launch");
    session.await_initialized();
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

    let thread = wait_for(
        || first_thread(&session).ok(),
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| panic!("no thread appeared for the runInTerminal launch"));
    let (_, line) = wait_for(
        || top_frame(&session, thread),
        Duration::from_secs(30),
    )
    .unwrap_or_else(|| panic!("the program never stopped at breakpoint line {BREAKPOINT_LINE}"));
    assert_eq!(line, BREAKPOINT_LINE as i64, "stopped at the wrong line");

    session.shutdown();
}

/// The first thread the adapter reports.
fn first_thread(session: &DebugSession) -> Result<i64, String> {
    let threads = session.request("threads", Value::Null)?;
    threads["threads"][0]["id"]
        .as_i64()
        .ok_or_else(|| format!("no threads reported: {threads}"))
}

/// The id and line of a suspended thread's topmost frame, or `None` while the
/// thread is running (adapters refuse to trace a running thread).
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

/// Poll `probe` until it yields a value or `timeout` elapses.
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

/// Look up an executable on `PATH`, mirroring how `Command` resolves one.
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
        // `process::id` plus a counter keeps parallel test binaries apart.
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
