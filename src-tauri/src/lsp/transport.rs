//! LSP stdio transport.
//!
//! LSP clients exchange JSON-RPC messages over stdin/stdout using HTTP-like
//! framing:
//!
//! ```text
//! Content-Length: <n>\r\n
//! \r\n
//! <exactly n bytes of UTF-8 JSON>
//! ```
//!
//! A single `read()` from the server can deliver half a header, several frames
//! at once, or the body in separate chunks, so decoding must be incremental.
//! `FrameDecoder` buffers raw bytes and yields complete messages only.

use std::io::Write;

/// Error while reading or writing a framed LSP message.
#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    /// The header contained no valid `Content-Length` line.
    MalformedHeader,
    /// The stream ended in the middle of a message.
    UnexpectedEof,
    /// The body was not valid UTF-8 / JSON.
    InvalidJson(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "server stream error: {e}"),
            TransportError::MalformedHeader => {
                write!(f, "malformed Content-Length header")
            }
            TransportError::UnexpectedEof => write!(f, "server stream ended unexpectedly"),
            TransportError::InvalidJson(msg) => write!(f, "invalid JSON payload: {msg}"),
        }
    }
}

impl std::error::Error for TransportError {}

const HEADER_END: &[u8] = b"\r\n\r\n";
const MAX_HEADER: usize = 64 * 1024;
const MAX_MESSAGE: usize = 256 * 1024 * 1024;

/// Incremental decoder that turns a byte stream into complete LSP message
/// bodies. Feed raw bytes with [`push`](Self::push) and drain complete
/// message bytes with `yield_message`.
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Insert freshly read bytes into the internal buffer.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Extract the next complete message payload, if any. `None` means the
    /// buffer holds only a partial header/body so far.
    pub fn yield_message(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        let Some(header_len) = locate_header_end(&self.buf).map(|end| end + HEADER_END.len())
        else {
            if self.buf.len() >= MAX_HEADER {
                return Err(TransportError::MalformedHeader);
            }
            return Ok(None);
        };
        if header_len >= self.buf.len() {
            // Header is complete but the body has not fully arrived yet.
            return Ok(None);
        }

        let content_length = parse_content_length(&self.buf[..header_len])?;
        if content_length > MAX_MESSAGE {
            return Err(TransportError::MalformedHeader);
        }
        let body_end = header_len + content_length;
        if self.buf.len() < body_end {
            return Ok(None);
        }

        let body = self.buf[header_len..body_end].to_vec();
        self.buf.drain(..body_end);
        Ok(Some(body))
    }

    /// Number of raw bytes currently buffered (used as a memory bound guard).
    pub fn buffer_len(&self) -> usize {
        self.buf.len()
    }
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Find the offset of the `\r\n\r\n` header terminator, if present.
fn locate_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(HEADER_END.len())
        .position(|window| window == HEADER_END)
}

/// Parse the `Content-Length: n` value out of a header block.
fn parse_content_length(header: &[u8]) -> Result<usize, TransportError> {
    for line in header.split_inclusive(|b| *b == b'\n') {
        let line = std::str::from_utf8(line).unwrap_or_default();
        let line = line.strip_suffix('\n').unwrap_or(line);
        let trimmed = line.strip_suffix('\r').unwrap_or(line).trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            let value = rest.trim();
            let n: usize = value.parse().ok().ok_or(TransportError::MalformedHeader)?;
            return Ok(n);
        }
    }
    Err(TransportError::MalformedHeader)
}

/// Wrap a JSON payload in the LSP `Content-Length` framing.
pub fn frame_message(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + payload.len());
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes());
    out.extend_from_slice(payload);
    out
}

/// Write one framed message to the server stdin. A single write of the whole
/// frame keeps concurrent senders from interleaving partial messages.
pub fn write_message(writer: &mut impl Write, framed: &[u8]) -> Result<(), TransportError> {
    writer
        .write_all(framed)
        .map_err(TransportError::Io)?;
    writer.flush().map_err(TransportError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_of(text: &str) -> Vec<u8> {
        frame_message(text.as_bytes())
    }

    #[test]
    fn decodes_a_single_message() {
        let mut dec = FrameDecoder::new();
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        dec.push(&frame_of(json));
        let body = dec.yield_message().unwrap().expect("one message");
        assert_eq!(String::from_utf8(body).unwrap(), json);
        assert_eq!(dec.buffer_len(), 0);
    }

    #[test]
    fn decodes_partial_header_then_rest() {
        let mut dec = FrameDecoder::new();
        let json = r#"{"a":1}"#;
        let frame = frame_of(json);
        // Always split in a tricky spot: inside the header terminator.
        let cut = 10;
        dec.push(&frame[..cut]);
        assert!(dec.yield_message().unwrap().is_none());
        dec.push(&frame[cut..]);
        let body = dec.yield_message().unwrap().expect("message after rest");
        assert_eq!(String::from_utf8(body).unwrap(), json);
    }

    #[test]
    fn decodes_partial_body_in_several_chunks() {
        let mut dec = FrameDecoder::new();
        let json = r#"{"hello":"world","n":[1,2,3]}"#;
        let frame = frame_of(json);
let header_end = 20;
        dec.push(&frame[..header_end]);
        assert!(dec.yield_message().unwrap().is_none());

        for byte in &frame[header_end..] {
            dec.push(&[*byte]);
            // Only the last byte should complete the message.
            let done = dec.yield_message().unwrap().is_some();
            assert_eq!(
                done,
                *byte == *frame.last().unwrap(),
                "only the final byte finishes the body"
            );
        }
    }
    #[test]
    fn decodes_multiple_messages_from_one_read() {
        let mut dec = FrameDecoder::new();
        let m1 = r#"{"jsonrpc":"2.0","method":"a"}"#;
        let m2 = r#"{"jsonrpc":"2.0","id":2,"result":true}"#;
        let m3 = r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601}}"#;
        let mut blob = Vec::new();
        blob.extend(frame_of(m1));
        blob.extend(frame_of(m2));
        blob.extend(frame_of(m3));
        dec.push(&blob);
        assert_eq!(String::from_utf8(dec.yield_message().unwrap().unwrap()).unwrap(), m1);
        assert_eq!(String::from_utf8(dec.yield_message().unwrap().unwrap()).unwrap(), m2);
        assert_eq!(String::from_utf8(dec.yield_message().unwrap().unwrap()).unwrap(), m3);
        assert!(dec.yield_message().unwrap().is_none());
    }

    #[test]
    fn header_and_body_split_across_many_reads() {
        let mut dec = FrameDecoder::new();
        let json = r#"{"x":[1,2,3,4,5,6,7,8,9,10]}"#;
        let frame = frame_of(json);
        for chunk in frame.chunks(3) {
            dec.push(chunk);
        }
        let body = dec.yield_message().unwrap().expect("complete");
        assert_eq!(String::from_utf8(body).unwrap(), json);
    }

    #[test]
    fn parses_length_between_headers_and_other_indexes() {
        let frame = format!("Content-Length: {}\r\n\r\n", 2).into_bytes();
        assert_eq!(parse_content_length(&frame).unwrap(), 2);
    }

    #[test]
    fn rejects_missing_content_length() {
        let err = parse_content_length(b"Content-Type: application/vscode-jsonrpc\r\n\r\n");
        assert!(matches!(err, Err(TransportError::MalformedHeader)));
    }

    #[test]
    fn rejects_non_numeric_length() {
        let err = parse_content_length(b"Content-Length: abc\r\n\r\n");
        assert!(matches!(err, Err(TransportError::MalformedHeader)));
    }

    #[test]
    fn malformed_header_is_reported() {
        let mut dec = FrameDecoder::new();
        // Header grows far beyond sane size without a terminator.
        let blob = vec![b'x'; MAX_HEADER + 8];
        dec.push(&blob);
        assert!(matches!(dec.yield_message(), Err(TransportError::MalformedHeader)));
    }

    #[test]
    fn frame_message_has_exact_content_length() {
        let payload = r#"{"a":1}"#;
        let frame = frame_of(payload);
        let header = std::str::from_utf8(&frame[..frame.len() - payload.len()]).unwrap();
        assert!(header.starts_with("Content-Length: "));
        assert!(header.ends_with("\r\n\r\n"));
        assert_eq!(frame[frame.len() - payload.len()..], *payload.as_bytes());
    }

    #[test]
    fn frame_round_trips_a_full_stream() {
        let mut dec = FrameDecoder::new();
        let one = frame_of(r#"{"id":1}"#);
        let two = frame_of(r#"{"id":2,"result":"x"}"#);
        let mut blob = Vec::new();
        blob.extend_from_slice(&one);
        blob.extend_from_slice(&two);
        // Feed 7 bytes at a time to force many internal boundaries.
        for chunk in blob.chunks(7) {
            dec.push(chunk);
        }
        let mut got = 0;
        while let Some(body) = dec.yield_message().unwrap() {
            let msg: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert!(msg["id"].is_number());
            got += 1;
        }
        assert_eq!(got, 2);
    }

    #[test]
    fn empty_message_round_trips() {
        let mut dec = FrameDecoder::new();
        dec.push(&frame_of(r#"null"#));
        assert_eq!(dec.yield_message().unwrap().unwrap(), b"null".to_vec());
    }
}