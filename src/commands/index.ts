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

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: string;
  minimap: boolean;
}

export interface TerminalSettings {
  defaultShell: string;
}

export interface GeneralSettings {
  restoreLastWorkspace: boolean;
  confirmBeforeClose: boolean;
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