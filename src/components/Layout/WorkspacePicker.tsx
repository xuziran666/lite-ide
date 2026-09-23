import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspaceStore } from "../../stores/workspaceStore";

function WorkspacePicker() {
  const [path, setPath] = useState("");
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const error = useWorkspaceStore((s) => s.error);
  const loading = useWorkspaceStore((s) => s.loading);

  async function pickFolder() {
    const selected = await open({ directory: true, multiple: false });
    const dir = Array.isArray(selected) ? selected[0] : selected;
    if (dir) {
      setPath(dir);
      await openWorkspace(dir);
    }
  }

  async function openPath() {
    const trimmed = path.trim();
    if (trimmed) {
      await openWorkspace(trimmed);
    }
  }

  return (
    <div className="picker-screen">
      <div className="picker-card">
        <h1>lite-ide</h1>
        <p>选择一个文件夹作为工作区</p>
        <div className="picker-row">
          <input
            placeholder="C:\path\to\project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void openPath();
            }}
          />
          <button type="button" onClick={() => void pickFolder()}>
            选择文件夹
          </button>
          <button
            type="button"
            onClick={() => void openPath()}
            disabled={!path.trim() || loading}
          >
            打开
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}

export default WorkspacePicker;