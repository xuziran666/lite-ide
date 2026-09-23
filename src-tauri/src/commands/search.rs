use std::fs;
use std::path::Path;

use regex::Regex;
use serde::Serialize;
use tauri::State;

use super::fs::{is_hidden_name, path_is_hidden};
use crate::state::AppState;

/// Cap a single content search so huge workspaces (node_modules included)
/// still return promptly instead of flooding the UI.
const MAX_TOTAL_MATCHES: usize = 2000;
/// Per-file match cap keeps one giant file from swamping the result list.
const MAX_MATCHES_PER_FILE: usize = 200;
/// Files larger than this are skipped by content search (treated as binary).
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;

fn no_workspace_error() -> String {
    "No workspace is open. Please open a folder first.".to_string()
}

/// Recursively walk the workspace collecting file paths, skipping hidden
/// directories. Symlinked directories are not followed, which both keeps the
/// walk inside the workspace and prevents cycles.
fn collect_files(workspace: &Path, dir: &Path, out: &mut Vec<String>, prefix: &str) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for item in read_dir {
        let Ok(item) = item else {
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if is_hidden_name(&name) {
            continue;
        }
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if file_type.is_dir() {
            collect_files(workspace, &item.path(), out, &rel);
        } else if file_type.is_file() {
            out.push(rel);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    /// Workspace-relative path, always using `/` separators.
    pub path: String,
    /// 1-based line number.
    pub line: u64,
    /// 1-based character column of the first match on the line.
    pub column: u64,
    /// The full line, trimmed of surrounding whitespace/newline.
    pub text: String,
}

/// All file paths in the workspace (relative, `/`-separated), for Quick Open.
#[tauri::command]
pub fn list_workspace_files(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    let mut files = Vec::new();
    collect_files(&workspace, &workspace, &mut files, "");
    files.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(files)
}

/// A compiled query: either a plain substring (with optional case sensitivity)
/// or a regular expression.
#[derive(Debug)]
enum Query {
    Plain { needle: String, case_sensitive: bool },
    Regex(Regex),
}

impl Query {
    fn new(text: &str, case_sensitive: bool, use_regex: bool) -> Result<Query, String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("搜索内容为空".to_string());
        }
        if use_regex {
            let source = if case_sensitive {
                text.clone()
            } else {
                format!("(?i){text}")
            };
            Regex::new(&source).map(Query::Regex).map_err(|e| {
                format!("正则表达式无效: {e}")
            })
        } else {
            Ok(Query::Plain {
                needle: if case_sensitive {
                    text
                } else {
                    text.to_lowercase()
                },
                case_sensitive,
            })
        }
    }

    fn find_column(&self, line: &str) -> Option<u64> {
        match self {
            Query::Plain {
                needle, case_sensitive,
            } => {
                if *case_sensitive {
                    let byte = line.find(needle)?;
                    Some(char_count(&line[..byte]) + 1)
                } else {
                    let lowered: String = line
                        .chars()
                        .map(|c| c.to_lowercase().collect::<String>())
                        .collect();
                    // Byte offsets of `lowered` may drift from the original for
                    // non-ASCII case folding; count chars up to the offset as a
                    // best-effort column (exact for ASCII input).
                    let byte = lowered.find(needle)?;
                    Some(
                        line.char_indices().take_while(|(i, _)| *i < byte).count() as u64 + 1,
                    )
                }
            }
            Query::Regex(re) => re
                .find_at(line, 0)
                .map(|m| char_count(&line[..m.start().min(line.len())]) + 1),
        }
    }
}

/// Number of Unicode scalar values up to the given byte offset.
fn char_count(text: &str) -> u64 {
    text.chars().count() as u64
}

/// Content search across the whole workspace. Results are workspace-relative
/// paths with `/` separators; every match locates a 1-based line/column.
#[tauri::command]
pub fn search_workspace(
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    let query = Query::new(&query, case_sensitive, use_regex)?;

    let mut files = Vec::new();
    collect_files(&workspace, &workspace, &mut files, "");
    files.sort();

    let mut matches = Vec::new();
    for rel in &files {
        if matches.len() >= MAX_TOTAL_MATCHES {
            break;
        }
        let path = workspace.join(rel);
        if path_is_hidden(&path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_SCAN_BYTES {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let file_matches = scan_file(rel, &text, &query);
        matches.extend(file_matches);
    }
    Ok(matches)
}

fn scan_file(rel: &str, content: &str, query: &Query) -> Vec<SearchMatch> {
    let mut out = Vec::new();
    for (idx, raw_line) in content.lines().enumerate() {
        if out.len() >= MAX_MATCHES_PER_FILE {
            break;
        }
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(column) = query.find_column(line) {
            out.push(SearchMatch {
                path: rel.to_string(),
                line: (idx + 1) as u64,
                column,
                text: line.to_string(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_workspace() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!(
            "lite_ide_search_{}_{}",
            std::process::id(),
            n
        ));
        fs::create_dir_all(base.join("src")).unwrap();
        fs::write(base.join("README.md"), "# hello world\nsearch me here\n").unwrap();
        fs::write(
            base.join("src").join("main.rs"),
            "fn main() {\n    Search::LOWER\n}\n",
        )
        .unwrap();
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::write(base.join(".git").join("config"), "should never be searched").unwrap();
        fs::create_dir_all(base.join("target").join("debug")).unwrap();
        fs::write(base.join("target").join("debug").join("out.txt"), "search hidden").unwrap();
        fs::create_dir(base.join("node_modules")).unwrap();
        fs::write(
            base.join("node_modules").join("pkg.js"),
            "// Search appears in node_modules\n",
        )
        .unwrap();
        fs::canonicalize(&base).unwrap()
    }

    #[test]
    fn lists_files_and_skips_hidden_dirs() {
        let ws = tmp_workspace();
        let mut files = Vec::new();
        collect_files(&ws, &ws, &mut files, "");
        files.sort();
        assert!(files.contains(&"README.md".to_string()));
        assert!(files.contains(&"src/main.rs".to_string()));
        assert!(files.contains(&"node_modules/pkg.js".to_string()));
        assert!(!files.iter().any(|f| f.starts_with(".git/")));
        assert!(!files.iter().any(|f| f.starts_with("target/")));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn path_is_hidden_detects_all_listed_dirs() {
        for hidden in [".git", "target", "dist", "build", ".cache"] {
            let p = Path::new(hidden).join("x/file.txt");
            assert!(path_is_hidden(&p), "{hidden} should be hidden");
        }
        assert!(!path_is_hidden(Path::new("src/main.rs")));
        // node_modules is explicitly not hidden.
        assert!(!path_is_hidden(Path::new("node_modules/pkg.js")));
    }

    #[test]
    fn plain_search_finds_matches_including_node_modules() {
        let ws = tmp_workspace();
        let mut files = Vec::new();
        collect_files(&ws, &ws, &mut files, "");
        files.sort();
        let mut found = Vec::new();
        for rel in &files {
            let path = ws.join(rel);
            let text = fs::read_to_string(&path).unwrap();
            found.extend(scan_file(rel, &text, &Query::Plain {
                needle: "search".to_string(),
                case_sensitive: false,
            }));
        }
        let paths: Vec<&str> = found.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(paths.contains(&"node_modules/pkg.js"));
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with("target")));
        // The main.rs hit is "Search::LOWER".
        let hit = found.iter().find(|m| m.path == "src/main.rs").unwrap();
        assert_eq!(hit.line, 2);
        assert_eq!(hit.text, "Search::LOWER");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn case_sensitive_flag_affects_matches() {
        let insensitive = Query::Plain {
            needle: "search".to_string(),
            case_sensitive: false,
        };
        assert!(insensitive.find_column("Search me").is_some());
        let sensitive = Query::Plain {
            needle: "search".to_string(),
            case_sensitive: true,
        };
        assert!(sensitive.find_column("Search me").is_none());
        assert!(sensitive.find_column("search me").is_some());
    }

    #[test]
    fn regex_query_supports_case_insensitive_wrapping() {
        let q = Query::new("S[a-z]+rch", false, true).unwrap();
        let m = q.find_column("a SeaRch hit").unwrap();
        // 1-based column of the first matching char.
        assert_eq!(m, 3);
        let _ = Query::new("(", false, true).expect_err("invalid regex must fail");
    }

    #[test]
    fn query_rejects_empty_and_whitespace() {
        assert!(Query::new("", false, false).is_err());
        assert!(Query::new("   ", true, false).is_err());
    }
}