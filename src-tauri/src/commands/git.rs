use std::path::PathBuf;

use tauri::State;

use crate::git;
use crate::state::AppState;

fn workspace(state: &AppState) -> Result<PathBuf, String> {
    state
        .workspace()?
        .ok_or_else(|| "No workspace".to_string())
}

/// Detect whether the workspace is inside a Git repository. Resolves with the
/// absolute repository root, or null when the workspace is not in a repo.
#[tauri::command]
pub fn git_detect_repository(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let workspace = workspace(&state)?;
    let root = git::find_repository_root(&workspace)?;
    Ok(root.map(|path| path.to_string_lossy().into_owned()))
}

/// The Source Control snapshot: repository root (null when not a repo) and
/// every changed file in the workspace.
#[tauri::command]
pub fn git_status(state: State<'_, AppState>) -> Result<git::GitSnapshot, String> {
    let workspace = workspace(&state)?;
    git::status_snapshot(&workspace)
}

/// Stage the given workspace-relative paths.
#[tauri::command]
pub fn git_stage(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let workspace = workspace(&state)?;
    git::stage_paths(&workspace, &paths)
}

/// Unstage the given workspace-relative paths (index back to HEAD).
#[tauri::command]
pub fn git_unstage(state: State<'_, AppState>, paths: Vec<String>) -> Result<(), String> {
    let workspace = workspace(&state)?;
    git::unstage_paths(&workspace, &paths)
}

/// Stage every change in the workspace (added, modified and deleted).
#[tauri::command]
pub fn git_stage_all(state: State<'_, AppState>) -> Result<(), String> {
    let workspace = workspace(&state)?;
    git::run_git_ok(&workspace, &["add", "-A"], "stage all changes")
}

/// Unstage every staged change in the workspace.
#[tauri::command]
pub fn git_unstage_all(state: State<'_, AppState>) -> Result<(), String> {
    let workspace = workspace(&state)?;
    git::run_git_ok(&workspace, &["restore", "--staged", "--", "."], "unstage all changes")
}

/// The plain-text content of a temporary Git diff between two revisions of one
/// file. `original` / `modified` are `DiffSideRequest`s naming which blob to
/// fetch (HEAD / INDEX / WORKTREE / EMPTY); the frontend derives them from the
/// file's status and the Source Control group the user clicked.
#[tauri::command]
pub fn git_diff_file(
    state: State<'_, AppState>,
    original: git::DiffSideRequest,
    modified: git::DiffSideRequest,
) -> Result<git::GitDiffContent, String> {
    let workspace = workspace(&state)?;
    git::diff_content(&workspace, &original, &modified)
}

/// Commit the currently staged changes with the given message.
#[tauri::command]
pub fn git_commit(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let workspace = workspace(&state)?;
    git::commit(&workspace, &message)
}

/// The repository's commit history (current branch, newest first), paged by
/// `limit` / `skip`. The caller infers "there are more" from a page that is
/// exactly `limit` long.
#[tauri::command]
pub fn git_log(
    state: State<'_, AppState>,
    limit: u64,
    skip: u64,
) -> Result<Vec<git::GitCommit>, String> {
    let workspace = workspace(&state)?;
    git::commit_history(&workspace, limit, skip)
}

/// One commit's details: its own metadata, its first parent (the base of a
/// Parent → Commit diff, None for the root commit) and the files it changed.
#[tauri::command]
pub fn git_commit_details(
    state: State<'_, AppState>,
    commit: String,
) -> Result<git::GitCommitDetails, String> {
    let workspace = workspace(&state)?;
    git::commit_files(&workspace, &commit)
}