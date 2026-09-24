export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export type TreeNodeKind = "dir" | "file";

export interface TreeNode {
  name: string;
  path: string;
  kind: TreeNodeKind;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error?: string | null;
  children?: TreeNode[];
}

export interface Tab {
  path: string;
  name: string;
  language: string;
  dirty: boolean;
  /** True for files outside the workspace (e.g. the global tasks.json). */
  external?: boolean;
  /** True for files opened from outside the workspace (e.g. LSP definitions
   *  into the standard library): never dirty, never saveable. */
  readOnly?: boolean;
}

/** Cursor and selection state reported by the active Monaco editor. */
export interface CursorInfo {
  line: number;
  column: number;
  selected: number;
}