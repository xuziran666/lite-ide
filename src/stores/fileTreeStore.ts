import { create } from "zustand";
import type { DirEntry, TreeNode } from "../types";
import {
  createDir as createDirCommand,
  createFile as createFileCommand,
  deleteEntry as deleteEntryCommand,
  listDir,
  renameEntry as renameEntryCommand,
} from "../commands";
import { basename, dirname, joinPath } from "../utils/language";
import {
  canonicalPath,
  fileKey,
  isPathInsideWorkspace,
  resolveAgainstWorkspace,
} from "../utils/pathIdentity";
import { useEditorStore } from "./editorStore";

// Directories that are never auto-expanded when revealing the active file,
// mirroring VS Code's `explorer.autoRevealExclude`. Files inside them are still
// highlighted when already visible, and manual expansion is unaffected.
const AUTO_REVEAL_SKIP = ["node_modules"];

function nodeFromEntry(entry: DirEntry): TreeNode {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.is_dir ? "dir" : "file",
    expanded: false,
    loading: false,
    loaded: false,
  };
}

function findNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node;
  if (node.kind === "dir" && node.children) {
    for (const child of node.children) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

function mapNode(
  node: TreeNode,
  path: string,
  fn: (n: TreeNode) => TreeNode,
): TreeNode {
  if (node.path === path) return fn(node);
  if (node.kind === "dir" && node.children) {
    return { ...node, children: node.children.map((c) => mapNode(c, path, fn)) };
  }
  return node;
}

function mergeChildren(node: TreeNode, entries: DirEntry[]): TreeNode {
  const prior = new Map((node.children ?? []).map((c) => [c.name, c]));
  const children = entries.map((entry) => {
    const prev = prior.get(entry.name);
    const kind: TreeNode["kind"] = entry.is_dir ? "dir" : "file";
    if (prev && prev.kind === kind) {
      return { ...prev, name: entry.name, path: entry.path, kind };
    }
    return nodeFromEntry(entry);
  });
  return { ...node, children, loaded: true, loading: false, error: null };
}

interface FileTreeStore {
  root: TreeNode | null;
  selectedPath: string | null;
  error: string | null;
  version: number;
  loadRoot: (workspacePath: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  loadChildren: (path: string) => Promise<void>;
  refreshPath: (path: string) => Promise<void>;
  onFileSystemChanged: (paths: string[]) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  createFile: (parent: string, name: string) => Promise<boolean>;
  createDir: (parent: string, name: string) => Promise<boolean>;
  renameEntry: (path: string, newName: string) => Promise<boolean>;
  deleteEntry: (path: string) => Promise<boolean>;
  select: (path: string | null) => void;
  reset: () => void;
}

export const useFileTreeStore = create<FileTreeStore>((set, get) => ({
  root: null,
  selectedPath: null,
  error: null,
  version: 0,

  loadRoot: async (workspacePath: string) => {
    const version = get().version + 1;
    set({
      error: null,
      version,
      root: {
        name: basename(workspacePath),
        path: workspacePath,
        kind: "dir",
        expanded: true,
        loading: true,
        loaded: false,
      },
    });
    try {
      const entries = await listDir(workspacePath);
      if (get().version !== version) return;
      set((s) => ({
        root: s.root
          ? {
              ...s.root,
              children: entries.map(nodeFromEntry),
              loading: false,
              loaded: true,
            }
          : s.root,
      }));
    } catch (e) {
      if (get().version !== version) return;
      set((s) => ({
        error: String(e),
        root: s.root ? { ...s.root, loading: false, error: String(e) } : s.root,
      }));
    }
  },

  toggleDir: async (path: string) => {
    const root = get().root;
    if (!root) return;
    const node = findNode(root, path);
    if (!node || node.kind !== "dir") return;

    const willExpand = !node.expanded;
    set((s) => ({
      root: s.root
        ? mapNode(s.root, path, (n) => ({ ...n, expanded: willExpand }))
        : s.root,
    }));
    if (willExpand && !node.loaded) {
      await get().loadChildren(path);
    }
  },

  loadChildren: async (path: string) => {
    const root = get().root;
    if (!root) return;
    const node = findNode(root, path);
    if (!node || node.kind !== "dir" || node.loading) return;

    const version = get().version;
    set((s) => ({
      root: s.root
        ? mapNode(s.root, path, (n) => ({ ...n, loading: true }))
        : s.root,
    }));
    try {
      const entries = await listDir(path);
      if (get().version !== version) return;
      set((s) => ({
        root: s.root
          ? mapNode(s.root, path, (n) => mergeChildren(n, entries))
          : s.root,
      }));
    } catch (e) {
      if (get().version !== version) return;
      set((s) => ({
        error: String(e),
        root: s.root
          ? mapNode(s.root, path, (n) => ({
              ...n,
              loading: false,
              error: String(e),
            }))
          : s.root,
      }));
    }
  },

  // Reload the loaded directory that contains `path` (or `path` itself when it
  // is a loaded directory), preserving expanded sub-state of surviving nodes.
  refreshPath: async (path: string) => {
    const root = get().root;
    if (!root) return;

    const self = findNode(root, path);
    if (self && self.kind === "dir" && self.loaded) {
      await get().loadChildren(path);
      return;
    }

    const parent = dirname(path);
    if (!parent || parent === path) return;
    const pnode = findNode(root, parent);
    if (pnode && pnode.kind === "dir" && pnode.loaded) {
      await get().loadChildren(parent);
    }
  },

  onFileSystemChanged: async (paths: string[]) => {
    const root = get().root;
    if (!root) return;
    // A batch usually names many siblings (a checkout, a build writing into
    // one directory). Reloading each changed path would re-read the same
    // parent directory once per sibling, so collapse the batch to the set of
    // directories that actually need re-reading.
    const parents = new Set<string>();
    for (const p of paths) {
      const parent = p === root.path ? p : dirname(p);
      if (parent) parents.add(parent);
    }
    for (const parent of parents) {
      await get().refreshPath(parent);
    }
  },

  // Select `path` in the tree, expanding and lazily loading its ancestors so a
  // file opened from a tab becomes visible. Whether the tree itself is collapsed
  // is left untouched.
  //
  // `path` may be a canonical path (tab / LSP / relative) while the tree stores
  // the backend's own representation, so the identity comparison is canonical
  // and the ancestors are rebuilt from the root's real path.
  revealPath: async (path: string) => {
    const root = get().root;
    if (!root) return;

    const absolute = resolveAgainstWorkspace(path, root.path);
    if (!isPathInsideWorkspace(absolute, root.path)) return;
    if (fileKey(absolute) === fileKey(root.path)) return;

    const canonRoot = canonicalPath(root.path).replace(/\/+$/, "");
    const rel = canonicalPath(absolute)
      .slice(canonRoot.length)
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean);
    if (rel.length === 0) return;
    const fileName = rel.pop() as string;

    // Opening e.g. node_modules/pkg/dist/index.js must not unfold the whole
    // dependency chain; the tab still opens and the file gets highlighted once
    // its parent directory is expanded by hand.
    if (rel.some((segment) => AUTO_REVEAL_SKIP.includes(segment))) return;

    let current = root.path;
    for (const segment of rel) {
      current = joinPath(current, segment);
      const tree = get().root;
      if (!tree) return;
      const node = findNode(tree, current);
      if (!node || node.kind !== "dir") return;
      if (!node.expanded) {
        await get().toggleDir(current);
      } else if (!node.loaded) {
        await get().loadChildren(current);
      }
    }
    set({ selectedPath: joinPath(current, fileName) });
  },

  createFile: async (parent: string, name: string) => {
    try {
      const entry = await createFileCommand(parent, name);
      await get().refreshPath(parent);
      void useEditorStore.getState().openFile(entry.path);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  createDir: async (parent: string, name: string) => {
    try {
      const entry = await createDirCommand(parent, name);
      await get().refreshPath(parent);
      return entry.is_dir;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  renameEntry: async (path: string, newName: string) => {
    try {
      const newPath = await renameEntryCommand(path, newName);
      useEditorStore.getState().applyRename(path, newPath);
      await get().refreshPath(dirname(path));
      set((s) => ({
        selectedPath: s.selectedPath === path ? newPath : s.selectedPath,
      }));
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  deleteEntry: async (path: string) => {
    try {
      await deleteEntryCommand(path);
      useEditorStore.getState().applyDelete(path);
      await get().refreshPath(dirname(path));
      set((s) => ({
        selectedPath: s.selectedPath === path ? null : s.selectedPath,
      }));
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  select: (path: string | null) => set({ selectedPath: path, error: null }),

  reset: () =>
    set({
      root: null,
      selectedPath: null,
      error: null,
      version: get().version + 1,
    }),
}));