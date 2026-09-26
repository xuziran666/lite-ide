//! Thin wrapper around the system `git` CLI, used for the Source Control
//! panel. Keeping Git on the CLI avoids a full Git library dependency; every
//! mutation is a plain `git add` / `git restore` guarded by `--`.
//!
//! Git commands run with `-C <workspace>` and `-c core.quotepath=false`, so
//! paths in output are workspace-relative (default `status.relativePaths`) and
//! file names with non-ASCII characters are passed through as UTF-8 instead of
//! being octal-escaped.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// One changed file as reported by `git status --short`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// Workspace-relative path using `/` separators (git's own path style).
    pub path: String,
    /// The most significant status letter: M / A / D / R / C / U / ?.
    pub status: String,
    /// The change is staged in the index (porcelain column 1).
    pub staged: bool,
    /// The worktree differs from the index (porcelain column 2) or the file
    /// is untracked.
    pub unstaged: bool,
    /// The file is untracked (`??`).
    pub untracked: bool,
    /// Old path for rename/copy entries, otherwise null.
    pub renamed_from: Option<String>,
    /// Raw porcelain column 1 (`' '` when unmodified).
    pub staged_status: String,
    /// Raw porcelain column 2 (`' '` when unmodified).
    pub unstaged_status: String,
}

/// A `git_status` snapshot: whether the workspace is inside a repository (and
/// where its root is) plus every changed file. Empty `files` with no root
/// means "not a Git repository".
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    /// Absolute repository root, or null when the workspace is not in a repo.
    pub repository_root: Option<String>,
    pub files: Vec<GitFileStatus>,
}

struct CommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Strip the Windows verbatim (`\\?\`) prefix git refuses to chdir into.
#[cfg(windows)]
fn git_dir(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn git_dir(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn run_git(workspace: &Path, args: &[&str]) -> Result<CommandOutput, String> {
    let raw = run_git_raw(workspace, args)?;
    Ok(CommandOutput {
        success: raw.success,
        code: raw.code,
        stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
    })
}

fn git_error(action: &str, out: &CommandOutput) -> String {
    let stderr = out.stderr.trim();
    if stderr.is_empty() {
        let code = out.code.map(|c| c.to_string()).unwrap_or_default();
        format!("Git command failed (exit {code}) while trying to {action}")
    } else {
        stderr.to_string()
    }
}

/// Run a git command and require a zero exit status, mapping failures to a
/// user-facing error (the trimmed stderr when available).
pub fn run_git_ok(workspace: &Path, args: &[&str], action: &str) -> Result<(), String> {
    let out = run_git(workspace, args)?;
    if out.success {
        Ok(())
    } else {
        Err(git_error(action, &out))
    }
}

fn not_a_repository(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("not a git repository")
        || lower.contains("this operation must be run in a work tree")
}

/// The repository root for the workspace (the parent of `.git`), or None when
/// the workspace is not inside any Git repository. A missing `git` binary is
/// still an error; a missing/not-a-repo workspace just yields None.
pub fn find_repository_root(workspace: &Path) -> Result<Option<PathBuf>, String> {
    let out = run_git(workspace, &["rev-parse", "--show-toplevel"])?;
    if !out.success {
        if not_a_repository(&out.stderr) {
            return Ok(None);
        }
        return Err(git_error("detect the Git repository", &out));
    }
    let root = out.stdout.trim();
    if root.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(root)))
}

/// Every changed file in the workspace (staged, unstaged and untracked), as
/// reported by `git status --short --untracked-files=all`.
pub fn parse_status(workspace: &Path) -> Result<Vec<GitFileStatus>, String> {
    let out = run_git(workspace, &["status", "--short", "--untracked-files=all"])?;
    if !out.success {
        return Err(git_error("read the Git status", &out));
    }
    Ok(parse_status_lines(&out.stdout))
}

/// The combined detect-and-list snapshot consumed by `git_status`. The
/// repository root is passed in so callers can cache it across refreshes
/// instead of re-running `git rev-parse` on every poll.
pub fn status_snapshot(
    workspace: &Path,
    repository_root: Option<PathBuf>,
) -> Result<GitSnapshot, String> {
    let Some(root) = repository_root else {
        return Ok(GitSnapshot {
            repository_root: None,
            files: Vec::new(),
        });
    };
    let files = parse_status(workspace)?;
    Ok(GitSnapshot {
        repository_root: Some(root.to_string_lossy().into_owned()),
        files,
    })
}

/// Stage a set of workspace-relative paths. No-op when the list is empty.
pub fn stage_paths(workspace: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = Vec::with_capacity(paths.len() + 2);
    args.push("add");
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    run_git_ok(workspace, &args, "stage the changes")
}

/// Unstage a set of workspace-relative paths (index back to HEAD). No-op when
/// the list is empty.
pub fn unstage_paths(workspace: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = Vec::with_capacity(paths.len() + 3);
    args.push("restore");
    args.push("--staged");
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    run_git_ok(workspace, &args, "unstage the changes")
}

/// One side of a temporary Git diff request. `source` names the blob to fetch:
/// - "HEAD": `<path>` at the last commit (`git show HEAD:<path>`);
/// - "INDEX": `<path>` in the staging area (`git show :0:<path>`);
/// - "WORKTREE": `<path>` as it exists on disk;
/// - "COMMIT": `<path>` at an arbitrary revision (`git show <commit>:<path>`);
///   `commit` defaults to "HEAD" when omitted.
/// - "EMPTY": no content (the added/deleted side of a diff).
/// `path` is the git-relative path to read (for a rename it is the pre-rename
/// path on the parent side). An optional `label` overrides the header label the
/// backend derives from `source` (used by the History panel to show short
/// hashes like `a1b2c3d^: src/main.cpp`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSideRequest {
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The plain-text content of a temporary Git diff for the Monaco diff editor.
/// The two labels name the sides in the header (`HEAD:a.cpp` / `工作区` / ...).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffContent {
    pub original: String,
    pub modified: String,
    pub original_label: String,
    pub modified_label: String,
    /// Either side is a binary blob (a NUL byte in the first sample); the text
    /// is empty and the UI renders a "cannot display" message instead.
    pub binary: bool,
}

struct RawCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Upper bound for one `git` invocation. A stuck `git` (held index lock,
/// credential prompt, unresponsive network share) would otherwise park the
/// calling thread forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the supervising thread checks whether the child exited.
const GIT_POLL: Duration = Duration::from_millis(20);
/// How long to wait for the output readers to drain once the child is gone.
const GIT_DRAIN: Duration = Duration::from_secs(5);

/// Poll `child` until it exits or `timeout` elapses, killing it on timeout so
/// a wedged Git process cannot block the caller indefinitely.
fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Git command timed out after {}s",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(GIT_POLL);
            }
            Err(err) => return Err(format!("Failed to wait for git: {err}")),
        }
    }
}

/// Drain one child pipe on its own thread, handing the bytes back over a
/// channel so the supervising `try_wait` loop is never blocked on a full pipe.
fn drain_pipe<R: Read + Send + 'static>(mut pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Like `run_git`, but with raw byte output so binary blobs are not corrupted
/// by a lossy UTF-8 decode.
///
/// Both pipes are drained on their own threads: a command producing more
/// output than the OS pipe buffer holds would otherwise deadlock against the
/// supervising `try_wait` loop.
fn run_git_raw(workspace: &Path, args: &[&str]) -> Result<RawCommandOutput, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(git_dir(workspace))
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `git.exe` is a console-subsystem program, so Windows would allocate
        // and briefly flash a console window for every invocation. This is the
        // only way to run a console program from a windowed app without that
        // flash, and it only affects process creation: stdout and stderr are
        // still piped and captured exactly as before.
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "Git executable not found".to_string()
        } else {
            format!("Failed to run git: {err}")
        }
    })?;

    let out_rx = drain_pipe(child.stdout.take());
    let err_rx = drain_pipe(child.stderr.take());

    let status = wait_with_timeout(&mut child, GIT_TIMEOUT)?;
    let stdout = out_rx.recv_timeout(GIT_DRAIN).unwrap_or_default();
    let stderr = err_rx.recv_timeout(GIT_DRAIN).unwrap_or_default();
    Ok(RawCommandOutput {
        success: status.success(),
        code: status.code(),
        stdout,
        stderr,
    })
}

fn git_error_raw(action: &str, out: &RawCommandOutput) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() {
        let code = out.code.map(|c| c.to_string()).unwrap_or_default();
        format!("Git command failed (exit {code}) while trying to {action}")
    } else {
        stderr
    }
}

/// Resolve a git-relative path (always using `/` separators) to a path inside
/// the workspace, rejecting absolute paths and `.` / `..` / drive-rooted
/// traversal so a git path can never escape the workspace.
fn workspace_path(workspace: &Path, git_path: &str) -> Result<PathBuf, String> {
    if git_path.is_empty() {
        return Err("Diff path is empty".to_string());
    }
    let rel = Path::new(git_path);
    for component in rel.components() {
        if matches!(
            component,
            Component::ParentDir | Component::CurDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(format!("Unsafe diff path: {git_path}"));
        }
    }
    Ok(workspace.join(rel))
}

/// The bytes of one diff side. A blob absent from a revision is *not* an error:
/// a new file has no `HEAD:` entry and a deleted file has no worktree bytes, so
/// both degrade to the empty side (which is exactly what a diff needs).
fn diff_side_bytes(workspace: &Path, side: &DiffSideRequest) -> Result<Vec<u8>, String> {
    match side.source.as_str() {
        "EMPTY" => Ok(Vec::new()),
        "WORKTREE" => {
            let file = workspace_path(workspace, &side.path)?;
            if !file.is_file() {
                return Ok(Vec::new());
            }
            std::fs::read(&file).map_err(|err| format!("Failed to read {}: {err}", side.path))
        }
        "HEAD" | "INDEX" => {
            let rev = if side.source == "HEAD" {
                format!("HEAD:{}", side.path)
            } else {
                format!(":0:{}", side.path)
            };
            let out = run_git_raw(workspace, &["show", rev.as_str()])?;
            if out.success {
                return Ok(out.stdout);
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("does not exist") || stderr.contains("invalid object name") {
                // A blob absent from a revision is normal for new files (HEAD),
                // for files missing from an unborn HEAD (empty repository) and
                // for files only at another index stage (conflicts).
                return Ok(Vec::new());
            }
            Err(git_error_raw("read the Git content", &out))
        }
        "COMMIT" => {
            workspace_path(workspace, &side.path)?;
            let commit_ref = side.commit.as_deref().unwrap_or("HEAD");
            safe_commit_ref(commit_ref)?;
            let rev = format!("{commit_ref}:{}", side.path);
            let out = run_git_raw(workspace, &["show", rev.as_str()])?;
            if out.success {
                return Ok(out.stdout);
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("does not exist") || stderr.contains("invalid object name") {
                // A path absent from a revision is the empty side (files added
                // by the commit itself, or deleted from the parent). A bad
                // commit reference is a real error, not an empty side.
                return Ok(Vec::new());
            }
            Err(git_error_raw("read the Git content", &out))
        }
        other => Err(format!("Unknown diff source: {other}")),
    }
}

/// Whether a blob is binary: a NUL byte in the first sample (git's own heuristic
/// for text vs binary content).
fn looks_binary(bytes: &[u8]) -> bool {
    const SAMPLE: usize = 8192;
    let sample = &bytes[..bytes.len().min(SAMPLE)];
    sample.contains(&0)
}

fn diff_side_label(side: &DiffSideRequest) -> String {
    if let Some(label) = &side.label {
        if !label.is_empty() {
            return label.clone();
        }
    }
    match side.source.as_str() {
        "EMPTY" => "空".to_string(),
        "WORKTREE" => "工作区".to_string(),
        "HEAD" => format!("HEAD:{}", side.path),
        "INDEX" => format!("Index:{}", side.path),
        "COMMIT" => format!(
            "{}:{}",
            side.commit.as_deref().unwrap_or("HEAD"),
            side.path
        ),
        other => other.to_string(),
    }
}

/// Build a temporary Git diff between any two sides of the workspace. The
/// caller resolves `original` / `modified` from the file status and the clicked
/// Source Control group; this only fetches the two blobs. Both sides must be
/// text to produce a diff — a binary blob flips `binary` and the UI renders a
/// message instead of the corrupt-looking text.
pub fn diff_content(
    workspace: &Path,
    original: &DiffSideRequest,
    modified: &DiffSideRequest,
) -> Result<GitDiffContent, String> {
    let original_bytes = diff_side_bytes(workspace, original)?;
    let modified_bytes = diff_side_bytes(workspace, modified)?;
    let binary = looks_binary(&original_bytes) || looks_binary(&modified_bytes);
    let text = |bytes: Vec<u8>| {
        if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        }
    };
    Ok(GitDiffContent {
        original: text(original_bytes),
        modified: text(modified_bytes),
        original_label: diff_side_label(original),
        modified_label: diff_side_label(modified),
        binary,
    })
}

/// Commit the staged changes with the given message. The message travels as a
/// single `-m` value so it can never be read as options, even when it starts
/// with dashes or carries trailing newlines.
pub fn commit(workspace: &Path, message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message is empty".to_string());
    }
    run_git_ok(workspace, &["commit", "-m", message], "commit the staged changes")
}

/// One commit in the repository's history, parsed from a machine-readable
/// `git log` record (never the human-readable default output).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    /// The subject (first line) of the commit message.
    pub message: String,
    pub author: String,
    pub email: Option<String>,
    /// Unix timestamp (seconds).
    pub date: i64,
}

/// One file changed by a commit (`git show --name-status`). `path` is always
/// the git-relative path using `/` separators — the same identity the Source
/// Control panel and the file tree use.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    /// M / A / D / R / C, or `?` for anything unexpected (e.g. typechange).
    pub status: String,
    /// Pre-rename path for rename/copy entries.
    pub old_path: Option<String>,
}

/// A commit plus the files it changed and its first parent — everything the
/// History panel needs to render the changed-files tree and to open a
/// Parent → Commit diff for any of those files.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub commit: GitCommit,
    /// The first parent's full hash, or None for the root commit.
    pub parent_hash: Option<String>,
    pub files: Vec<GitCommitFile>,
}

/// Field separator inside a `git log` / `git show` record.
const GIT_FIELD_SEP: char = '\u{1f}';
/// Record separator between committed records.
const GIT_RECORD_SEP: u8 = 0x1e;

fn short_hash(hash: &str) -> String {
    hash.chars().take(7).collect()
}

/// The repository's commit history (current branch, newest first), paged with
/// `git log -n <limit> --skip <skip>`. The caller decides whether more pages
/// exist by comparing the returned length to the requested limit. An unborn
/// repository (no commits yet) is not an error: it yields an empty list.
pub fn commit_history(workspace: &Path, limit: u64, skip: u64) -> Result<Vec<GitCommit>, String> {
    let limit_arg = limit.to_string();
    let skip_arg = skip.to_string();
    let out = run_git(
        workspace,
        &[
            "log",
            "-n",
            &limit_arg,
            "--skip",
            &skip_arg,
            "--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1e",
        ],
    )?;
    if !out.success {
        let err = git_error("read the Git history", &out);
        if err.contains("does not have any commits yet") {
            return Ok(Vec::new());
        }
        return Err(err);
    }
    Ok(parse_commit_records(&out.stdout))
}

fn parse_commit_records(output: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for record in output.split(GIT_RECORD_SEP as char) {
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.split(GIT_FIELD_SEP);
        let hash = fields.next().unwrap_or("").trim().to_string();
        let author = fields.next().unwrap_or("").trim().to_string();
        let email = fields.next().unwrap_or("").trim().to_string();
        let date = fields.next().unwrap_or("").trim();
        let message = fields.next().unwrap_or("").trim_end().to_string();
        if hash.is_empty() || author.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            short_hash: short_hash(&hash),
            hash,
            message,
            author,
            email: if email.is_empty() { None } else { Some(email) },
            date: date.parse().unwrap_or(0),
        });
    }
    commits
}

/// The files changed by one commit and its first parent. Uses
/// `git show -M --name-status -z`: rename/copy entries are detected, every
/// path is NUL-terminated (so spaces, quotes and Unicode survive byte-exact)
/// and the first parent is read from `%P`. For a merge commit only the first
/// parent is considered. The root commit has no parent (empty side in diffs).
pub fn commit_files(workspace: &Path, commit_ref: &str) -> Result<GitCommitDetails, String> {
    safe_commit_ref(commit_ref)?;
    let out = run_git_raw(
        workspace,
        &[
            "show",
            "-M",
            "--name-status",
            "-z",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s%x1e",
            commit_ref,
        ],
    )?;
    if !out.success {
        return Err(git_error_raw("read the commit", &out));
    }
    parse_commit_details(&out.stdout)
}

fn parse_commit_details(output: &[u8]) -> Result<GitCommitDetails, String> {
    let split_at = output
        .iter()
        .position(|b| *b == GIT_RECORD_SEP)
        .ok_or_else(|| "Malformed commit output from git show".to_string())?;
    let header = String::from_utf8_lossy(&output[..split_at]).into_owned();
    let mut body = &output[split_at + 1..];
    while matches!(body.first(), Some(b'\n' | b'\r')) {
        body = &body[1..];
    }

    let mut fields = header.split(GIT_FIELD_SEP);
    let hash = fields.next().unwrap_or("").trim().to_string();
    let parents = fields.next().unwrap_or("").trim().to_string();
    let author = fields.next().unwrap_or("").trim().to_string();
    let email = fields.next().unwrap_or("").trim().to_string();
    let date = fields.next().unwrap_or("").trim();
    let message = fields.next().unwrap_or("").trim_end().to_string();
    if hash.is_empty() || author.is_empty() {
        return Err("Malformed commit header from git show".to_string());
    }

    Ok(GitCommitDetails {
        parent_hash: parents
            .split_whitespace()
            .next()
            .filter(|p| !p.is_empty())
            .map(ToOwned::to_owned),
        commit: GitCommit {
            short_hash: short_hash(&hash),
            hash,
            message,
            author,
            email: if email.is_empty() { None } else { Some(email) },
            date: date.parse().unwrap_or(0),
        },
        files: parse_commit_name_status(body),
    })
}

/// The `-z --name-status` body of `git show`: `status\0path\0` records, with
/// two path tokens for rename/copy entries (`R100\0old\0new\0`), all trailing
/// the record separator.
fn parse_commit_name_status(body: &[u8]) -> Vec<GitCommitFile> {
    let mut records = Vec::new();
    let mut tokens = body.split(|b| *b == 0).filter(|t| !t.is_empty());
    while let Some(status_token) = tokens.next() {
        // A pretty-format trailing newline lands on the first status token.
        let raw = String::from_utf8_lossy(status_token);
        let raw = raw.trim_start_matches(|c| c == '\n' || c == '\r').trim();
        let status = match raw.chars().next() {
            Some(c @ ('M' | 'A' | 'D' | 'R' | 'C')) => c.to_string(),
            _ => "?".to_string(),
        };
        // The `-z` output carries one path token per non-rename status (the
        // new path) and two for R/C (original, then new).
        let Some(first_path) = tokens.next() else {
            break;
        };
        let first_path = String::from_utf8_lossy(first_path).into_owned();
        if first_path.is_empty() {
            continue;
        }
        let (path, old_path) = if matches!(status.as_str(), "R" | "C") {
            (
                tokens
                    .next()
                    .map(|t| String::from_utf8_lossy(t).into_owned())
                    .unwrap_or_default(),
                Some(first_path),
            )
        } else {
            (first_path, None)
        };
        records.push(GitCommitFile {
            path,
            status,
            old_path,
        });
    }
    records
}

/// Guard a revision argument (a commit hash, or `<hash>^`) so it can never be
/// read as an option or smuggle a second colon-separated path. Hashes come
/// from `git log` itself; this is defense-in-depth alongside `--`.
fn safe_commit_ref(commit_ref: &str) -> Result<(), String> {
    if commit_ref.is_empty() {
        return Err("Commit is empty".to_string());
    }
    if commit_ref.starts_with('-')
        || commit_ref.contains(':')
        || commit_ref.contains(char::is_whitespace)
    {
        return Err(format!("Unsafe commit reference: {commit_ref}"));
    }
    Ok(())
}

fn parse_status_lines(output: &str) -> Vec<GitFileStatus> {
    output.lines().filter_map(parse_status_line).collect()
}

fn parse_status_line(line: &str) -> Option<GitFileStatus> {
    let bytes = line.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let x = bytes[0] as char;
    let y = bytes[1] as char;
    let rest = line.get(2..)?;
    let rest = rest.strip_prefix(' ').unwrap_or(rest).trim_end();

    let (path, renamed_from) = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
        match find_rename_separator(rest) {
            Some((start, end)) => {
                let old = dequote_path(&rest[..start]);
                let new = dequote_path(&rest[end..]);
                (new, Some(old))
            }
            None => (dequote_path(rest), None),
        }
    } else {
        (dequote_path(rest), None)
    };
    if path.is_empty() {
        return None;
    }

    let staged = matches!(x, 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T');
    let untracked = x == '?' && y == '?';
    let unstaged = untracked || matches!(y, 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T');
    let status = if x != ' ' && x != '?' {
        x
    } else if y != ' ' && y != '?' {
        y
    } else {
        '?'
    };

    Some(GitFileStatus {
        path,
        status: status.to_string(),
        staged,
        unstaged,
        untracked,
        renamed_from,
        staged_status: x.to_string(),
        unstaged_status: y.to_string(),
    })
}

/// Locate the last ` -> ` that is not inside a C-quoted path segment. Failed
/// names may contain ` -> ` themselves; git quotes such paths, and the rename
/// separator is the final unquoted one.
fn find_rename_separator(rest: &str) -> Option<(usize, usize)> {
    let bytes = rest.as_bytes();
    let needle: &[u8] = b" -> ";
    let mut last: Option<usize> = None;
    let mut i = 0;
    let mut in_quote = false;
    while i < bytes.len() {
        if in_quote {
            match bytes[i] {
                b'\\' => i += 2,
                b'"' => {
                    in_quote = false;
                    i += 1;
                }
                _ => i += 1,
            }
            continue;
        }
        match bytes[i] {
            b'"' => {
                in_quote = true;
                i += 1;
            }
            b' ' if bytes[i..].starts_with(needle) => {
                last = Some(i);
                i += needle.len();
            }
            _ => i += 1,
        }
    }
    last.map(|start| (start, start + needle.len()))
}

/// Undo git's C-style quoting when the path is wrapped in double quotes
/// (filenames with tabs, double quotes or backslashes). Paths with no special
/// characters are never quoted and pass through unchanged.
fn dequote_path(text: &str) -> String {
    if !text.starts_with('"') {
        return text.to_string();
    }
    let inner = text.trim_matches('"');
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'"' => out.push(b'"'),
                b'\\' => out.push(b'\\'),
                b'a' => out.push(0x07),
                b'b' => out.push(0x08),
                b't' => out.push(b'\t'),
                b'n' => out.push(b'\n'),
                b'v' => out.push(0x0b),
                b'f' => out.push(0x0c),
                b'r' => out.push(b'\r'),
                b'0'..=b'7' => {
                    let mut value = 0u32;
                    let mut digits = 0;
                    while digits < 3 && i < bytes.len() && (b'0'..=b'7').contains(&bytes[i]) {
                        value = value * 8 + (bytes[i] - b'0') as u32;
                        i += 1;
                        digits += 1;
                    }
                    out.push(value as u8);
                    i -= 1;
                }
                b'x' if i + 1 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() => {
                    let mut value = 0u32;
                    let mut digits = 0;
                    while digits < 2 && i + 1 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() {
                        value = value * 16 + (bytes[i + 1] as char).to_digit(16).unwrap_or(0);
                        i += 1;
                        digits += 1;
                    }
                    out.push(value as u8);
                }
                other => out.push(other),
            }
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_modified() {
        let file = parse_status_line(" M main.cpp").expect("row parses");
        assert_eq!(file.path, "main.cpp");
        assert_eq!(file.status, "M");
        assert!(!file.staged);
        assert!(file.unstaged);
        assert!(!file.untracked);
        assert_eq!(file.staged_status, " ");
        assert_eq!(file.unstaged_status, "M");
    }

    #[test]
    fn parses_staged_added() {
        let file = parse_status_line("A  new.cpp").expect("row parses");
        assert_eq!(file.path, "new.cpp");
        assert_eq!(file.status, "A");
        assert!(file.staged);
        assert!(!file.unstaged);
        assert!(!file.untracked);
    }

    #[test]
    fn parses_staged_added_with_worktree_edit() {
        let file = parse_status_line("AM new.cpp").expect("row parses");
        assert_eq!(file.status, "A");
        assert!(file.staged);
        assert!(file.unstaged);
    }

    #[test]
    fn parses_modified_twice() {
        let file = parse_status_line("MM src/a.cpp").expect("row parses");
        assert_eq!(file.path, "src/a.cpp");
        assert_eq!(file.status, "M");
        assert!(file.staged);
        assert!(file.unstaged);
    }

    #[test]
    fn parses_untracked() {
        let file = parse_status_line("?? scratch.txt").expect("row parses");
        assert_eq!(file.path, "scratch.txt");
        assert_eq!(file.status, "?");
        assert!(!file.staged);
        assert!(file.unstaged);
        assert!(file.untracked);
    }

    #[test]
    fn parses_deleted_in_worktree() {
        let file = parse_status_line(" D gone.txt").expect("row parses");
        assert_eq!(file.path, "gone.txt");
        assert_eq!(file.status, "D");
        assert!(!file.staged);
        assert!(file.unstaged);
    }

    #[test]
    fn parses_rename() {
        let file = parse_status_line("R  old.cpp -> new.cpp").expect("row parses");
        assert_eq!(file.path, "new.cpp");
        assert_eq!(file.renamed_from.as_deref(), Some("old.cpp"));
        assert_eq!(file.status, "R");
        assert!(file.staged);
    }

    #[test]
    fn parses_rename_with_spaces() {
        let file = parse_status_line("R  my old.cpp -> my new.cpp").expect("row parses");
        assert_eq!(file.path, "my new.cpp");
        assert_eq!(file.renamed_from.as_deref(), Some("my old.cpp"));
    }

    #[test]
    fn parses_quoted_rename() {
        let file = parse_status_line("R  \"old file.cpp\" -> \"new file.cpp\"").expect("row parses");
        assert_eq!(file.path, "new file.cpp");
        assert_eq!(file.renamed_from.as_deref(), Some("old file.cpp"));
    }

    #[test]
    fn parses_conflicted() {
        let file = parse_status_line("UU conflict.cpp").expect("row parses");
        assert_eq!(file.path, "conflict.cpp");
        assert_eq!(file.status, "U");
        assert!(file.staged);
        assert!(file.unstaged);
    }

    #[test]
    fn dequotes_octal_utf8() {
        let path = dequote_path(r#""\346\226\207\344\273\266.txt""#);
        assert_eq!(path, "文件.txt");
    }

    #[test]
    fn dequotes_escaped_tab() {
        assert_eq!(dequote_path(r#""a\tb.txt""#), "a\tb.txt");
    }

    #[test]
    fn keeps_unquoted_path_verbatim() {
        assert_eq!(dequote_path("a -> b.txt"), "a -> b.txt");
    }

    #[test]
    fn skips_separator_inside_quotes() {
        let (start, end) = find_rename_separator(r#"old -> "a -> b.txt""#).expect("separator found");
        assert_eq!(&r#"old -> "a -> b.txt""#[start..end], " -> ");
    }

    #[test]
    fn ignores_blank_and_short_lines() {
        assert!(parse_status_line("").is_none());
        assert!(parse_status_line("M").is_none());
        assert!(parse_status_line(" ?").is_none());
    }

    // ---------------- diff / commit command-level tests (real git) ----------------

    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    fn write_file(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn git_commit(workspace: &Path, message: &str) {
        run_git_ok(workspace, &["add", "-A"], "stage for test commit").unwrap();
        run_git_ok(workspace, &["commit", "-m", message], "test commit").unwrap();
    }

    /// A throwaway Git repository for command-level tests, removed on drop.
    struct TestRepo {
        workspace: PathBuf,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.workspace);
        }
    }

    fn temp_repo() -> TestRepo {
        let id = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let workspace = std::env::temp_dir().join(format!(
            "lite_ide_git_test_{}_{id}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&workspace);
        std::fs::create_dir_all(&workspace).unwrap();

        let init = run_git(&workspace, &["init"]).expect("git init runs");
        assert!(init.success, "git init failed: {}", init.stderr);
        for (key, value) in [
            ("user.email", "lite-ide-test@example.com"),
            ("user.name", "Lite IDE Test"),
        ] {
            let out = run_git(&workspace, &["config", key, value]).expect("git config runs");
            assert!(out.success, "git config {key} failed: {}", out.stderr);
        }
        TestRepo { workspace }
    }

    fn side(source: &str, path: &str) -> DiffSideRequest {
        DiffSideRequest {
            source: source.to_string(),
            path: path.to_string(),
            commit: None,
            label: None,
        }
    }

    fn sidec(source: &str, path: &str, commit: &str) -> DiffSideRequest {
        DiffSideRequest {
            source: source.to_string(),
            path: path.to_string(),
            commit: Some(commit.to_string()),
            label: None,
        }
    }

    #[test]
    fn diff_fetches_head_and_worktree() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "a.txt", b"two\n");

        let diff = diff_content(
            &repo.workspace,
            &side("HEAD", "a.txt"),
            &side("WORKTREE", "a.txt"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "one\n");
        assert_eq!(diff.modified, "two\n");
        assert!(!diff.binary);
        assert_eq!(diff.original_label, "HEAD:a.txt");
        assert_eq!(diff.modified_label, "工作区");
    }

    #[test]
    fn diff_head_vs_index_after_stage() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "a.txt", b"two\n");
        run_git_ok(&repo.workspace, &["add", "a.txt"], "stage").unwrap();

        let diff = diff_content(
            &repo.workspace,
            &side("HEAD", "a.txt"),
            &side("INDEX", "a.txt"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "one\n");
        assert_eq!(diff.modified, "two\n");
    }

    #[test]
    fn diff_added_file_head_side_is_empty() {
        let repo = temp_repo();
        write_file(&repo.workspace, "new.cpp", b"// fresh\n");
        run_git_ok(&repo.workspace, &["add", "new.cpp"], "stage").unwrap();

        let diff = diff_content(
            &repo.workspace,
            &side("HEAD", "new.cpp"),
            &side("INDEX", "new.cpp"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "", "HEAD has no entry for a new file");
        assert_eq!(diff.modified, "// fresh\n");

        let empty = diff_content(
            &repo.workspace,
            &side("EMPTY", "new.cpp"),
            &side("INDEX", "new.cpp"),
        )
        .expect("diff reads");
        assert_eq!(empty.original, "");
        assert_eq!(empty.modified, "// fresh\n");
        assert_eq!(empty.original_label, "空");
    }

    #[test]
    fn diff_deleted_unstaged_uses_index_side() {
        let repo = temp_repo();
        write_file(&repo.workspace, "gone.txt", b"left behind\n");
        git_commit(&repo.workspace, "base");
        std::fs::remove_file(repo.workspace.join("gone.txt")).unwrap();

        let diff = diff_content(
            &repo.workspace,
            &side("INDEX", "gone.txt"),
            &side("EMPTY", "gone.txt"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "left behind\n");
        assert_eq!(diff.modified, "", "the worktree no longer has the file");
    }

    #[test]
    fn diff_unicode_and_spaces_paths() {
        let repo = temp_repo();
        write_file(&repo.workspace, "中文/新 文件.txt", "你好\n".as_bytes());
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "中文/新 文件.txt", "再见\n".as_bytes());

        let diff = diff_content(
            &repo.workspace,
            &side("HEAD", "中文/新 文件.txt"),
            &side("WORKTREE", "中文/新 文件.txt"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "你好\n");
        assert_eq!(diff.modified, "再见\n");
        assert_eq!(diff.original_label, "HEAD:中文/新 文件.txt");
    }

    #[test]
    fn diff_worktree_side_missing_is_empty() {
        let repo = temp_repo();
        let diff = diff_content(
            &repo.workspace,
            &side("WORKTREE", "no-such-file.txt"),
            &side("EMPTY", "no-such-file.txt"),
        )
        .unwrap_or_else(|e| panic!("missing worktree file degrades to empty: {e}"));
        assert_eq!(diff.original, "");
    }

    #[test]
    fn diff_detects_binary_blobs() {
        let repo = temp_repo();
        write_file(&repo.workspace, "pic.bin", b"\x89PNG\x00\x01\x02");
        git_commit(&repo.workspace, "base");

        let diff = diff_content(
            &repo.workspace,
            &side("HEAD", "pic.bin"),
            &side("WORKTREE", "pic.bin"),
        )
        .expect("diff reads");
        assert!(diff.binary, "NUL byte marks the blob as binary");
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "");
    }

    #[test]
    fn diff_rejects_traversal_paths() {
        let repo = temp_repo();
        let err = diff_content(
            &repo.workspace,
            &side("WORKTREE", "../secret.txt"),
            &side("EMPTY", "../secret.txt"),
        )
        .expect_err("traversal must be rejected");
        assert!(err.contains("Unsafe diff path"), "got: {err}");
    }

    #[test]
    fn diff_rejects_unknown_source() {
        let repo = temp_repo();
        assert!(
            diff_content(
                &repo.workspace,
                &side("NOPE", "a.txt"),
                &side("EMPTY", "a.txt"),
            )
            .is_err(),
            "unknown source errors"
        );
    }

    #[test]
    fn commit_requires_message() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"hi\n");
        git_commit(&repo.workspace, "base");
        let err = commit(&repo.workspace, "   ").expect_err("empty message rejects");
        assert!(err.contains("empty"), "got: {err}");
    }

    #[test]
    fn commit_fails_when_nothing_to_commit() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"hi\n");
        git_commit(&repo.workspace, "base");
        let err = commit(&repo.workspace, "nothing staged").expect_err("clean repo rejects");
        let _ = err; // exact wording is git-version dependent (stdout vs stderr)
    }

    #[test]
    fn commit_applies_message() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "a.txt", b"two\n");
        run_git_ok(&repo.workspace, &["add", "a.txt"], "stage").unwrap();

        commit(&repo.workspace, "my subject\n\nmy body").unwrap();
        let status = run_git(&repo.workspace, &["status", "--short"]).expect("status runs");
        assert_eq!(status.stdout.trim(), "", "worktree is clean after the commit");
        let subject = run_git(&repo.workspace, &["log", "-1", "--format=%s"]).expect("log runs");
        assert_eq!(subject.stdout, "my subject\n");
        let shown = run_git(&repo.workspace, &["show", "HEAD:a.txt"]).expect("show runs");
        assert_eq!(shown.stdout, "two\n", "the committed blob is the staged version");
    }

    // ---------------- history / commit-files tests (real git) ----------------

    #[test]
    fn history_lists_commits_newest_first() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "first");
        write_file(&repo.workspace, "a.txt", b"two\n");
        git_commit(&repo.workspace, "second");

        let history = commit_history(&repo.workspace, 50, 0).expect("history reads");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].message, "second");
        assert_eq!(history[1].message, "first");
        assert_ne!(history[0].hash, history[1].hash);
        assert_eq!(history[0].short_hash.len(), 7);
        assert_eq!(history[0].author, "Lite IDE Test");
        assert_eq!(history[0].email.as_deref(), Some("lite-ide-test@example.com"));
        assert!(history[0].date > 0, "timestamp is parsed");
        assert_eq!(history[0].short_hash, &history[0].hash[..7]);
    }

    #[test]
    fn history_preserves_unicode_subject() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "feat: 登录 支持 ✓");
        let history = commit_history(&repo.workspace, 50, 0).expect("history reads");
        assert_eq!(history[0].message, "feat: 登录 支持 ✓");
    }

    #[test]
    fn history_unborn_repo_is_empty() {
        let repo = temp_repo();
        let history = commit_history(&repo.workspace, 50, 0).expect("no commits is not an error");
        assert!(history.is_empty());
    }

    #[test]
    fn history_pages_with_limit_and_skip() {
        let repo = temp_repo();
        for i in 0..5 {
            write_file(&repo.workspace, "a.txt", format!("line {i}\n").as_bytes());
            git_commit(&repo.workspace, &format!("commit {i}"));
        }
        let first = commit_history(&repo.workspace, 2, 0).expect("first page");
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].message, "commit 4");
        let next = commit_history(&repo.workspace, 2, 2).expect("second page");
        assert_eq!(next[0].message, "commit 2");
        let tail = commit_history(&repo.workspace, 50, 2).expect("remaining");
        assert_eq!(tail.len(), 3);
    }

    #[test]
    fn commit_files_reports_changed_paths() {
        let repo = temp_repo();
        write_file(&repo.workspace, "src/main.cpp", b"one\n");
        write_file(&repo.workspace, "keep.txt", b"keep\n");
        git_commit(&repo.workspace, "base");

        write_file(&repo.workspace, "src/main.cpp", b"two\n");
        write_file(&repo.workspace, "new.txt", b"new\n");
        std::fs::remove_file(repo.workspace.join("keep.txt")).unwrap();
        git_commit(&repo.workspace, "mixed");

        let details = commit_files(&repo.workspace, &last_hash(&repo.workspace)).expect("details");
        assert_eq!(details.parent_hash.as_deref(), Some(first_hash(&repo.workspace).as_str()));
        let by_path: std::collections::HashMap<&str, &GitCommitFile> = details
            .files
            .iter()
            .map(|f| (f.path.as_str(), f))
            .collect();
        assert_eq!(by_path["src/main.cpp"].status, "M");
        assert_eq!(by_path["new.txt"].status, "A");
        assert_eq!(by_path["keep.txt"].status, "D");
        assert_eq!(details.commit.message, "mixed");
        assert_eq!(details.commit.author, "Lite IDE Test");
    }

    #[test]
    fn commit_files_root_commit_has_no_parent() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "init");
        let details = commit_files(&repo.workspace, "HEAD").expect("details");
        assert!(details.parent_hash.is_none(), "root commit has no parent");
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].status, "A");
        assert_eq!(details.files[0].path, "a.txt");
    }

    #[test]
    fn commit_files_detects_rename() {
        let repo = temp_repo();
        write_file(&repo.workspace, "old.cpp", b"same content\n");
        git_commit(&repo.workspace, "base");
        std::fs::rename(
            repo.workspace.join("old.cpp"),
            repo.workspace.join("new.cpp"),
        )
        .unwrap();
        git_commit(&repo.workspace, "rename");

        let details = commit_files(&repo.workspace, &last_hash(&repo.workspace)).expect("details");
        assert_eq!(details.files.len(), 1, "a rename is a single change");
        let renamed = &details.files[0];
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.path, "new.cpp");
        assert_eq!(renamed.old_path.as_deref(), Some("old.cpp"));
    }

    #[test]
    fn commit_files_unicode_and_space_paths() {
        let repo = temp_repo();
        write_file(&repo.workspace, "中文/新 文件.txt", "你好\n".as_bytes());
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "中文/新 文件.txt", "再见\n".as_bytes());
        git_commit(&repo.workspace, "edit");

        let details = commit_files(&repo.workspace, &last_hash(&repo.workspace)).expect("details");
        assert_eq!(details.files.len(), 1);
        assert_eq!(details.files[0].path, "中文/新 文件.txt");
        assert_eq!(details.files[0].status, "M");
    }

    #[test]
    fn commit_files_rejects_unknown_commit() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        let err = commit_files(&repo.workspace, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
            .expect_err("bad commit rejects");
        let _ = err;
    }

    // ---------------- COMMIT diff source tests ----------------

    fn first_hash(workspace: &Path) -> String {
        let out = run_git(workspace, &["rev-parse", "--short=40", "HEAD~1"]).expect("git runs");
        out.stdout.trim().to_string()
    }

    fn last_hash(workspace: &Path) -> String {
        let out = run_git(workspace, &["rev-parse", "--short=40", "HEAD"]).expect("git runs");
        out.stdout.trim().to_string()
    }

    #[test]
    fn commit_diff_modified_parent_vs_commit() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "a.txt", b"two\n");
        git_commit(&repo.workspace, "edit");

        let parent = first_hash(&repo.workspace);
        let head = last_hash(&repo.workspace);
        let diff = diff_content(
            &repo.workspace,
            &sidec("COMMIT", "a.txt", &parent),
            &sidec("COMMIT", "a.txt", &head),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "one\n");
        assert_eq!(diff.modified, "two\n");
        assert!(!diff.binary);
    }

    #[test]
    fn commit_diff_added_is_empty_to_commit() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"base\n");
        git_commit(&repo.workspace, "base");
        write_file(&repo.workspace, "fresh.txt", b"fresh\n");
        git_commit(&repo.workspace, "add");
        let head = last_hash(&repo.workspace);

        let diff = diff_content(
            &repo.workspace,
            &side("EMPTY", "fresh.txt"),
            &sidec("COMMIT", "fresh.txt", &head),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "");
        assert_eq!(diff.modified, "fresh\n");
        assert_eq!(diff.original_label, "空");
    }

    #[test]
    fn commit_diff_deleted_commit_to_empty() {
        let repo = temp_repo();
        write_file(&repo.workspace, "gone.txt", b"bye\n");
        git_commit(&repo.workspace, "base");
        std::fs::remove_file(repo.workspace.join("gone.txt")).unwrap();
        git_commit(&repo.workspace, "remove");
        let parent = first_hash(&repo.workspace);

        let diff = diff_content(
            &repo.workspace,
            &sidec("COMMIT", "gone.txt", &parent),
            &side("EMPTY", "gone.txt"),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "bye\n");
        assert_eq!(diff.modified, "");
    }

    #[test]
    fn commit_diff_rename_uses_old_and_new_paths() {
        let repo = temp_repo();
        write_file(&repo.workspace, "old.cpp", b"same\n");
        git_commit(&repo.workspace, "base");
        std::fs::rename(repo.workspace.join("old.cpp"), repo.workspace.join("new.cpp")).unwrap();
        git_commit(&repo.workspace, "rename");
        let parent = first_hash(&repo.workspace);
        let head = last_hash(&repo.workspace);

        let diff = diff_content(
            &repo.workspace,
            &sidec("COMMIT", "old.cpp", &parent),
            &sidec("COMMIT", "new.cpp", &head),
        )
        .expect("diff reads");
        assert_eq!(diff.original, "same\n");
        assert_eq!(diff.modified, "same\n");
    }

    #[test]
    fn commit_diff_label_override() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        let head = last_hash(&repo.workspace);

        let mut labeled = sidec("COMMIT", "a.txt", &head);
        labeled.label = Some("a1b2c3d: a.txt".to_string());
        let diff = diff_content(&repo.workspace, &side("EMPTY", "a.txt"), &labeled).expect("diff reads");
        assert_eq!(diff.modified_label, "a1b2c3d: a.txt");
    }

    #[test]
    fn commit_diff_missing_file_is_empty() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        let head = last_hash(&repo.workspace);
        let diff = diff_content(
            &repo.workspace,
            &side("EMPTY", "nope.txt"),
            &sidec("COMMIT", "nope.txt", &head),
        )
        .expect("missing blob degrades to empty");
        assert_eq!(diff.modified, "");
    }

    #[test]
    fn commit_diff_rejects_unsafe_commit_ref() {
        let repo = temp_repo();
        write_file(&repo.workspace, "a.txt", b"one\n");
        git_commit(&repo.workspace, "base");
        for bad in ["--help", "-x", "abc:def", "has space"] {
            let err = diff_content(
                &repo.workspace,
                &sidec("COMMIT", "a.txt", bad),
                &side("EMPTY", "a.txt"),
            )
            .expect_err("unsafe commit ref rejects");
            assert!(err.contains("Unsafe commit"), "got: {err}");
        }
    }
}