//! One LSP server session: the child process, its stdio transport, request/
//! response correlation and lifecycle.
//!
//! A session belongs to the IDE runtime (not to any React component). It is
//! created lazily when the first Rust file opens and stays alive until the
//! workspace switches or the app exits. `LspSession` is kept behind an `Arc`
//! in `AppState` so long-running requests never block the UI thread.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::lsp::rpc::{
    build_notification, build_request, build_response, classify_message, reply_for_server_request,
    Incoming,
};
use crate::lsp::transport::{frame_message, write_message, FrameDecoder, TransportError};

/// How long we wait for any LSP request before declaring it timed out.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `shutdown` may wait for the server before force-killing it.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// How long we wait for the server to actually exit after `exit` is sent.
const EXIT_GRACE: Duration = Duration::from_millis(500);
/// Bounded cap so the decoder buffer cannot grow without limit.
const MAX_BUFFERED_READ: usize = 16 * 1024 * 1024;

/// A pending client request waiting for its response.
struct PendingEntry {
    tx: mpsc::Sender<Result<Value, String>>,
}

/// Correlates request ids with waiting callers.
struct PendingRequests {
    inner: Mutex<HashMap<u64, PendingEntry>>,
}

impl PendingRequests {
    fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, id: u64, tx: mpsc::Sender<Result<Value, String>>) {
        self.inner.lock().unwrap().insert(id, PendingEntry { tx });
    }

    fn take(&self, id: u64) -> Option<PendingEntry> {
        self.inner.lock().unwrap().remove(&id)
    }

    /// Fail every in-flight request (server exited / stream broke).
    fn fail_all(&self, message: &str) {
        let entries = std::mem::take(&mut *self.inner.lock().unwrap());
        for (_id, entry) in entries {
            let _ = entry.tx.send(Err(message.to_string()));
        }
    }
}

/// Monotonic request-id allocator, factored out for airtight testing.
struct RequestIds {
    inner: AtomicU64,
}

impl RequestIds {
    fn new() -> Self {
        Self {
            inner: AtomicU64::new(1),
        }
    }

    fn alloc(&self) -> u64 {
        self.inner.fetch_add(1, Ordering::SeqCst)
    }
}

/// The payload emitted to the frontend for `textDocument/publishDiagnostics`.
///
/// `language` is the client-side language id ("rust" / "cpp" / "typescript")
/// so the frontend can route the diagnostics; `uri` is the LSP document URI as
/// sent by the server; `path` is the same file normalized into the
/// forward-slash path key the model store uses.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnosticsEvent {
    pub language: String,
    pub uri: String,
    pub path: String,
    pub diagnostics: Vec<Value>,
}

/// A live connection to a language server over stdio.
pub struct LspSession {
    pub app: AppHandle,
    /// Client-side language id this session serves ("rust" / "cpp" / ...).
    pub language: String,
    /// Human-readable server name, used in log/toast messages.
    pub label: String,
    /// Root folder sent to the server at initialize time.
    pub root_uri: String,
    /// The `capabilities` object from the server's `initialize` result, kept so
    /// the frontend can gate providers on what the server actually supports.
    capabilities: Mutex<Value>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    next_id: RequestIds,
    pending: Arc<PendingRequests>,
    running: AtomicBool,
}

impl LspSession {
    /// Spawn the server process, run the standard `initialize` / `initialized`
    /// handshake and return a ready session.
    ///
    /// `language` is the client-side language id; `command` is the argv of the
    /// server executable; `root_uri` is the workspace/project root already
    /// resolved by the caller.
    pub fn start(
        app: AppHandle,
        language: &str,
        command: &[String],
        root_uri: String,
        process_id: u32,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Never pop a console window for the server.
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|err| format!("无法启动 {}: {err}", command[0]))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法取得服务器 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法取得服务器 stdout".to_string())?;
        let stderr = child.stderr.take();

        let label = command
            .first()
            .map(|c| c.rsplit(['/', '\\']).next().unwrap_or(c).to_string())
            .unwrap_or_else(|| language.to_string());

        if let Some(stderr) = stderr {
            let log_label = label.clone();
            std::thread::spawn(move || drain_stderr(log_label, stderr));
        }

        let session = Arc::new(Self {
            app,
            language: language.to_string(),
            label,
            root_uri,
            capabilities: Mutex::new(Value::Null),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            next_id: RequestIds::new(),
            pending: Arc::new(PendingRequests::new()),
            running: AtomicBool::new(true),
        });

        std::thread::spawn({
            let session = Arc::clone(&session);
            move || reader_loop(session, stdout)
        });

        let initialize_result = session
            .request(
                "initialize",
                crate::lsp::initialize_params(&session.root_uri, process_id),
            )
            .map_err(|err| format!("LSP initialize 失败: {err}"))?;
        if let Some(capabilities) = initialize_result.get("capabilities") {
            if let Ok(mut guard) = session.capabilities.lock() {
                *guard = capabilities.clone();
            }
        }
        session.notify("initialized", Value::Null)?;

        Ok(session)
    }

    /// Whether the process is believed to be alive.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// The root URI configured at initialize time.
    pub fn root_uri(&self) -> &str {
        &self.root_uri
    }

    /// The server capabilities from the `initialize` result (or `null` before
    /// the handshake completed).
    pub fn capabilities(&self) -> Value {
        self.capabilities
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(Value::Null)
    }

    /// Fire a request and wait for its reply (10s timeout). Safe to call
    /// concurrently: every call gets a unique id.
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_timeout(method, params, REQUEST_TIMEOUT)
    }

    /// Send a one-way notification.
    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        if !self.is_running() {
            return Err("LSP 服务未运行".to_string());
        }
        self.write(&build_notification(method, &params))
    }

    /// Graceful stop: `shutdown`, `exit`, a short grace period, then a forced
    /// kill of anything still alive so no orphan survives on Windows.
    pub fn shutdown(&self) {
        let _ = self.request_timeout("shutdown", Value::Null, SHUTDOWN_TIMEOUT);
        // Mark the session as stopping *before* the exit write so the reader
        // thread's EOF is not reported as an unexpected crash.
        self.running.store(false, Ordering::SeqCst);
        let _ = self.write(&build_notification("exit", &Value::Null));

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
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err("LSP 服务未运行".to_string());
        }
        let id = self.next_id.alloc();
        let (tx, rx) = mpsc::channel::<Result<Value, String>>();
        self.pending.insert(id, tx);
        let message = build_request(id, method, &params);

        if let Err(err) = self.write(&message) {
            self.mark_failed(&format!("无法写入服务器: {err}"));
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Drop the entry so a late response is ignored and cannot
                // leak the map.
                self.pending.take(id);
                Err(format!("LSP 请求 {method} 超时"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("LSP 服务已退出".to_string()),
        }
    }

    /// Mark the session dead and fail every pending request. Only emits the
    /// `lsp-exited` event when the process was still considered alive, so an
    /// intentional `shutdown()` (workspace switch / last file closed) does not
    /// surface a spurious "server exited" toast.
    fn mark_failed(&self, message: &str) {
        let was_running = self.running.swap(false, Ordering::SeqCst);
        self.pending.fail_all(message);
        if was_running {
            let _ = self.app.emit(
                "lsp-exited",
                serde_json::json!({ "language": self.language, "message": message }),
            );
        }
    }

    /// Reap the child if it has already exited; `true` when it is gone.
    fn try_reap(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
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
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Serialize one JSON value into a framed message and write it to the
    /// server. All writers share this single entry point so frames never
    /// interleave.
    fn write(&self, message: &Value) -> Result<(), String> {
        let payload =
            serde_json::to_vec(message).map_err(|err| format!("JSON 序列化失败: {err}"))?;
        let framed = frame_message(&payload);
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "服务器 stdin 已损坏".to_string())?;
        write_message(&mut *stdin, &framed).map_err(|err| err.to_string())
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        self.force_kill();
    }
}

/// Read server stdout, decode frames and dispatch messages until EOF.
fn reader_loop(session: Arc<LspSession>, stdout: ChildStdout) {
    let mut reader = StreamReader::new(stdout);
    loop {
        match reader.next_message() {
            Ok(Some(msg)) => {
                if let Err(err) = handle_incoming(&session, &msg) {
                    eprintln!("failed to handle server message: {err}");
                }
            }
            Ok(None) => {
                session.mark_failed(&format!("{} 已退出", session.label));
                return;
            }
            Err(TransportError::UnexpectedEof) => {
                session.mark_failed(&format!("{} 进程已退出 (stdout 中断)", session.label));
                return;
            }
            Err(err) => {
                // A malformed frame or a broken stream is fatal: resyncing is
                // not worth the complexity for one external server. Never loop
                // forever on a poisoned stream.
                session.mark_failed(&format!("{} 输出异常: {err}", session.label));
                return;
            }
        }
    }
}

/// Byte-accurate reader: drains `ChildStdout` into the frame decoder and
/// yields parsed JSON-RPC messages.
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
                    Err(e) => Err(TransportError::InvalidJson(e.to_string())),
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

/// Drain server stderr into the log so a chatty server cannot block on a full
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

/// Extract the human-readable message from a JSON-RPC error object.
fn format_json_rpc_error(err: &Value) -> String {
    match err {
        Value::Object(obj) => obj
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知 LSP 错误")
            .to_string(),
        _ => format!("LSP 错误 {err}"),
    }
}

/// Resolve a response: correlate it with the pending request and forward the
/// result (or error) to the caller.
fn on_pending_result(pending: &PendingRequests, id: u64, result: Result<Value, Value>) {
    if let Some(entry) = pending.take(id) {
        let _ = entry
            .tx
            .send(result.map_err(|err| format_json_rpc_error(&err)));
    }
}

/// Route one decoded message to the right handler.
fn handle_incoming(session: &LspSession, msg: &Value) -> Result<(), String> {
    match classify_message(msg) {
        Incoming::Response { id, result } => {
            on_pending_result(&session.pending, id, result);
            Ok(())
        }
        Incoming::Notification { method, params } => {
            handle_notification(session, &method, &params);
            Ok(())
        }
        Incoming::Request { id, method, params } => {
            let (is_error, body) = reply_for_server_request(&method, &params);
            let reply = build_response(&id, is_error, &body);
            let _ = session.write(&reply);
            Ok(())
        }
        Incoming::Invalid => Ok(()),
    }
}

/// Dispatch server notifications. Unknown notifications are ignored: the JSON
/// was already decoded, so the reader never crashes on them.
fn handle_notification(session: &LspSession, method: &str, params: &Value) {
    match method {
        "textDocument/publishDiagnostics" => {
            let uri = params
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let path =
                crate::lsp::uri::file_uri_to_path(&uri).unwrap_or_else(|| uri.clone());
            let diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let _ = session.app.emit(
                "lsp-diagnostics",
                LspDiagnosticsEvent {
                    language: session.language.clone(),
                    uri,
                    path,
                    diagnostics,
                },
            );
        }
        "window/logMessage" | "window/showMessage" => {
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !message.is_empty() {
                eprintln!("[{}] {message}", session.label);
            }
        }
        // `$/progress` and `telemetry/event` are intentionally ignored through
        // the fallback arm (no crash, no action).
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_ids_are_monotonic() {
        let ids = RequestIds::new();
        let a = ids.alloc();
        let b = ids.alloc();
        let c = ids.alloc();
        assert!(a < b && b < c);
        assert_eq!(a, 1);
    }

    #[test]
    fn pending_requests_correlate_responses() {
        let pending = PendingRequests::new();
        let (tx, rx) = mpsc::channel();
        pending.insert(10, tx.clone());

        // A response for an unknown id is dropped without panicking and the
        // known entry stays untouched.
        on_pending_result(&pending, 99, Ok(json!({})));
        assert!(pending.take(10).is_some());

        pending.insert(10, tx);
        on_pending_result(&pending, 10, Ok(json!({"ok": true})));
        assert!(pending.take(10).is_none());
        assert_eq!(rx.recv().unwrap().unwrap(), json!({"ok": true}));
    }

    #[test]
    fn pending_requests_forward_error_responses() {
        let pending = PendingRequests::new();
        let (tx, rx) = mpsc::channel();
        pending.insert(5, tx);
        on_pending_result(
            &pending,
            5,
            Err(json!({"code": -32602, "message": "bad params"})),
        );
        assert_eq!(rx.recv().unwrap().unwrap_err(), "bad params");
        assert!(pending.take(5).is_none());
    }

    #[test]
    fn pending_requests_are_failed_en_bloc_on_exit() {
        let pending = PendingRequests::new();
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        pending.insert(1, tx1);
        pending.insert(2, tx2);
        pending.fail_all("server died");
        assert!(pending.take(1).is_none());
        assert!(pending.take(2).is_none());
        assert_eq!(rx1.recv().unwrap().unwrap_err(), "server died");
        assert_eq!(rx2.recv().unwrap().unwrap_err(), "server died");
    }

    #[test]
    fn unknown_notification_is_classified_without_side_effects() {
        let msg = json!({"jsonrpc":"2.0","method":"foo/unknown","params":{"x":1}});
        match classify_message(&msg) {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "foo/unknown");
                assert_eq!(params["x"], 1);
            }
            _ => panic!("expected notification"),
        }
    }
}