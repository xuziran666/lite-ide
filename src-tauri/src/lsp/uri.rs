//! Filesystem path <-> LSP `file://` URI conversion.
//!
//! LSP URIs are RFC 3986 URIs. A Windows path like `E:\dev\demo\src\main.rs`
//! must become `file:///E:/dev/demo/src/main.rs`, never `file://E:\dev\...`.
//! Every byte outside the URI-safe set is percent-encoded, so spaces and
//! non-ASCII (Chinese, emoji) survive a round trip.

/// Percent-encode bytes not allowed verbatim in a URI path. Keeps `/` and `:`
/// (drive letter separator) as-is.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':'
            => {
                out.push(*byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", byte));
            }
        }
    }
    out
}

/// Convert a filesystem path into a `file://` URI string.
///
/// - `C:\dev\demo` (Windows)         -> `file:///C:/dev/demo`
/// - `\\server\share\proj` (UNC)     -> `file://server/share/proj`
/// - `/home/user/proj` (Unix)        -> `file:///home/user/proj`
pub fn path_to_file_uri(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy();
    let norm = raw.replace('\\', "/");

    // Windows extended-length (verbatim) prefix: `\\?\C:\...` ->
    // `//?/C:/...`, and `\\?\UNC\server\share` -> `//?/UNC/server/share`.
    // LSP servers (rust-analyzer) reject `?` in a URI authority, so strip it.
    let norm = if let Some(rest) = norm.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = norm.strip_prefix("//?/") {
        rest.to_string()
    } else {
        norm
    };

    // UNC: leading `//host/share/...` keeps the authority in place.
    if norm.starts_with("//") {
        let rest = norm.trim_start_matches('/');
        return format!("file://{}", percent_encode(rest));
    }
    // Absololute Unix path: authority stays empty, `file:///...`.
    if norm.starts_with('/') {
        return format!("file://{}", percent_encode(&norm));
    }
    // Windows drive (`C:/...`): `file:///C:/...`.
    format!("file:///{}", percent_encode(&norm))
}

/// Percent-decode a `file://` URI back into a forward-slash path usable by the
/// model store (which normalizes backslashes to `/`). Returns `None` for
/// anything that is not a `file://` URI.
pub fn file_uri_to_path(uri: &str) -> Option<String> {
    let after_scheme = uri.strip_prefix("file://")?;
    let (unc, rest) = if after_scheme.starts_with('/') {
        (false, after_scheme)
    } else {
        // `file://server/share` -> UNC `//server/share`.
        (true, after_scheme)
    };

    let mut decoded = Vec::new();
    let mut it = rest.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let hi = it.next()?;
            let lo = it.next()?;
            let hex = format!("{}{}", hi as char, lo as char);
            let value = u8::from_str_radix(&hex, 16).ok()?;
            decoded.push(value);
        } else {
            decoded.push(b);
        }
    }
    let text = String::from_utf8(decoded).ok()?;
    if unc {
        // Reject drive-less authority, keep the `//` prefix for the host.
        if !text.starts_with('/') && !text.is_empty() {
            return Some(format!("//{text}"));
        }
        return Some(text);
    }
    // Strip a single leading `/` only when it introduces a drive letter
    // (`/C:/x` -> `C:/x`) so platform paths match the model store keys.
    if text.len() >= 3 && text.as_bytes()[0] == b'/' && text.as_bytes()[1].is_ascii_alphabetic() && text.as_bytes()[2] == b':' {
        return Some(text[1..].to_string());
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn windows_drive_path_becomes_file_uri() {
        assert_eq!(
            path_to_file_uri(Path::new(r"E:\dev\demo\src\main.rs")),
            "file:///E:/dev/demo/src/main.rs"
        );
    }

    #[test]
    fn windows_root_drive() {
        assert_eq!(path_to_file_uri(Path::new(r"E:\dev")), "file:///E:/dev");
    }

    #[test]
    fn unix_absolute_path() {
        assert_eq!(
            path_to_file_uri(Path::new("/home/user/proj/src/lib.rs")),
            "file:///home/user/proj/src/lib.rs"
        );
    }

    #[test]
    fn windows_unc_path() {
        assert_eq!(
            path_to_file_uri(Path::new(r"\\server\share\proj\x.rs")),
            "file://server/share/proj/x.rs"
        );
    }

    #[test]
    fn windows_verbatim_path_strips_extended_prefix() {
        assert_eq!(
            path_to_file_uri(Path::new(r"\\?\E:\Projects\official\lite-ide")),
            "file:///E:/Projects/official/lite-ide"
        );
        assert_eq!(
            path_to_file_uri(Path::new(r"\\?\E:\a b\c.rs")),
            "file:///E:/a%20b/c.rs"
        );
    }

    #[test]
    fn windows_verbatim_unc_path() {
        assert_eq!(
            path_to_file_uri(Path::new(r"\\?\UNC\server\share\proj\x.rs")),
            "file://server/share/proj/x.rs"
        );
    }

    #[test]
    fn path_with_spaces_is_percent_encoded() {
        assert_eq!(
            path_to_file_uri(Path::new(r"C:\My Documents\demo.rs")),
            "file:///C:/My%20Documents/demo.rs"
        );
    }

    #[test]
    fn chinese_path_is_percent_encoded() {
        assert_eq!(
            path_to_file_uri(Path::new(r"E:\项目\示例.rs")),
            "file:///E:/%E9%A1%B9%E7%9B%AE/%E7%A4%BA%E4%BE%8B.rs"
        );
    }

    #[test]
    fn special_characters_are_percent_encoded() {
        assert_eq!(
            path_to_file_uri(Path::new(r"C:\a#b?c%20 d.rs")),
            "file:///C:/a%23b%3Fc%2520%20d.rs"
        );
    }

    #[test]
    fn round_trip_windows_path() {
        let path = Path::new(r"E:\项目\demo folder\src\main.rs");
        let uri = path_to_file_uri(path);
        assert_eq!(file_uri_to_path(&uri).unwrap(), "E:/项目/demo folder/src/main.rs");
    }

    #[test]
    fn round_trip_unicode_uri_back_to_model_path() {
        let uri = "file:///E:/%E9%A1%B9%E7%9B%AE/%E7%A4%BA%E4%BE%8B.rs";
        assert_eq!(file_uri_to_path(uri).unwrap(), "E:/项目/示例.rs");
    }

    #[test]
    fn round_trip_unc_path() {
        let uri = path_to_file_uri(Path::new(r"\\server\share\a b\x.rs"));
        assert_eq!(uri, "file://server/share/a%20b/x.rs");
        assert_eq!(file_uri_to_path(&uri).unwrap(), "//server/share/a b/x.rs");
    }

    #[test]
    fn round_trip_unix_path() {
        let uri = path_to_file_uri(Path::new("/home/user/a b.rs"));
        assert_eq!(uri, "file:///home/user/a%20b.rs");
        assert_eq!(file_uri_to_path(&uri).unwrap(), "/home/user/a b.rs");
    }

    #[test]
    fn rejects_non_file_scheme() {
        assert_eq!(file_uri_to_path("untitled:foo"), None);
        assert_eq!(file_uri_to_path("https://x/y"), None);
    }

    #[test]
    fn handles_malformed_percent_sequence_as_none() {
        assert_eq!(file_uri_to_path("file:///C:/%GG"), None);
    }

    #[test]
    fn emoji_round_trips() {
        let path = Path::new(r"C:\emoji\😀.rs");
        let uri = path_to_file_uri(path);
        assert!(uri.contains("%F0%9F%98%80"));
        assert_eq!(file_uri_to_path(&uri).unwrap(), "C:/emoji/😀.rs");
    }
}