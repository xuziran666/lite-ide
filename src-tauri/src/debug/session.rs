//! One debug adapter session: the child process, its stdio transport, DAP
//! request/response correlation and lifecycle.
//!
//! A session belongs to the IDE runtime, not to any React component. It is
//! created by `debug_start` and lives until `debug_stop`, the workspace changes,
//! the app exits, or the adapter dies on its own. `DebugSession` is kept behind
//! an `Arc` in `AppState` so a blocking request never blocks the UI thread.
//!
//! The event sink is an `Option<AppHandle>`: production passes the app handle
//! and every DAP event is forwarded to the frontend as a `debug-event`; the
//! integration test passes `None` and drives the protocol directly. That keeps
//! the integration test free of a Tauri test harness.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::debug::transport::{
    build_request, build_response, classify, failure_text, reply_for_adapter_request, Incoming,
    SeqCounter,
};
use crate::framing::{frame_message, write_message, FrameDecoder, TransportError};

/// Default budget for a DAP request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to give the adapter to announce itself ready before configuring it
/// anyway.
///
/// The DAP startup sequence is ordered: a conformant adapter sends `initialized`
/// right after the `initialize` response and only then accepts configuration
/// (`setBreakpoints`, …). But not every adapter does — the `lldb-dap` build in
/// this repo's own end-to-end test never sends it at all. So rather than fail a
/// perfectly good session, we wait briefly: a well-behaved adapter wins the race
/// (the event arrives within microseconds of the response we just read), and one
/// that stays silent is configured anyway instead of blocking startup forever.
const INITIALIZED_GRACE: Duration = Duration::from_millis(500);
/// How often the `initialized` wait re-checks whether the adapter died, so a
/// dead adapter fails fast instead of waiting out the full timeout.
const POLL_INTERVAL: Duration = Duration::from_millis(25);
/// `launch` / `attach` can legitimately take a while (a large binary, a slow
/// toolchain), so they get their own, much larger budget.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
/// How long `disconnect` may wait before the process is killed outright.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// How long we wait for the adapter to exit after a successful `disconnect`.
const EXIT_GRACE: Duration = Duration::from_millis(300);
/// Bounded cap so the decoder buffer cannot grow without limit.
const MAX_BUFFERED_READ: usize = 16 * 1024 * 1024;

/// One DAP event forwarded to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct DebugEvent {
    /// The DAP event name (`initialized`, `stopped`, `continued`, ...).
    pub event: String,
    /// The raw `body`, forwarded verbatim so the frontend can add support for a
    /// new event without a backend change.
    pub body: Value,
}

/// A pending request waiting for its response.
struct PendingEntry {
    tx: mpsc::Sender<Result<Value, String>>,
}

/// Correlates `request_seq` with waiting callers.
struct PendingRequests {
    inner: Mutex<HashMap<u64, PendingEntry>>,
}

impl PendingRequests {
    fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, seq: u64, tx: mpsc::Sender<Result<Value, String>>) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(seq, PendingEntry { tx });
    }

    fn take(&self, seq: u64) -> Option<PendingEntry> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&seq)
    }

    /// Fail every in-flight request (adapter exited / stream broke).
    fn fail_all(&self, message: &str) {
        let entries = {
            let mut guard = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::take(&mut *guard)
        };
        for (_seq, entry) in entries {
            let _ = entry.tx.send(Err(message.to_string()));
        }
    }
}

/// A live connection to a debug adapter over stdio.
pub struct DebugSession {
    /// `None` in tests: the session then runs the protocol without emitting.
    app: Option<AppHandle>,
    /// Human-readable adapter name, used in log and error messages.
    pub label: String,
    /// The language id this session was started for. Carried for the frontend's
    /// benefit only; nothing here branches on it.
    pub language: String,
    /// The `body.capabilities` object from the `initialize` response.
    capabilities: Mutex<Value>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    seq: SeqCounter,
    pending: Arc<PendingRequests>,
    running: AtomicBool,
    /// Set once the adapter reports `terminated`: the debuggee is gone and this
    /// session can never be reused, even though the adapter process may still be
    /// alive waiting for `disconnect`.
    finished: AtomicBool,
    /// Flipped by the reader thread when the adapter's `initialized` event
    /// arrives. `(Mutex<bool>, Condvar)` because the startup sequence runs on
    /// the calling thread and has to *block* until the event shows up.
    initialized: Arc<(Mutex<bool>, Condvar)>,
    /// The debuggee's terminal pty, held here only when there is no Tauri app
    /// (tests). In production it is registered in `AppState` so the normal
    /// `terminal_write` / `terminal_resize` / `terminal_kill` commands reach it.
    debug_terminal: Mutex<Option<crate::terminal::TerminalSession>>,
}

impl DebugSession {
    /// Spawn the adapter and run the `initialize` handshake.
    ///
    /// `adapter` is the argv of the adapter executable, already resolved from
    /// `debug.adapters.<languageId>` by the caller.
    pub fn start(
        app: Option<AppHandle>,
        language: &str,
        adapter: &[String],
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(&adapter[0]);
        cmd.args(&adapter[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Never pop a console window for the adapter.
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("无法启动 Debug Adapter {}: {err}", adapter[0]))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法取得 Debug Adapter stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法取得 Debug Adapter stdout".to_string())?;
        let stderr = child.stderr.take();

        let label = adapter[0]
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&adapter[0])
            .to_string();

        if let Some(stderr) = stderr {
            let log_label = label.clone();
            std::thread::spawn(move || drain_stderr(log_label, stderr));
        }

        let session = Arc::new(Self {
            app,
            language: language.to_string(),
            label,
            capabilities: Mutex::new(Value::Null),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            seq: SeqCounter::new(),
            pending: Arc::new(PendingRequests::new()),
            running: AtomicBool::new(true),
            finished: AtomicBool::new(false),
            initialized: Arc::new((Mutex::new(false), Condvar::new())),
            debug_terminal: Mutex::new(None),
        });

        std::thread::spawn({
            let session = Arc::clone(&session);
            move || reader_loop(session, stdout)
        });

        let initialize = session.request(
            "initialize",
            crate::debug::initialize_arguments(language),
        )?;
        if let Some(capabilities) = initialize.get("capabilities") {
            let mut guard = session
                .capabilities
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = capabilities.clone();
        }

        Ok(session)
    }

    /// Whether the adapter is believed to be alive.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Whether the debuggee has terminated. Once this is true the session is
    /// over and must not block a new one, no matter what the adapter process is
    /// still doing.
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    /// The adapter capabilities from the `initialize` response.
    pub fn capabilities(&self) -> Value {
        self.capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Run the adapter's `runInTerminal` program in a pty and return the DAP
    /// response body (`processId`).
    ///
    /// The program is lldb-dap's own launcher, not the debuggee directly: it
    /// starts the target on the pty and coordinates with the main adapter through
    /// a communication file. Giving it a real tty is what makes interactive
    /// stdin (`cin >> n`) work, which piped stdio cannot.
    fn run_in_terminal(&self, arguments: &Value) -> Result<Value, String> {
        let spec = crate::debug::parse_run_in_terminal(arguments)?;
        let id = crate::terminal::DEBUG_TERMINAL_ID;
        let sink: crate::terminal::OutputSink = if let Some(app) = self.app.clone() {
            Arc::new(move |data: Vec<u8>| {
                if data.is_empty() {
                    let _ = app.emit("debug-terminal-exit", json!({ "id": id }));
                } else {
                    let _ = app.emit("debug-terminal-output", json!({ "id": id, "data": data }));
                }
            })
        } else {
            // No Tauri app (tests): the program's output goes to stderr so a
            // headless run still shows it.
            Arc::new(|data: Vec<u8>| {
                if !data.is_empty() {
                    eprint!("{}", String::from_utf8_lossy(&data));
                }
            })
        };

        let terminal = crate::terminal::TerminalSession::spawn_program(
            &spec.program,
            &spec.args,
            spec.cwd,
            &spec.env,
            sink,
        )?;
        let pid = terminal.process_id().unwrap_or(0);

        if let Some(app) = self.app.as_ref() {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                state.set_terminal(id, terminal);
                state.set_debug_terminal(id);
            }
            let _ = app.emit("debug-terminal-opened", json!({ "id": id }));
        } else {
            let mut guard = self
                .debug_terminal
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = Some(terminal);
        }

        Ok(json!({ "processId": pid, "shellProcessId": pid }))
    }

    /// Wait briefly for the adapter's `initialized` event.
    ///
    /// Returns `true` when the event arrived (the normal, spec-conformant
    /// case) and `false` when the adapter stayed silent within the grace
    /// window, in which case startup continues anyway. A session that has
    /// already died returns `false` immediately so the failure surfaces at the
    /// first real request instead of after a pointless wait.
    pub fn await_initialized(&self) -> bool {
        let (lock, cvar) = &*self.initialized;
        let mut ready = lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let deadline = Instant::now() + INITIALIZED_GRACE;
        while !*ready {
            if !self.is_running() {
                return false;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, _timed_out) =
                match cvar.wait_timeout(ready, remaining.min(POLL_INTERVAL)) {
                    Ok(pair) => pair,
                    Err(poisoned) => poisoned.into_inner(),
                };
            ready = next;
        }
        true
    }

    /// Send a DAP request and wait for its response.
    pub fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let timeout = match command {
            "launch" | "attach" => LAUNCH_TIMEOUT,
            _ => REQUEST_TIMEOUT,
        };
        self.request_timeout(command, arguments, timeout)
    }

    /// Send a DAP request **without** waiting for its response.
    ///
    /// This exists for `launch`, and only because the protocol demands it: the
    /// response to `launch` is sent once the debuggee has been launched *and*
    /// stopped — which an adapter may legitimately defer until the client
    /// finishes configuring it (real `lldb-dap` does exactly that, so waiting
    /// would deadlock against the `configurationDone` that has not been sent
    /// yet). The state machine therefore follows the adapter's `initialized`,
    /// `process`, `stopped` and `terminated` events instead.
    ///
    /// No pending entry is registered, so the eventual response is unclaimed: a
    /// late answer is ignored, and a late *failure* is logged (adapters also
    /// report launch problems as `output` events, which reach the frontend).
    pub fn send_request(&self, command: &str, arguments: Value) -> Result<(), String> {
        if !self.is_running() {
            return Err("Debug session 未运行".to_string());
        }
        let message = build_request(self.seq.alloc(), command, &arguments);
        if let Err(err) = self.write(&message) {
            self.mark_failed(&format!("无法写入 Debug Adapter: {err}"));
            return Err(err);
        }
        Ok(())
    }

    /// Graceful stop: `disconnect` (terminating the debuggee), a short grace
    /// period, then a forced kill so no orphan survives on Windows.
    pub fn shutdown(&self) {
        // The `disconnect` response is deliberately ignored: an adapter that is
        // already wedged must not block IDE shutdown.
        let _ = self.request_timeout(
            "disconnect",
            json!({ "restart": false, "terminateDebuggee": true }),
            SHUTDOWN_TIMEOUT,
        );
        // Mark the session as stopping *before* anything else, so the reader
        // thread's EOF is not reported as an unexpected crash.
        self.running.store(false, Ordering::SeqCst);
        self.pending.fail_all("Debug session 已停止");

        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline {
            if self.try_reap() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.force_kill();
    }

    fn request_timeout(
        &self,
        command: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err("Debug session 未运行".to_string());
        }
        let seq = self.seq.alloc();
        let (tx, rx) = mpsc::channel::<Result<Value, String>>();
        self.pending.insert(seq, tx);
        let message = build_request(seq, command, &arguments);

        if let Err(err) = self.write(&message) {
            self.mark_failed(&format!("无法写入 Debug Adapter: {err}"));
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Drop the entry so a late response is ignored and cannot leak
                // the map.
                self.pending.take(seq);
                Err(format!("Debug 请求 {command} 超时"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Debug Adapter 已退出".to_string())
            }
        }
    }

    /// Mark the session dead and fail every pending request. `debug-exited` is
    /// only emitted when the process was still considered alive, so an
    /// intentional `shutdown()` never produces a spurious error toast.
    fn mark_failed(&self, message: &str) {
        let was_running = self.running.swap(false, Ordering::SeqCst);
        self.pending.fail_all(message);
        if was_running {
            self.emit_exit(message);
        }
    }

    /// Reap the child if it has already exited; `true` when it is gone.
    fn try_reap(&self) -> bool {
        let mut guard = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    guard.take();
                    true
                }
                Ok(None) => false,
                Err(_) => {
                    guard.take();
                    true
                }
            },
            None => true,
        }
    }

    /// Take the child and kill it, waiting for it to actually die so no orphan
    /// remains on Windows.
    fn force_kill(&self) {
        let child = self
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

/// Serialize one JSON value into a framed message and write it to the
/// adapter. All writers share this entry point so frames never interleave.
fn write(&self, message: &Value) -> Result<(), String> {
    let payload =
        serde_json::to_vec(message).map_err(|err| format!("JSON 序列化失败: {err}"))?;

        let framed = frame_message(&payload);
        let mut guard = self
            .stdin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(stdin) = guard.as_mut() else {
            return Err("Debug Adapter stdin 已关闭".to_string());
        };
        write_message(stdin, &framed).map_err(|err| err.to_string())
    }

    /// Forward one DAP event to the frontend. A dead event channel is not an
    /// error: the session keeps running and the next event will try again.
    fn emit_event(&self, event: String, body: Value) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        let _ = app.emit("debug-event", DebugEvent { event, body });
    }

    fn emit_exit(&self, message: &str) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        let _ = app.emit("debug-exited", json!({ "message": message }));
    }
}

impl Drop for DebugSession {
    fn drop(&mut self) {
        self.force_kill();
    }
}

/// Read adapter stdout, decode frames and dispatch messages until EOF.
fn reader_loop(session: Arc<DebugSession>, stdout: ChildStdout) {
    let mut reader = StreamReader::new(stdout);
    loop {
        match reader.next_message() {
            Ok(Some(msg)) => handle_incoming(&session, &msg),
            Ok(None) => {
                // Clean EOF: the adapter finished. It is a normal end unless we
                // were mid-shutdown, which `mark_failed` already accounted for.
                session.mark_failed(&format!("{} 已退出", session.label));
                release_session(&session);
                return;
            }
            Err(TransportError::UnexpectedEof) => {
                session.mark_failed(&format!("{} 进程已退出 (stdout 中断)", session.label));
                release_session(&session);
                return;
            }
            Err(err) => {
                // A malformed frame is fatal for this session: once
                // Content-Length is wrong there is no safe way to find the next
                // message boundary. Reporting it is enough — the IDE stays up.
                session.mark_failed(&format!("{} 输出异常: {err}", session.label));
                release_session(&session);
                return;
            }
        }
    }
}

/// Remove the session from `AppState`, but only if it is still the current one.
///
/// A finishing session must be able to clear its own slot so the next F5 is not
/// refused, while never clearing a session that started after it.
fn release_session(session: &Arc<DebugSession>) {
    if let Some(app) = session.app.as_ref() {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            state.clear_debug_if_same(session);
            // Close the debuggee's terminal pty too: the session is over, so
            // its stdin must not stay open (the printed output is retained by
            // the frontend's xterm).
            state.kill_debug_terminal();
        }
    }
}

/// Finalize a session whose debuggee terminated.
///
/// The adapter process (real `lldb-dap`) stays alive after `terminated`, waiting
/// for `disconnect`; if we simply waited for its exit, the session would remain
/// in `AppState` and the next `debug_start` would wrongly refuse with "already
/// running". So the session is marked finished and reaped here:
///
/// - `running` is cleared *first*, so the forced reap below (which the reader
///   sees as EOF) is not reported as an adapter crash by `mark_failed`;
/// - the slot is cleared only if it still holds this session;
/// - the adapter is killed directly. `shutdown()` is deliberately not used: it
///   waits for the `disconnect` response, and this runs on the very reader
///   thread that would have to read it.
fn finish_session(session: &Arc<DebugSession>) {
    session.running.store(false, Ordering::SeqCst);
    session.finished.store(true, Ordering::SeqCst);
    session.pending.fail_all("Debug session 已结束");
    release_session(session);
    session.force_kill();
}

/// Byte-accurate reader: drains `ChildStdout` into the frame decoder and yields
/// parsed JSON messages.
struct StreamReader {
    decoder: FrameDecoder,
    stdout: ChildStdout,
    eof: bool,
    buf: Vec<u8>,
}

impl StreamReader {
    fn new(stdout: ChildStdout) -> Self {
        Self {
            decoder: FrameDecoder::new(),
            stdout,
            eof: false,
            buf: Vec::new(),
        }
    }

    fn next_message(&mut self) -> Result<Option<Value>, TransportError> {
        loop {
            if let Some(body) = self.decoder.yield_message()? {
                return match serde_json::from_slice::<Value>(&body) {
                    Ok(value) => Ok(Some(value)),
                    Err(e) => {
                        // The frame length was honoured, so the stream is still
                        // in sync: one unparseable body must not end the session.
                        eprintln!("skipping unparseable DAP body: {e}");
                        continue;
                    }
                };
            }
            if self.eof {
                return Ok(None);
            }
            if self.buf.is_empty() {
                self.buf.resize(8192, 0);
            }
            let n = match self.stdout.read(&mut self.buf) {
                Ok(0) => 0,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    return Err(if e.kind() == std::io::ErrorKind::UnexpectedEof {
                        TransportError::UnexpectedEof
                    } else {
                        TransportError::Io(e)
                    });
                }
            };
            if n == 0 {
                self.eof = true;
                continue;
            }
            self.decoder.push(&self.buf[..n]);
            if self.decoder.buffer_len() > MAX_BUFFERED_READ {
                return Err(TransportError::MalformedHeader);
            }
        }
    }
}

/// Drain adapter stderr into the log so a chatty adapter cannot block on a full
/// stderr pipe.
fn drain_stderr(label: String, mut stderr: std::process::ChildStderr) {
    let mut buf = [0u8; 1024];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                if !text.trim().is_empty() {
                    eprintln!("[{label}] {text}");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Route one decoded message to the right handler.
fn handle_incoming(session: &Arc<DebugSession>, msg: &Value) {
    match classify(msg) {
        Incoming::Response {
            request_seq,
            success,
            command,
            message,
            body,
        } => match session.pending.take(request_seq) {
            Some(entry) => {
                let result = if success {
                    Ok(body)
                } else {
                    Err(failure_text(&command, &message, &body))
                };
                let _ = entry.tx.send(result);
            }
            // A response nobody waits for: the deferred `launch` reply of a
            // `send_request`, or a late answer after a timeout. A failure still
            // has to reach the log, otherwise the adapter's reason for refusing
            // the launch is lost.
            None => {
                if !success {
                    eprintln!(
                        "[debug] unclaimed response: {}",
                        failure_text(&command, &message, &body)
                    );
                }
            }
        },
        Incoming::Request {
            seq,
            command,
            arguments,
        } => {
            // `runInTerminal` is the one reverse request this client implements:
            // it is how the adapter asks us to run the debuggee in a terminal so
            // its stdin/stdout/stderr are the Debug Terminal's pty. Everything
            // else is still refused explicitly so a blocked adapter can fall back.
            let (success, message, body) = if command == "runInTerminal" {
                match session.run_in_terminal(&arguments) {
                    Ok(body) => (true, String::new(), body),
                    Err(err) => (false, err, Value::Null),
                }
            } else {
                reply_for_adapter_request(&command, &arguments)
            };
            let reply = build_response(session.seq.alloc(), seq, &command, success, &message, &body);
            let _ = session.write(&reply);
        }
        Incoming::Event { event, body } => {
            let terminated = event == "terminated";
            if event == "initialized" {
                let (lock, cvar) = &*session.initialized;
                *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
                cvar.notify_all();
            }
            session.emit_event(event, body);
            // `terminated` is the protocol's "this session is over" signal. The
            // adapter may still be alive, so the session finalizes itself here
            // instead of leaving `AppState` holding a session that blocks the
            // next start. `exited` is deliberately *not* used for this: a program
            // can exit while the adapter stays usable for a restart.
            if terminated {
                finish_session(session);
            }
        }
        Incoming::Invalid => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_requests_correlate_responses() {
        let pending = Arc::new(PendingRequests::new());
        let (tx, rx) = mpsc::channel();
        pending.insert(10, tx.clone());

        // A response for an unknown seq is dropped without panicking.
        handle_incoming(&fake_session(&pending), &json!({
            "seq": 1, "type": "response", "request_seq": 99, "success": true,
            "command": "launch"
        }));
        assert!(pending.take(10).is_some());

        pending.insert(10, tx);
        handle_incoming(&fake_session(&pending), &json!({
            "seq": 2, "type": "response", "request_seq": 10, "success": true,
            "command": "launch", "body": {"ok": true}
        }));
        assert!(pending.take(10).is_none());
        assert_eq!(rx.recv().unwrap().unwrap(), json!({"ok": true}));
    }

    #[test]
    fn failed_response_becomes_an_error_with_the_adapter_message() {
        let pending = Arc::new(PendingRequests::new());
        let (tx, rx) = mpsc::channel();
        pending.insert(5, tx);
        handle_incoming(&fake_session(&pending), &json!({
            "seq": 1, "type": "response", "request_seq": 5, "success": false,
            "command": "launch", "message": "no such file"
        }));
        assert_eq!(
            rx.recv().unwrap().unwrap_err(),
            "launch: no such file".to_string()
        );
        assert!(pending.take(5).is_none());
    }

    #[test]
    fn pending_requests_are_failed_en_bloc_when_the_adapter_dies() {
        let pending = Arc::new(PendingRequests::new());
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        pending.insert(1, tx1);
        pending.insert(2, tx2);
        pending.fail_all("adapter died");
        assert!(pending.take(1).is_none());
        assert!(pending.take(2).is_none());
        assert_eq!(rx1.recv().unwrap().unwrap_err(), "adapter died");
        assert_eq!(rx2.recv().unwrap().unwrap_err(), "adapter died");
    }

    #[test]
    fn events_and_garbage_never_touch_pending_requests() {
        let pending = Arc::new(PendingRequests::new());
        let (tx, rx) = mpsc::channel();
        pending.insert(1, tx);
        let session = fake_session(&pending);

        // Unknown event, reverse request, malformed shape and a JSON-RPC
        // message: all must be handled without panicking or consuming the
        // pending entry. (The reverse request tries to write to a stdin we do
        // not have, which is exactly the "no crash" case being asserted.)
        for msg in [
            json!({"seq": 1, "type": "event", "event": "brandNewEvent"}),
            json!({"seq": 2, "type": "request", "command": "runInTerminal", "arguments": {}}),
            json!({"seq": 3}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "launch"}),
            json!(null),
        ] {
            handle_incoming(&session, &msg);
        }
        assert!(pending.take(1).is_some());
        assert!(rx.try_recv().is_err());
    }

    /// A session shell with no process attached, used to exercise message
    /// routing without spawning anything.
    fn fake_session(pending: &Arc<PendingRequests>) -> Arc<DebugSession> {
        Arc::new(DebugSession {
            app: None,
            label: "fake".to_string(),
            language: "test".to_string(),
            capabilities: Mutex::new(Value::Null),
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            seq: SeqCounter::new(),
            pending: Arc::clone(pending),
            running: AtomicBool::new(true),
            finished: AtomicBool::new(false),
            initialized: Arc::new((Mutex::new(false), Condvar::new())),
            debug_terminal: Mutex::new(None),
        })
    }

    #[test]
    fn terminated_marks_the_session_finished_and_unusable() {
        let pending = Arc::new(PendingRequests::new());
        let session = fake_session(&pending);
        assert!(session.is_running() && !session.is_finished());

        handle_incoming(
            &session,
            &json!({"seq": 1, "type": "event", "event": "terminated"}),
        );

        assert!(session.is_finished(), "terminated must finish the session");
        assert!(
            !session.is_running(),
            "a finished session must not look running, or it blocks the next start"
        );
    }

    #[test]
    fn exited_alone_does_not_finish_the_session() {
        let pending = Arc::new(PendingRequests::new());
        let session = fake_session(&pending);
        handle_incoming(
            &session,
            &json!({"seq": 1, "type": "event", "event": "exited", "body": {"exitCode": 0}}),
        );
        assert!(
            !session.is_finished(),
            "exited is not the end of the session; the adapter may still be usable"
        );
        assert!(session.is_running());
    }
}
