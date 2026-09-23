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
}