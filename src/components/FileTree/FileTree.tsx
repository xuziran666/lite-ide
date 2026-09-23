import { useCallback, useState, type MouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { TreeNode as TreeNodeType } from "../../types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";
import TreeNode from "./TreeNode";
import FolderIcon from "./FolderIcon";
import ContextMenu, { type ContextMenuAction } from "./ContextMenu";
import NameInputDialog from "./NameInputDialog";
import ConfirmDialog from "./ConfirmDialog";

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be denied; copying is best effort.
  }
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNodeType;
}

interface NewMenuState {
  x: number;
  y: number;
}

interface FileTreeProps {
  onCollapse: () => void;
}

function FileTree({ onCollapse }: FileTreeProps) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const root = useFileTreeStore((s) => s.root);
  const error = useFileTreeStore((s) => s.error);
  const createFile = useFileTreeStore((s) => s.createFile);
  const createDir = useFileTreeStore((s) => s.createDir);
  const renameEntry = useFileTreeStore((s) => s.renameEntry);
  const deleteEntry = useFileTreeStore((s) => s.deleteEntry);
  const openFile = useEditorStore((s) => s.openFile);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newMenu, setNewMenu] = useState<NewMenuState | null>(null);
  const [creating, setCreating] = useState<{
    kind: "dir" | "file";
    parent: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<TreeNodeType | null>(null);
  const [deleting, setDeleting] = useState<TreeNodeType | null>(null);

  const rootName =
    workspacePath?.split(/[\\/]/).filter(Boolean).pop() || workspacePath || "";

  const handleMenu = useCallback((e: MouseEvent, node: TreeNodeType) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  async function changeFolder() {
    const selected = await open({ directory: true, multiple: false });
    const dir = Array.isArray(selected) ? selected[0] : selected;
    if (dir) {
      await openWorkspace(dir);
    }
  }

  function relativePath(path: string): string | null {
    if (!workspacePath || path === workspacePath) return null;
    if (!path.startsWith(workspacePath)) return null;
    return path.slice(workspacePath.length).replace(/^[\\/]/, "");
  }

  function buildActions(node: TreeNodeType): ContextMenuAction[] {
    const actions: ContextMenuAction[] = [];
    if (node.kind === "dir") {
      actions.push({
        label: "新建文件",
        onClick: () => setCreating({ kind: "file", parent: node.path }),
      });
      actions.push({
        label: "新建文件夹",
        onClick: () => setCreating({ kind: "dir", parent: node.path }),
      });
    } else {
      actions.push({
        label: "打开",
        onClick: () => void openFile(node.path),
      });
    }
    actions.push({
      label: "复制路径",
      onClick: () => void copyText(node.path),
    });
    const relative = relativePath(node.path);
    if (relative) {
      actions.push({
        label: "复制相对路径",
        onClick: () => void copyText(relative),
      });
    }
    actions.push({ label: "重命名", onClick: () => setRenaming(node) });
    actions.push({
      label: "删除",
      danger: true,
      onClick: () => setDeleting(node),
    });
    return actions;
  }

  return (
    <aside className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title" title={workspacePath ?? ""}>
          {rootName}
        </span>
        <div className="file-tree-actions">
          <button
            type="button"
            className="icon-btn"
            title="折叠文件树"
            onClick={onCollapse}
          >
            «
          </button>
          <button
            type="button"
            className="icon-btn"
            title="新建"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setNewMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            +
          </button>
          <button
            type="button"
            className="icon-btn"
            title="切换工作区"
            onClick={() => void changeFolder()}
          >
            <FolderIcon />
          </button>
        </div>
      </div>
      <div className="file-tree-body">
        {error && <p className="error-text">{error}</p>}
        {!error && !root && <p className="muted file-tree-hint">加载中…</p>}
        {root && <TreeNode node={root} depth={0} onMenu={handleMenu} />}
      </div>

      {newMenu && (
        <ContextMenu
          x={newMenu.x}
          y={newMenu.y}
          actions={[
            {
              label: "新建文件",
              onClick: () =>
                setCreating({ kind: "file", parent: root?.path ?? "" }),
            },
            {
              label: "新建文件夹",
              onClick: () =>
                setCreating({ kind: "dir", parent: root?.path ?? "" }),
            },
          ]}
          onClose={() => setNewMenu(null)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          actions={buildActions(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}

      {creating && (
        <NameInputDialog
          title={creating.kind === "file" ? "新建文件" : "新建文件夹"}
          confirmLabel="创建"
          onConfirm={(name) => {
            void (creating.kind === "file"
              ? createFile(creating.parent, name)
              : createDir(creating.parent, name));
            setCreating(null);
          }}
          onCancel={() => setCreating(null)}
        />
      )}

      {renaming && (
        <NameInputDialog
          title="重命名"
          initial={renaming.name}
          confirmLabel="重命名"
          onConfirm={(name) => {
            void renameEntry(renaming.path, name);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={
            deleting.kind === "dir"
              ? `删除文件夹「${deleting.name}」？`
              : `删除文件「${deleting.name}」？`
          }
          message={
            deleting.kind === "dir"
              ? "文件夹及其所有内容将被永久删除。"
              : "该文件将被永久删除。"
          }
          confirmLabel="删除"
          onConfirm={() => {
            void deleteEntry(deleting.path);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </aside>
  );
}

export default FileTree;