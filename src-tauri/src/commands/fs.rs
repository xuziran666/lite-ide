use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::io_error;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Directory names hidden from the file tree.
const HIDDEN_DIRS: &[&str] = &[".git", "target", "dist", "build", ".cache"];

/// Directory names whose file-system events the watcher drops. A build or a
/// dependency install can touch tens of thousands of files under these folders,
/// which would otherwise flood the UI with refresh work. `node_modules` stays in
/// this list but is no longer hidden, so the tree can still show it.
pub(crate) const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".cache",
];

fn no_workspace_error() -> String {
    "No workspace is open. Please open a folder first.".to_string()
}

/// Whether a directory name is hidden from the file tree.
pub(crate) fn is_hidden_name(name: &str) -> bool {
    HIDDEN_DIRS.iter().any(|d| *d == name)
}

/// Whether a directory name is dropped by the file-system watcher.
fn is_ignored_name(name: &str) -> bool {
    IGNORED_DIRS.iter().any(|d| *d == name)
}

/// Whether any path component (leaf included) is a directory hidden from the
/// file tree, so navigation features cannot reach inside `.git` & co.
pub(crate) fn path_is_hidden(path: &Path) -> bool {
    path.components()
        .map(Component::as_os_str)
        .filter_map(|s| s.to_str())
        .any(is_hidden_name)
}

pub(crate) fn path_is_ignored(path: &Path) -> bool {
    path.components()
        .map(Component::as_os_str)
        .filter_map(|s| s.to_str())
        .any(is_ignored_name)
}

/// Lexically resolve "." and ".." components without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize the requested path against the workspace and enforce the workspace
/// boundary. Handles both existing and non-existing targets:
/// - existing targets are canonicalized (resolves symlinks) then checked;
/// - non-existing targets are checked against their deepest existing ancestor,
///   then the remaining relative components are re-appended.
fn validate_within_workspace(workspace: &Path, requested: &Path) -> Result<PathBuf, String> {
    let abs = normalize_path(&workspace.join(requested));

    let mut anchor = abs.as_path();
    loop {
        match fs::canonicalize(anchor) {
            Ok(canonical) => {
                if !canonical.starts_with(workspace) {
                    return Err(format!(
                        "Path is outside the workspace: {}",
                        abs.display()
                    ));
                }
                if anchor == abs {
                    return Ok(canonical);
                }
                let suffix = abs
                    .strip_prefix(anchor)
                    .map_err(|_| format!("Cannot resolve path: {}", abs.display()))?;
                return Ok(canonical.join(suffix));
            }
            Err(_) => match anchor.parent() {
                Some(parent) => anchor = parent,
                None => return Err(format!("Cannot resolve path: {}", abs.display())),
            },
        }
    }
}

/// Validate a single entry name (a file or directory leaf, never a path).
pub(crate) fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty.".to_string());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("Invalid entry name: {name}"));
    }
    #[cfg(windows)]
    {
        const INVALID: &[char] = &['<', '>', ':', '"', '|', '?', '*'];
        if let Some(ch) = name.chars().find(|c| INVALID.contains(c)) {
            return Err(format!("Invalid character '{ch}' in name: {name}"));
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return Err(format!("Name cannot end with '.' or a space: {name}"));
        }
    }
    Ok(())
}

/// Resolve a create/rename/delete target against the workspace. The parent is
/// canonicalized (so a symlinked parent cannot escape the workspace) and the
/// leaf name is validated; the leaf itself is never canonicalized, so a symlink
/// leaf is operated on rather than followed.
fn leaf_path_within_workspace(
    workspace: &Path,
    parent: &str,
    name: &str,
) -> Result<PathBuf, String> {
    validate_entry_name(name)?;
    let parent_abs = normalize_path(&workspace.join(parent));
    let canon =
        fs::canonicalize(&parent_abs).map_err(|e| io_error("resolve parent directory", e))?;
    if !canon.is_dir() || !canon.starts_with(workspace) {
        return Err(format!("Invalid parent directory: {}", canon.display()));
    }
    Ok(canon.join(name))
}

fn do_list_dir(workspace: &Path, path: &str) -> Result<Vec<Entry>, String> {
    let dir = validate_within_workspace(workspace, Path::new(path))?;

    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| io_error("read directory", e))?;
    for item in read_dir {
        let item = item.map_err(|e| io_error("read directory entry", e))?;
        let file_name = item.file_name();
        if is_hidden_name(&file_name.to_string_lossy()) {
            continue;
        }
        let file_type = item
            .file_type()
            .map_err(|e| io_error("read entry type", e))?;
        let name = file_name.to_string_lossy().into_owned();
        entries.push(Entry {
            name: name.clone(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

fn do_read_file(workspace: &Path, path: &str) -> Result<String, String> {
    let file = validate_within_workspace(workspace, Path::new(path))?;

    if !file.is_file() {
        return Err(format!("Not a file: {}", file.display()));
    }

    let bytes = fs::read(&file).map_err(|e| io_error("read file", e))?;
    String::from_utf8(bytes).map_err(|_| {
        format!("File is not valid UTF-8 and cannot be opened: {}", file.display())
    })
}

/// Read a single file that lives outside the workspace (for example a
/// rust-analyzer definition jump into the toolchain's standard library, or a
/// source file whose absolute path was given explicitly).
///
/// This is the narrow end-user escape hatch from the workspace boundary: it
/// only ever reads, never writes, and it validates the request strictly:
/// - the path must be absolute;
/// - it must not contain "." or ".." traversal components;
/// - it is canonicalized (so a symlink must resolve to an existing file);
/// - it must resolve to a regular file, not a directory.
/// The caller decides whether a path is "external" by comparing it against the
/// workspace; everything still inside the workspace goes through `read_file`.
fn do_read_external_file(path: &str) -> Result<String, String> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(format!("An absolute path is required: {path}"));
    }
    for component in requested.components() {
        match component {
            Component::ParentDir => {
                return Err(format!("Unsafe path (parent traversal): {path}"));
            }
            Component::CurDir => {
                return Err(format!("Unsafe path ('.' component): {path}"));
            }
            _ => {}
        }
    }

    let file =
        fs::canonicalize(requested).map_err(|e| io_error("resolve file", e))?;
    if !file.is_file() {
        return Err(format!("Not a file: {}", file.display()));
    }

    let bytes = fs::read(&file).map_err(|e| io_error("read file", e))?;
    String::from_utf8(bytes).map_err(|_| {
        format!("File is not valid UTF-8 and cannot be opened: {}", file.display())
    })
}

fn do_write_file(workspace: &Path, path: &str, content: &str) -> Result<(), String> {
    let file = validate_within_workspace(workspace, Path::new(path))?;
    fs::write(&file, content.as_bytes()).map_err(|e| io_error("write file", e))
}

fn do_create_file(workspace: &Path, parent: &str, name: &str) -> Result<Entry, String> {
    let target = leaf_path_within_workspace(workspace, parent, name)?;
    if target.exists() {
        return Err(format!("Entry already exists: {}", target.display()));
    }
    fs::File::create(&target).map_err(|e| io_error("create file", e))?;
    Ok(Entry {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
        is_dir: false,
    })
}

fn do_create_dir(workspace: &Path, parent: &str, name: &str) -> Result<Entry, String> {
    let target = leaf_path_within_workspace(workspace, parent, name)?;
    if target.exists() {
        return Err(format!("Entry already exists: {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| io_error("create directory", e))?;
    Ok(Entry {
        name: name.to_string(),
        path: target.to_string_lossy().into_owned(),
        is_dir: true,
    })
}

fn do_rename(workspace: &Path, path: &str, new_name: &str) -> Result<String, String> {
    validate_entry_name(new_name)?;
    let entry = validate_within_workspace(workspace, Path::new(path))?;
    if !entry.exists() {
        return Err(format!("Entry does not exist: {}", entry.display()));
    }
    if entry == workspace {
        return Err("Cannot rename the workspace root.".to_string());
    }
    let parent = entry.parent().ok_or_else(|| "Cannot rename the workspace root.".to_string())?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err(format!("Entry already exists: {}", target.display()));
    }
    fs::rename(&entry, &target).map_err(|e| io_error("rename entry", e))?;
    Ok(target.to_string_lossy().into_owned())
}

fn do_delete(workspace: &Path, path: &str) -> Result<(), String> {
    let entry = validate_within_workspace(workspace, Path::new(path))?;
    if !entry.exists() {
        return Err(format!("Entry does not exist: {}", entry.display()));
    }
    if entry == workspace {
        return Err("Cannot delete the workspace root.".to_string());
    }
    if entry.is_dir() {
        fs::remove_dir_all(&entry).map_err(|e| io_error("delete directory", e))
    } else {
        fs::remove_file(&entry).map_err(|e| io_error("delete file", e))
    }
}

#[tauri::command]
pub fn list_dir(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_list_dir(&workspace, &path)
}

#[tauri::command]
pub fn read_file(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_read_file(&workspace, &path)
}

/// Read a single file outside the workspace (see `do_read_external_file` for
/// the validation rules). Used for LSP definition jumps into files such as the
/// rust standard library. Read-only: there is no matching write command.
#[tauri::command]
pub fn read_external_file(path: String) -> Result<String, String> {
    do_read_external_file(&path)
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_write_file(&workspace, &path, &content)
}

#[tauri::command]
pub fn create_file(
    parent: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Entry, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_create_file(&workspace, &parent, &name)
}

#[tauri::command]
pub fn create_dir(
    parent: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<Entry, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_create_dir(&workspace, &parent, &name)
}

#[tauri::command]
pub fn rename_entry(
    path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_rename(&workspace, &path, &new_name)
}

#[tauri::command]
pub fn delete_entry(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let workspace = state.workspace()?.ok_or_else(no_workspace_error)?;
    do_delete(&workspace, &path)
}

#[tauri::command]
pub fn set_workspace(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let requested = PathBuf::from(&path);
    if !requested.is_dir() {
        return Err(format!("Not a directory: {}", requested.display()));
    }
    let canonical = fs::canonicalize(&requested).map_err(|e| io_error("open workspace", e))?;
    state.set_workspace(canonical.clone(), app.clone())?;
    // Remembering the workspace must never block opening it.
    if let Err(err) = crate::session::save_workspace(&app, &canonical) {
        eprintln!("could not persist the workspace: {err}");
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// The workspace from the previous run, or `None` when there is nothing usable
/// to restore (for example when the folder was deleted or moved in the meantime).
#[tauri::command]
pub fn get_last_workspace(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(saved) = crate::session::load(&app).last_workspace else {
        return Ok(None);
    };
    let path = PathBuf::from(&saved);
    if !path.is_dir() {
        return Ok(None);
    }
    let canonical =
        fs::canonicalize(&path).map_err(|e| io_error("resolve the remembered workspace", e))?;
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_workspace(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state
        .workspace()?
        .map(|p| p.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    use std::os::unix::fs::symlink_dir;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_dir;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn tmp_workspace() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!(
            "lite_ide_test_{}_{}",
            std::process::id(),
            n
        ));
        fs::create_dir_all(base.join("sub")).unwrap();
        fs::write(base.join("inside.txt"), "hello").unwrap();
        fs::canonicalize(&base).unwrap()
    }

    #[test]
    fn normalize_path_resolves_parent_components() {
        assert_eq!(
            normalize_path(Path::new("a/b/../c")),
            PathBuf::from("a").join("c")
        );
        assert_eq!(normalize_path(Path::new("a/b/../../..")), PathBuf::new());
    }

    #[test]
    fn validates_existing_file_inside_workspace() {
        let ws = tmp_workspace();
        let res = validate_within_workspace(&ws, Path::new("inside.txt"));
        assert!(res.is_ok());
        assert!(res.unwrap().starts_with(&ws));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validates_nonexistent_target_inside_workspace() {
        let ws = tmp_workspace();
        let res = validate_within_workspace(&ws, Path::new("sub/new.txt"));
        let ok = res.expect("should be allowed");
        assert_eq!(ok, ws.join("sub").join("new.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let ws = tmp_workspace();
        let outside = ws.parent().unwrap().join("outside.txt");
        fs::write(&outside, "x").unwrap();
        let p = outside.to_string_lossy().into_owned();
        assert!(validate_within_workspace(&ws, Path::new(&p)).is_err());
        let _ = fs::remove_file(&outside);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_parent_escape_for_nonexistent_target() {
        let ws = tmp_workspace();
        let p = format!("../outside_{}.txt", std::process::id());
        assert!(validate_within_workspace(&ws, Path::new(&p)).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_symlink_escape() {
        let ws = tmp_workspace();
        // Create the symlink only where supported (Windows: requires dev mode,
        // Unix fine). If creation fails, skip.
        let link = ws.join("escape");
        if symlink_dir(std::env::temp_dir(), &link).is_ok() {
            let p = format!("{}/secret.txt", link.to_string_lossy());
            let res = validate_within_workspace(&ws, Path::new(&p));
            assert!(res.is_err(), "symlink escaping workspace must be rejected");
            let _ = fs::remove_file(&link);
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validates_entry_names() {
        assert!(validate_entry_name("file.txt").is_ok());
        assert!(validate_entry_name("my folder").is_ok());
        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name(".").is_err());
        assert!(validate_entry_name("..").is_err());
        assert!(validate_entry_name("a/b").is_err());
        assert!(validate_entry_name("a\\b").is_err());
        #[cfg(windows)]
        {
            assert!(validate_entry_name("bad:name").is_err());
            assert!(validate_entry_name("bad?name").is_err());
            assert!(validate_entry_name("bad*name").is_err());
            assert!(validate_entry_name("trailing.").is_err());
            assert!(validate_entry_name("trailing ").is_err());
        }
    }

    #[test]
    fn creates_file_inside_workspace() {
        let ws = tmp_workspace();
        let entry = do_create_file(&ws, "", "new.txt").unwrap();
        assert_eq!(entry.name, "new.txt");
        assert!(!entry.is_dir);
        assert!(ws.join("new.txt").is_file());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn creates_dir_inside_workspace() {
        let ws = tmp_workspace();
        let entry = do_create_dir(&ws, "sub", "child").unwrap();
        assert!(entry.is_dir);
        assert!(ws.join("sub").join("child").is_dir());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn create_rejects_duplicate() {
        let ws = tmp_workspace();
        assert!(do_create_file(&ws, "", "inside.txt").is_err());
        assert!(do_create_dir(&ws, "", "sub").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn create_rejects_invalid_targets() {
        let ws = tmp_workspace();
        assert!(do_create_file(&ws, "", "a/b.txt").is_err());
        assert!(do_create_file(&ws, "", "..\\evil.txt").is_err());
        assert!(do_create_file(&ws, "missing", "x.txt").is_err());
        assert!(do_create_file(&ws, "", "").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn renames_file_and_reports_new_path() {
        let ws = tmp_workspace();
        let target = do_rename(&ws, "inside.txt", "renamed.txt").unwrap();
        assert_eq!(target, ws.join("renamed.txt").to_string_lossy());
        assert!(ws.join("renamed.txt").is_file());
        assert!(!ws.join("inside.txt").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rename_rejects_invalid_name_and_conflicts() {
        let ws = tmp_workspace();
        assert!(do_rename(&ws, "inside.txt", "a/b").is_err());
        assert!(do_rename(&ws, "inside.txt", "sub").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn deletes_file_and_recursive_dir() {
        let ws = tmp_workspace();
        do_create_dir(&ws, "sub", "deep").unwrap();
        do_create_file(&ws, "sub/deep", "leaf.txt").unwrap();
        assert!(do_delete(&ws, "sub/deep").is_ok());
        assert!(!ws.join("sub").join("deep").exists());
        assert!(do_delete(&ws, "inside.txt").is_ok());
        assert!(!ws.join("inside.txt").exists());
        assert!(do_delete(&ws, "missing.txt").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn refuses_root_delete_and_rename() {
        let ws = tmp_workspace();
        let root = ws.to_string_lossy().into_owned();
        assert!(do_delete(&ws, &root).is_err());
        assert!(do_rename(&ws, &root, "renamed").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn list_dir_hides_only_hidden_directories() {
        let ws = tmp_workspace();
        fs::create_dir(ws.join("node_modules")).unwrap();
        fs::create_dir(ws.join(".git")).unwrap();
        let entries = do_list_dir(&ws, "").unwrap();
        assert!(entries.iter().any(|e| e.name == "node_modules"));
        assert!(entries.iter().all(|e| e.name != ".git"));
        assert!(entries.iter().any(|e| e.name == "sub"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn path_is_ignored_only_matches_noisy_directories() {
        let ws = tmp_workspace();
        for noisy in [
            "node_modules/pkg/index.js",
            ".git/objects/ab/cdef",
            "target/debug/lib.rlib",
            "dist/bundle.js",
            "build/out.txt",
            ".cache/data.bin",
        ] {
            let path = noisy
                .split('/')
                .fold(ws.clone(), |acc, segment| acc.join(segment));
            assert!(path_is_ignored(&path), "{noisy} should be ignored");
        }
        assert!(!path_is_ignored(&ws.join("src").join("main.rs")));
        assert!(!path_is_ignored(&ws.join("inside.txt")));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn read_external_requires_absolute_path() {
        assert!(do_read_external_file("relative.txt").is_err());
    }

    #[test]
    fn read_external_rejects_traversal_components() {
        assert!(do_read_external_file("C:\\..\\secret.txt").is_err());
        assert!(do_read_external_file("C:\\a\\.\\secret.txt").is_err());
        assert!(do_read_external_file("/tmp/../secret.txt").is_err());
    }

    #[test]
    fn read_external_reads_an_existing_file() {
        let base = std::env::temp_dir().join(format!(
            "lite_ide_ext_test_{}",
            std::process::id()
        ));
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("out.txt"), "hello").unwrap();
        let canonical = fs::canonicalize(base.join("out.txt")).unwrap();
        let target = canonical.to_string_lossy().into_owned();
        assert_eq!(do_read_external_file(&target).unwrap(), "hello");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn read_external_rejects_directories_and_missing_files() {
        let base = std::env::temp_dir().join(format!(
            "lite_ide_ext_dir_test_{}",
            std::process::id()
        ));
        fs::create_dir_all(&base).unwrap();
        let dir = fs::canonicalize(&base).unwrap();
        assert!(do_read_external_file(&dir.to_string_lossy()).is_err());
        assert!(do_read_external_file(&dir.join("missing.txt").to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}