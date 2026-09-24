import { memo, type MouseEvent } from "react";
import type { TreeNode as TreeNodeType } from "../../types";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";
import FolderIcon from "./FolderIcon";
import FileIcon from "./FileIcon";

interface Props {
  node: TreeNodeType;
  depth: number;
  onMenu: (e: MouseEvent, node: TreeNodeType) => void;
}

function TreeNode({ node, depth, onMenu }: Props) {
  const selectedPath = useFileTreeStore((s) => s.selectedPath);
  const toggleDir = useFileTreeStore((s) => s.toggleDir);
  const select = useFileTreeStore((s) => s.select);
  const openFile = useEditorStore((s) => s.openFile);

  const isDir = node.kind === "dir";
  const isSelected = node.path === selectedPath;

  function handleClick() {
    select(node.path);
    if (isDir) {
      void toggleDir(node.path);
    } else {
      void openFile(node.path);
    }
  }

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        onContextMenu={(e) => onMenu(e, node)}
        title={node.path}
      >
        {isDir ? (
          <span className={`tree-chevron${node.expanded ? " open" : ""}`} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        ) : (
          <span className="tree-chevron" aria-hidden="true" />
        )}
        {isDir ? <FolderIcon /> : <FileIcon />}
        <span className="file-name">{node.name}</span>
        {node.loading && <span className="tree-spinner" aria-hidden="true" />}
      </div>
      {isDir && node.expanded && (
        <div className="tree-children">
          {node.error && <div className="tree-row-error">{node.error}</div>}
          {node.loaded && node.children && node.children.length > 0 && (
            <>
              {node.children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  onMenu={onMenu}
                />
              ))}
            </>
          )}
          {node.loaded && !node.loading && node.children?.length === 0 && (
            <div
              className="tree-empty"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              空文件夹
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TreeNode);