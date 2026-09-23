import { invoke, Channel } from "@tauri-apps/api/core";
import type { DirEntry } from "../types";

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
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
 * Tasks defined in `.lite-ide/tasks.json`, or null when there is no workspace
 * or no task file. Errors are surfaced by the backend as rejected promises.
 */
export function loadWorkspaceTasks(): Promise<TaskSpec[] | null> {
  return invoke<TaskSpec[] | null>("load_workspace_tasks");
}

export interface UserConfig {
  keybindings: Record<string, string>;
  notice: string | null;
}

/** The user configuration bundled with the defaults; always resolves. */
export function getUserConfig(): Promise<UserConfig> {
  return invoke<UserConfig>("get_user_config");
}