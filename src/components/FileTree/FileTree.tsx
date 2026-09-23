import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import FolderIcon from "./FolderIcon";
import FileIcon from "./FileIcon";

function FileTree() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const entries = useWorkspaceStore((s) => s.entries);
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const rootName =
    workspacePath?.split(/[\\/]/).filter(Boolean).pop() || workspacePath || "";

  async function changeFolder() {
    const selected = await open({ directory: true, multiple: false });
    const dir = Array.isArray(selected) ? selected[0] : selected;
    if (dir) {
      await openWorkspace(dir);
    }
  }

  return (
    <aside className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title" title={workspacePath ?? ""}>
          {rootName}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="切换工作区"
          onClick={() => void changeFolder()}
        >
          <FolderIcon />
        </button>
      </div>
      <div className="file-tree-body">
        {error && <p className="error-text">{error}</p>}
        {!error && loading && entries.length === 0 && (
          <p className="muted file-tree-hint">加载中…</p>
        )}
        {!error && !loading && entries.length === 0 && (
          <p className="muted file-tree-hint">空文件夹</p>
        )}
        <ul className="file-list">
          {entries.map((e) => (
            <li key={e.path} className="file-item">
              {e.is_dir ? <FolderIcon /> : <FileIcon />}
              <span className="file-name" title={e.name}>
                {e.name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export default FileTree;