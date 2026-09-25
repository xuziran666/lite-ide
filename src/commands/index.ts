import { invoke, Channel } from "@tauri-apps/api/core";
import type { DirEntry } from "../types";

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/**
 * Read a single file outside the workspace (e.g. a rust-analyzer definition
 * jump into the standard library). Read-only — there is no write counterpart.
 * Paths are validated on the backend: absolute, no "." or ".." components, and
 * it must resolve to a regular file.
 */
export function readExternalFile(path: string): Promise<string> {
  return invoke<string>("read_external_file", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

export function setWorkspace(path: string): Promise<string> {
  return invoke<string>("set_workspace", { path });
}

export function getWorkspace(): Promise<string | null> {
  return invoke<string | null>("get_workspace");
}

/**
 * The workspace opened during the previous run, or null when there is nothing
 * to restore (first run, or the folder was deleted or moved meanwhile).
 */
export function getLastWorkspace(): Promise<string | null> {
  return invoke<string | null>("get_last_workspace");
}

export function createFile(parent: string, name: string): Promise<DirEntry> {
  return invoke<DirEntry>("create_file", { parent, name });
}

export function createDir(parent: string, name: string): Promise<DirEntry> {
  return invoke<DirEntry>("create_dir", { parent, name });
}

export function renameEntry(path: string, newName: string): Promise<string> {
  return invoke<string>("rename_entry", { path, newName });
}

export function deleteEntry(path: string): Promise<void> {
  return invoke<void>("delete_entry", { path });
}

export function terminalSpawn(
  id: number,
  channel: Channel<Uint8Array>,
): Promise<void> {
  return invoke<void>("terminal_spawn", { id, channel });
}

export function terminalWrite(id: number, data: string): Promise<void> {
  return invoke<void>("terminal_write", { id, data });
}

export function terminalResize(
  id: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("terminal_resize", { id, cols, rows });
}

export function terminalKill(id: number): Promise<void> {
  return invoke<void>("terminal_kill", { id });
}

export function terminalKillAll(): Promise<void> {
  return invoke<void>("terminal_kill_all");
}

export interface TaskSpec {
  name: string;
  command: string;
}

/**
 * Tasks defined in the global `tasks.json` (the app config directory, next to
 * `user.json`), or null when the file does not exist. Errors are surfaced by
 * the backend as rejected promises.
 */
export function loadTasks(): Promise<TaskSpec[] | null> {
  return invoke<TaskSpec[] | null>("load_tasks");
}

/** `editor.guides.*`: nested so more guide options can be added later. */
export interface EditorGuidesSettings {
  indentation: boolean;
}

/** `editor.bracketPairColorization.*`: nested like `guides`. */
export interface EditorBracketPairColorizationSettings {
  enabled: boolean;
}

/**
 * Monaco options mirrored from `user.json`. Every value is a union of what
 * Monaco itself accepts (monaco-editor 0.56 `IEditorOptions`), so the settings
 * file can never carry a value the editor cannot apply.
 */
export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  tabSize: number;
  wordWrap: string;
  minimap: boolean;
  lineNumbers: "on" | "off" | "relative";
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  renderLineHighlight: "none" | "gutter" | "line" | "all";
  guides: EditorGuidesSettings;
  folding: boolean;
  matchBrackets: "always" | "never" | "near";
  smoothScrolling: boolean;
  cursorStyle:
    | "line"
    | "block"
    | "underline"
    | "line-thin"
    | "block-outline"
    | "underline-thin";
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  formatOnPaste: boolean;
  formatOnType: boolean;
  autoClosingBrackets:
    | "always"
    | "languageDefined"
    | "beforeWhitespace"
    | "never";
  autoClosingQuotes:
    | "always"
    | "languageDefined"
    | "beforeWhitespace"
    | "never";
  autoSurround: "languageDefined" | "quotes" | "brackets" | "never";
  trimAutoWhitespace: boolean;
  dragAndDrop: boolean;
  copyWithSyntaxHighlighting: boolean;
  bracketPairColorization: EditorBracketPairColorizationSettings;
  mouseWheelZoom: boolean;
  theme: string;
}

export interface TerminalSettings {
  defaultShell: string;
}

export interface GeneralSettings {
  restoreLastWorkspace: boolean;
  confirmBeforeClose: boolean;
  theme: string;
}

/**
 * `files.autoSave`: each trigger is independent (unlike VS Code's single
 * choice), so any enabled trigger saves the dirty editors.
 */
export interface AutoSaveSettings {
  afterDelay: boolean;
  onFocusChange: boolean;
  onWindowChange: boolean;
  delay: number;
}

export interface FilesSettings {
  autoSave: AutoSaveSettings;
}

/** A resolved language-server invocation (executable + argv). */
export interface LspServerConfig {
  command: string;
  args: string[];
}

/** Per-language language-server configuration. */
export interface LspConfig {
  rust: LspServerConfig;
  cpp: LspServerConfig;
  typescript: LspServerConfig;
}

export interface UserConfig {
  keybindings: Record<string, string>;
  editor: EditorSettings;
  terminal: TerminalSettings;
  general: GeneralSettings;
  lsp: LspConfig;
  files: FilesSettings;
  configDir: string;
  notice: string | null;
}

/** The shape the Settings UI writes back: every section is fully filled. */
export interface UserConfigPatch {
  keybindings: Record<string, string>;
  editor: EditorSettings;
  terminal: TerminalSettings;
  general: GeneralSettings;
  lsp: LspConfig;
  files: FilesSettings;
}

/** The user configuration merged over the built-in defaults; always resolves. */
export function getUserConfig(): Promise<UserConfig> {
  return invoke<UserConfig>("get_user_config");
}

/** Persist the full user configuration back to `user.json`. */
export function setUserConfig(config: UserConfigPatch): Promise<void> {
  return invoke<void>("set_user_config", { config });
}

/** Shells installed on this machine, most preferred first. */
export function getShells(): Promise<string[]> {
  return invoke<string[]>("get_shells");
}

/**
 * Read a global configuration file (e.g. `tasks.json`) from the app config
 * directory. Resolves null when the file does not exist.
 */
export function readGlobalFile(name: string): Promise<string | null> {
  return invoke<string | null>("read_global_file", { name });
}

/** Write a global configuration file back to the app config directory. */
export function writeGlobalFile(name: string, content: string): Promise<void> {
  return invoke<void>("write_global_file", { name, content });
}

/**
 * Every file in the workspace as a workspace-relative path with `/`
 * separators. Hidden directories (`.git`, `target`, `dist`, `build`, `.cache`)
 * are skipped; `node_modules` is included. Feeds Quick Open.
 */
export function listWorkspaceFiles(): Promise<string[]> {
  return invoke<string[]>("list_workspace_files");
}

export interface SearchMatch {
  /** Workspace-relative path, always using `/` separators. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based character column of the first match on the line. */
  column: number;
  /** The full line, trimmed of surrounding whitespace/newline. */
  text: string;
}

export interface SearchOptions {
  caseSensitive: boolean;
  useRegex: boolean;
}

/** Content search across the whole workspace; rejects on an invalid regex. */
export function searchWorkspace(
  query: string,
  options: SearchOptions,
): Promise<SearchMatch[]> {
  return invoke<SearchMatch[]>("search_workspace", {
    query,
    caseSensitive: options.caseSensitive,
    useRegex: options.useRegex,
  });
}

/** One changed file from the Source Control panel. */
export interface GitFileStatus {
  /** Workspace-relative path, always using `/` separators. */
  path: string;
  /** The most significant status letter: M / A / D / R / C / U / ?. */
  status: string;
  /** The change is staged in the index. */
  staged: boolean;
  /** The worktree differs from the index, or the file is untracked. */
  unstaged: boolean;
  /** The file is untracked (`??`). */
  untracked: boolean;
  /** Old path for rename/copy entries, otherwise null. */
  renamedFrom: string | null;
  /** Raw porcelain column 1 (`" "` when unmodified). */
  stagedStatus: string;
  /** Raw porcelain column 2 (`" "` when unmodified). */
  unstagedStatus: string;
}

/** The `git_status` snapshot for the current workspace. */
export interface GitSnapshot {
  /** Absolute repository root, or null when the workspace is not in a repo. */
  repositoryRoot: string | null;
  files: GitFileStatus[];
}

/** Detect the repository root for the workspace; null when not a Git repo. */
export function gitDetectRepository(): Promise<string | null> {
  return invoke<string | null>("git_detect_repository");
}

/** The Source Control snapshot (repository root + every changed file). */
export function gitStatus(): Promise<GitSnapshot> {
  return invoke<GitSnapshot>("git_status");
}

/** Stage the given workspace-relative paths. */
export function gitStage(paths: string[]): Promise<void> {
  return invoke<void>("git_stage", { paths });
}

/** Unstage the given workspace-relative paths. */
export function gitUnstage(paths: string[]): Promise<void> {
  return invoke<void>("git_unstage", { paths });
}

/** Stage every change in the workspace (added, modified and deleted). */
export function gitStageAll(): Promise<void> {
  return invoke<void>("git_stage_all");
}

/** Unstage every staged change in the workspace. */
export function gitUnstageAll(): Promise<void> {
  return invoke<void>("git_unstage_all");
}

/** The source of one side of a Git diff (which revision's blob to fetch). */
export type DiffSource = "HEAD" | "INDEX" | "WORKTREE" | "COMMIT" | "EMPTY";

/** One side of a Git diff fetch. `source` selects the blob: "HEAD" (last
 *  commit), "INDEX" (staging area), "WORKTREE" (disk), "COMMIT" (an arbitrary
 *  revision via its `commit` hash, defaulting to "HEAD") or "EMPTY" (no
 *  content, for a newly added or deleted side). `path` is the git-relative
 *  path to read (the pre-rename path on the original side of a rename).
 *  An optional `label` overrides the derived header label so the History panel
 *  can show short hashes like `a1b2c3d^: src/main.cpp`. */
export interface DiffSideRequest {
  source: DiffSource;
  path: string;
  commit?: string;
  label?: string;
}

/** Plain-text content of a temporary Git diff for the Monaco diff editor. */
export interface GitDiffContent {
  original: string;
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  /** Either side is a binary blob; the UI renders a message instead. */
  binary: boolean;
}

/** Fetch the two sides of a file diff from the repository. */
export function gitDiffFile(
  original: DiffSideRequest,
  modified: DiffSideRequest,
): Promise<GitDiffContent> {
  return invoke<GitDiffContent>("git_diff_file", { original, modified });
}

/** Commit the currently staged changes with the given message. */
export function gitCommit(message: string): Promise<void> {
  return invoke<void>("git_commit", { message });
}

/** One commit in the repository's history, newest first. */
export interface GitCommitInfo {
  /** Full 40-char SHA-1. */
  hash: string;
  /** First 7 characters of the hash. */
  shortHash: string;
  /** Subject line only. */
  message: string;
  author: string;
  email: string | null;
  /** Unix epoch seconds of the author date. */
  date: number;
}

/** One changed file inside a commit. */
export interface GitCommitFile {
  /** Workspace-relative path, always using `/` separators. */
  path: string;
  /** M / A / D / R / C, or "?" when the status is unknown. */
  status: string;
  /** Old path for rename/copy entries, otherwise null. */
  oldPath: string | null;
}

/** One commit's details: metadata, first parent and changed files. */
export interface GitCommitDetails {
  parentHash: string | null;
  commit: GitCommitInfo;
  files: GitCommitFile[];
}

/** The repository's commit history, newest first, paged by `limit`/`skip`.
 *  The caller infers "there are more" from a page that is exactly `limit`
 *  long. An empty repository resolves to an empty list. */
export function gitLog(limit: number, skip: number): Promise<GitCommitInfo[]> {
  return invoke<GitCommitInfo[]>("git_log", { limit, skip });
}

/** One commit's details (first parent + changed files). */
export function gitCommitDetails(
  commit: string,
): Promise<GitCommitDetails> {
  return invoke<GitCommitDetails>("git_commit_details", { commit });
}

export interface LspStartResult {
  alreadyRunning: boolean;
  rootUri: string | null;
  /** The server's `initialize` capabilities (feature keys like `renameProvider`). */
  capabilities: Record<string, unknown> | null;
}

/**
 * Start (or re-attach to) the language server session for one language in the
 * workspace. `language` is the client language id ("rust" / "cpp" /
 * "typescript"); `path` is the file that triggered the start (Rust uses it to
 * find its nearest `Cargo.toml`); `command` is the configured server argv,
 * falling back to the language's PATH default when omitted. Rejects when no
 * workspace is open or the server binary is missing.
 */
export function lspStart(
  language: string,
  path?: string,
  command?: string[],
): Promise<LspStartResult> {
  return invoke<LspStartResult>("lsp_start", { language, path, command });
}

/** Stop one language's session (workspace switch / last file of that language). */
export function lspStop(language: string): Promise<void> {
  return invoke<void>("lsp_stop", { language });
}

/** Send a one-way LSP notification. No-ops silently when no server is running. */
export function lspNotify(
  language: string,
  method: string,
  params: unknown,
): Promise<void> {
  return invoke<void>("lsp_notify", { language, method, params });
}

/** Send an LSP request and resolve with the server's result. */
export function lspRequest(
  language: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  return invoke<unknown>("lsp_request", { language, method, params });
}