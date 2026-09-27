//! Debug Adapter Protocol message layer.
//!
//! DAP deliberately does **not** use JSON-RPC. The three message shapes are
//! distinct objects tagged by `type`, and the payload names differ from
//! JSON-RPC's too — so nothing from [`crate::lsp::rpc`] can be reused here:
//!
//! ```text
//! request  { "seq": 1, "type": "request",  "command": "launch", "arguments": {…} }
//! response { "seq": 2, "type": "response", "request_seq": 1, "success": true,
//!            "command": "launch", "body": {…} }
//! event    { "seq": 3, "type": "event",    "event": "stopped",  "body": {…} }
//! ```
//!
//! The wire framing is in [`crate::framing`]; this module only turns decoded
//! JSON into [`Incoming`] and builds the shapes we send. Classification never
//! fails: an unrecognised message degrades to [`Incoming::Invalid`] so one
//! malformed message can never take the session (or the IDE) down.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

/// A decoded message received from a debug adapter.
#[derive(Debug, Clone)]
pub enum Incoming {
    /// The answer to a request we sent. `body` is the adapter's payload; the
    /// human-readable failure text is already folded into `message`.
    Response {
        request_seq: u64,
        success: bool,
        command: String,
        message: String,
        body: Value,
    },
    /// A request *from* the adapter that expects an answer.
    Request {
        seq: u64,
        command: String,
        arguments: Value,
    },
    /// A one-way notification from the adapter.
    Event { event: String, body: Value },
    /// Not a DAP message; log and keep going.
    Invalid,
}

/// Split a decoded message into one of the [`Incoming`] variants.
pub fn classify(msg: &Value) -> Incoming {
    let Some(obj) = msg.as_object() else {
        return Incoming::Invalid;
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("request") => {
            let Some(seq) = obj.get("seq").and_then(Value::as_u64) else {
                return Incoming::Invalid;
            };
            let Some(command) = obj.get("command").and_then(Value::as_str) else {
                return Incoming::Invalid;
            };
            Incoming::Request {
                seq,
                command: command.to_string(),
                arguments: obj.get("arguments").cloned().unwrap_or(Value::Null),
            }
        }
        Some("response") => {
            let Some(request_seq) = obj.get("request_seq").and_then(Value::as_u64) else {
                return Incoming::Invalid;
            };
            // `success` is required by the spec. Adapters that omit it in the
            // success case are tolerated; a missing `message` simply reads as
            // an empty failure text.
            let success = obj
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            Incoming::Response {
                request_seq,
                success,
                command: obj
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                message: obj
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                body: obj.get("body").cloned().unwrap_or(Value::Null),
            }
        }
        Some("event") => {
            let Some(event) = obj.get("event").and_then(Value::as_str) else {
                return Incoming::Invalid;
            };
            Incoming::Event {
                event: event.to_string(),
                body: obj.get("body").cloned().unwrap_or(Value::Null),
            }
        }
        _ => Incoming::Invalid,
    }
}

/// Monotonic `seq` allocator. DAP requires every message we send to carry a
/// sequence number, and responses to reverse requests must quote the request's
/// `seq` in `request_seq`.
#[derive(Debug)]
pub struct SeqCounter {
    next: AtomicU64,
}

impl SeqCounter {
    pub fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
        }
    }

    pub fn alloc(&self) -> u64 {
        self.next.fetch_add(1, Ordering::SeqCst)
    }
}

impl Default for SeqCounter {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a request envelope. Note `arguments`, not `params`.
pub fn build_request(seq: u64, command: &str, arguments: &Value) -> Value {
    json!({
        "seq": seq,
        "type": "request",
        "command": command,
        "arguments": arguments,
    })
}

/// Build a response envelope. `message` is only meaningful for failures, and is
/// omitted when empty so a successful reply stays exactly spec-shaped.
pub fn build_response(
    seq: u64,
    request_seq: u64,
    command: &str,
    success: bool,
    message: &str,
    body: &Value,
) -> Value {
    let mut value = json!({
        "seq": seq,
        "type": "response",
        "request_seq": request_seq,
        "success": success,
        "command": command,
    });
    if !message.is_empty() {
        value["message"] = Value::String(message.to_string());
    }
    if !body.is_null() {
        value["body"] = body.clone();
    }
    value
}

/// The reply body for a request the adapter sent us. Returns
/// `(success, message, body)`.
///
/// Phase 1 implements no reverse requests, and that is a deliberate answer
/// rather than a silence: an adapter blocked on `runInTerminal` would hang the
/// whole session, so every command is refused explicitly and the adapter can
/// fall back (e.g. to its own `program` launch).
pub fn reply_for_adapter_request(command: &str, arguments: &Value) -> (bool, String, Value) {
    let message = match command {
        "runInTerminal" => match arguments.get("program").and_then(Value::as_str) {
            // Quote what was dropped: the usual cause of a silent no-launch is a
            // `launch.json` whose adapter insists on a terminal.
            Some(program) => format!(
                "runInTerminal is not supported; launch {program} through the launch configuration instead"
            ),
            None => "runInTerminal is not supported; launch the program through the launch configuration"
                .to_string(),
        },
        "startDebugging" => "composite debug sessions are not supported".to_string(),
        other => return (false, format!("unsupported request: {other}"), Value::Null),
    };
    (false, message, Value::Null)
}

/// Human-readable text for a failed response, preferring the adapter's own
/// `message` and falling back to the body so nothing surfaces as "error".
pub fn failure_text(command: &str, message: &str, body: &Value) -> String {
    if !message.is_empty() {
        return format!("{command}: {message}");
    }
    if body.is_null() {
        return format!("{command} failed");
    }
    format!("{command} failed: {body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_a_request_with_arguments() {
        match classify(&json!({
            "seq": 4, "type": "request", "command": "runInTerminal",
            "arguments": {"cwd": "/tmp"}
        })) {
            Incoming::Request { seq, command, arguments } => {
                assert_eq!(seq, 4);
                assert_eq!(command, "runInTerminal");
                assert_eq!(arguments["cwd"], "/tmp");
            }
            _ => panic!("expected request"),
        }
    }

    #[test]
    fn classifies_a_successful_response() {
        match classify(&json!({
            "seq": 9, "type": "response", "request_seq": 4, "success": true,
            "command": "initialize", "body": {"capabilities": {}}
        })) {
            Incoming::Response {
                request_seq,
                success,
                command,
                message,
                body,
            } => {
                assert_eq!(request_seq, 4);
                assert!(success);
                assert_eq!(command, "initialize");
                assert_eq!(message, "");
                assert!(body["capabilities"].is_object());
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn classifies_a_failed_response() {
        match classify(&json!({
            "seq": 9, "type": "response", "request_seq": 4, "success": false,
            "command": "launch", "message": "executable not found"
        })) {
            Incoming::Response { success, message, .. } => {
                assert!(!success);
                assert_eq!(message, "executable not found");
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn classifies_an_event_with_body() {
        match classify(&json!({
            "seq": 2, "type": "event", "event": "stopped",
            "body": {"reason": "breakpoint", "threadId": 1, "line": 7}
        })) {
            Incoming::Event { event, body } => {
                assert_eq!(event, "stopped");
                assert_eq!(body["threadId"], 1);
                assert_eq!(body["line"], 7);
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn unknown_events_classify_as_events_not_as_invalid() {
        // "excludedEvent"/"loadedSource"/"anythingNew" must not disturb the
        // session: an event is an event, whatever its name.
        match classify(&json!({"seq": 3, "type": "event", "event": "brandNewEvent"})) {
            Incoming::Event { event, body } => {
                assert_eq!(event, "brandNewEvent");
                assert!(body.is_null());
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn malformed_messages_never_panic() {
        for msg in [
            json!(null),
            json!([]),
            json!({}),
            json!(42),
            json!({"type": "event"}),
            json!({"type": "request"}),
            json!({"type": "request", "command": "x"}),
            json!({"type": "response", "command": "x"}),
            json!({"type": "nonsense", "method": "launch"}),
        ] {
            assert!(matches!(classify(&msg), Incoming::Invalid), "invalid: {msg}");
        }
    }

    #[test]
    fn json_rpc_shapes_are_not_mistaken_for_dap_messages() {
        // A JSON-RPC message reaching the DAP reader must be ignored, not
        // misread as a request (it has `method`, not `command`).
        assert!(matches!(
            classify(&json!({"jsonrpc": "2.0", "id": 1, "method": "launch", "params": {}})),
            Incoming::Invalid
        ));
    }

    #[test]
    fn seq_numbers_are_monotonic() {
        let seq = SeqCounter::new();
        let a = seq.alloc();
        let b = seq.alloc();
        let c = seq.alloc();
        assert_eq!(a, 1);
        assert!(a < b && b < c);
    }

    #[test]
    fn builds_a_request_with_arguments_not_params() {
        let msg = build_request(1, "launch", &json!({"program": "/tmp/a"}));
        assert_eq!(msg["seq"], 1);
        assert_eq!(msg["type"], "request");
        assert_eq!(msg["command"], "launch");
        assert_eq!(msg["arguments"]["program"], "/tmp/a");
        assert!(msg.get("params").is_none());
    }

    #[test]
    fn builds_a_response_that_quotes_request_seq() {
        let msg = build_response(2, 1, "initialize", true, "", &json!({}));
        assert_eq!(msg["seq"], 2);
        assert_eq!(msg["type"], "response");
        assert_eq!(msg["request_seq"], 1);
        assert_eq!(msg["success"], true);
        assert!(msg.get("message").is_none());
    }

    #[test]
    fn failed_response_carries_a_message() {
        let msg = build_response(3, 2, "launch", false, "nope", &Value::Null);
        assert_eq!(msg["success"], false);
        assert_eq!(msg["message"], "nope");
    }

    #[test]
    fn builds_an_event() {
        let msg = json!({"seq": 4, "type": "event", "event": "stopped", "body": {"threadId": 2}});
        // The wire shape an adapter sends, asserted here so the reader's
        // expectations stay pinned.
        assert!(matches!(classify(&msg), Incoming::Event { .. }));
    }

    #[test]
    fn run_in_terminal_is_refused_explicitly() {
        // Silence here would hang the adapter, so it must be a real reply.
        let (success, message, _) = reply_for_adapter_request("runInTerminal", &json!({}));
        assert!(!success);
        assert!(message.contains("runInTerminal"));
    }

    #[test]
    fn run_in_terminal_refusal_names_the_dropped_program() {
        let (_, message, _) = reply_for_adapter_request(
            "runInTerminal",
            &json!({"program": "/tmp/a.out", "cwd": "/tmp"}),
        );
        assert!(message.contains("/tmp/a.out"), "{message}");
    }

    #[test]
    fn unknown_adapter_requests_are_refused() {
        let (success, message, body) = reply_for_adapter_request("somethingNew", &json!({}));
        assert!(!success);
        assert!(message.contains("somethingNew"));
        assert!(body.is_null());
    }

    #[test]
    fn failure_text_prefers_the_adapter_message() {
        assert_eq!(
            failure_text("launch", "no such file", &Value::Null),
            "launch: no such file"
        );
        assert_eq!(
            failure_text("launch", "", &json!({"code": 12})),
            "launch failed: {\"code\":12}"
        );
        assert_eq!(failure_text("thread", "", &Value::Null), "thread failed");
    }
}
