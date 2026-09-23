import { invoke } from "@tauri-apps/api/core";
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