import type { GitCommitFile } from "../commands";

/** One node in the commit file tree. */
export interface CommitTreeNode {
  /** Full workspace-relative path (directories end with "/"). */
  path: string;
  /** "dir" | "file" */
  kind: "dir" | "file";
  /** Directory or file name (the last path segment). */
  name: string;
  /** Files only: M / A / D / R / C / ?. */
  status?: string;
  /** Files only: old path for rename/copy entries, otherwise null. */
  oldPath?: string | null;
  /** Directories only: child nodes, nested. */
  children?: CommitTreeNode[];
}

function calcStatus(file: GitCommitFile): string {
  return file.status ?? "?";
}

function nameCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function compareNodes(a: CommitTreeNode, b: CommitTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1; // dirs first
  return nameCompare(a.name, b.name);
}

/** Insert one file into a level's preview list, creating directories. */
function insertNode(
  level: CommitTreeNode[],
  segments: string[],
  prefix: string,
  file: GitCommitFile,
): void {
  const head = segments[0];
  if (head === undefined) return;
  if (segments.length === 1) {
    level.push({
      kind: "file",
      path: file.path,
      name: head,
      status: calcStatus(file),
      oldPath: file.oldPath ?? null,
    });
    return;
  }
  let dir = level.find(
    (n) => n.kind === "dir" && nameCompare(n.name, head) === 0,
  );
  if (!dir) {
    dir = {
      kind: "dir",
      path: prefix + head + "/",
      name: head,
      children: [],
    };
    level.push(dir);
  }
  insertNode(dir.children!, segments.slice(1), prefix + head + "/", file);
}

function sortLevel(nodes: CommitTreeNode[]): void {
  for (const n of nodes) {
    if (n.kind === "dir" && n.children) sortLevel(n.children);
  }
  nodes.sort(compareNodes);
}

/**
 * Build an IDEA-style workspace-relative directory tree over a commit's
 * changed files: directories first at each level, then files, each sorted
 * case-insensitively. All directories start expanded (default false = open).
 */
export function buildCommitTree(files: GitCommitFile[]): CommitTreeNode[] {
  const root: CommitTreeNode[] = [];
  for (const file of files) {
    const segments = file.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    insertNode(root, segments, "", file);
  }
  sortLevel(root);
  return root;
}