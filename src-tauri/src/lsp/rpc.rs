//! Minimal JSON-RPC 2.0 helpers for the LSP client.
//!
//! The reader thread classifies every incoming message with
//! [`classify_message`] and handles it without ever crashing on an unknown
//! shape. Server->client requests that we do not implement get a `-32601`
//! (Method not found) reply instead of silence, so the server never waits on
//! us forever.

use serde_json::{json, Value};

/// A parsed incoming JSON-RPC message.
#[derive(Debug, Clone)]
pub enum Incoming {
    /// A response to one of our requests.
    Response { id: u64, result: Result<Value, Value> },
    /// A request from the server that expects a reply.
    Request { id: Value, method: String, params: Value },
    /// A one-way notification from the server.
    Notification { method: String, params: Value },
    /// Not valid JSON-RPC; log and keep going.
    Invalid,
}

/// Split an incoming message into one of the [`Incoming`] variants. Never
/// fails: malformed input degrades to [`Incoming::Invalid`].
pub fn classify_message(msg: &Value) -> Incoming {
    let Some(obj) = msg.as_object() else {
        return Incoming::Invalid;
    };

    let id = obj.get("id");
    let method = obj.get("method").and_then(Value::as_str);

    match (id, method) {
        (Some(id), Some(method)) => Incoming::Request {
            id: id.clone(),
            method: method.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        },
        (Some(id), None) => {
            let numeric_id = id.as_u64().unwrap_or(0);
            let result = if obj.contains_key("error") {
                Err(obj.get("error").cloned().unwrap_or(Value::Null))
            } else {
                Ok(obj.get("result").cloned().unwrap_or(Value::Null))
            };
            Incoming::Response {
                id: numeric_id,
                result,
            }
        }
        (None, Some(method)) => Incoming::Notification {
            method: method.to_string(),
            params: obj.get("params").cloned().unwrap_or(Value::Null),
        },
        (None, None) => Incoming::Invalid,
    }
}

/// Build the JSON-RPC reply we send back to a server-driven request.
/// Returns `(is_error, body_result_or_error)`.
pub fn reply_for_server_request(method: &str, params: &Value) -> (bool, Value) {
    match method {
        "window/workDoneProgress/create" => (false, json!({})),
        // Registration is a no-op for a build-in client.
        "client/registerCapability" => (false, Value::Null),
        "workspace/configuration" => {
            let items = params
                .get("items")
                .and_then(Value::as_array)
                .map(|items| std::iter::repeat_with(|| Value::Null).take(items.len()).collect())
                .unwrap_or_else(|| json!([]));
            (false, items)
        }
        // MVP: a show-message prompt has no interactive handler.
        "window/showMessageRequest" => (false, Value::Null),
        _ => (
            true,
            json!({"code": -32601, "message": format!("Method not found: {method}")}),
        ),
    }
}

/// Build a JSON-RPC request envelope for one of our outgoing requests.
pub fn build_request(id: u64, method: &str, params: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    })
}

/// Build a JSON-RPC notification envelope.
pub fn build_notification(method: &str, params: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    })
}

/// Build the response envelope sent to a server request.
pub fn build_response(id: &Value, is_error: bool, body: &Value) -> Value {
    if is_error {
        json!({"jsonrpc": "2.0", "id": id.clone(), "error": body})
    } else {
        json!({"jsonrpc": "2.0", "id": id.clone(), "result": body})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_response_with_result() {
        let msg = json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
        match classify_message(&msg) {
            Incoming::Response { id, result } => {
                assert_eq!(id, 7);
                assert!(result.is_ok());
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn classifies_response_with_error() {
        let msg = json!({"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad"}});
        match classify_message(&msg) {
            Incoming::Response { id, result } => {
                assert_eq!(id, 3);
                assert!(result.is_err());
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn classifies_server_request() {
        let msg = json!({"jsonrpc":"2.0","id":"abc","method":"workspace/configuration","params":{}});
        match classify_message(&msg) {
            Incoming::Request { method, .. } => assert_eq!(method, "workspace/configuration"),
            _ => panic!("expected request"),
        }
    }

    #[test]
    fn classifies_notification() {
        let msg =
            json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}});
        match classify_message(&msg) {
            Incoming::Notification { method, .. } => {
                assert_eq!(method, "textDocument/publishDiagnostics")
            }
            _ => panic!("expected notification"),
        }
    }

    #[test]
    fn malformed_messages_never_crash() {
        assert!(matches!(classify_message(&json!(null)), Incoming::Invalid));
        assert!(matches!(classify_message(&json!([])), Incoming::Invalid));
        assert!(matches!(classify_message(&json!({})), Incoming::Invalid));
        assert!(matches!(classify_message(&json!(42)), Incoming::Invalid));
    }

    #[test]
    fn request_ids_without_method_count_as_response() {
        // A message with an id but no method is a response even if the id is
        // a string; we only correlate numeric ids we generated.
        match classify_message(&json!({"jsonrpc":"2.0","id":"abc"})) {
            Incoming::Response { id, .. } => assert_eq!(id, 0),
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn work_done_progress_create_gets_empty_object() {
        let (err, body) = reply_for_server_request("window/workDoneProgress/create", &json!({}));
        assert!(!err);
        assert_eq!(body, json!({}));
    }

    #[test]
    fn register_capability_gets_null() {
        let (err, body) = reply_for_server_request("client/registerCapability", &json!({}));
        assert!(!err);
        assert_eq!(body, Value::Null);
    }

    #[test]
    fn workspace_configuration_matches_items_length() {
        let params = json!({"items":[{"section":"rust-analyzer"},{"section":"other"},{},{}]});
        let (err, body) = reply_for_server_request("workspace/configuration", &params);
        assert!(!err);
        assert_eq!(body.as_array().unwrap().len(), 4);
        assert!(body.as_array().unwrap().iter().all(|v| v.is_null()));
    }

    #[test]
    fn workspace_configuration_without_items_is_empty() {
        let (err, body) = reply_for_server_request("workspace/configuration", &json!({}));
        assert!(!err);
        assert_eq!(body, json!([]));
    }

    #[test]
    fn show_message_request_gets_null() {
        let (err, body) = reply_for_server_request("window/showMessageRequest", &json!({}));
        assert!(!err);
        assert_eq!(body, Value::Null);
    }

    #[test]
    fn unknown_method_gets_method_not_found() {
        let (err, body) = reply_for_server_request("some/unknown", &json!({}));
        assert!(err);
        assert_eq!(body["code"], -32601);
        assert!(body["message"].as_str().unwrap().contains("some/unknown"));
    }

    #[test]
    fn builds_request_and_notification_envelopes() {
        let req = build_request(11, "textDocument/hover", &json!({"uri":"u"}));
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["id"], 11);
        assert_eq!(req["method"], "textDocument/hover");
        assert_eq!(req["params"]["uri"], "u");

        let notif = build_notification("initialized", &Value::Null);
        assert!(notif.get("id").is_none());
        assert_eq!(notif["method"], "initialized");
    }

    #[test]
    fn builds_error_and_result_responses() {
        let reply =
            build_response(&json!(9), true, &json!({"code": -32601, "message": "x"}));
        assert_eq!(reply["id"], 9);
        assert!(reply.get("error").is_some());
        assert!(reply.get("result").is_none());

        let reply = build_response(&json!("w"), false, &json!({}));
        assert_eq!(reply["id"], "w");
        assert!(reply.get("result").is_some());
    }
}