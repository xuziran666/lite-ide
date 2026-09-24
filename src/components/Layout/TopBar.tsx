import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTaskStore } from "../../stores/taskStore";

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function SecondarySidebarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <line
        x1="17"
        y1="4"
        x2="17"
        y2="20"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect
        x="2.55"
        y="2.55"
        width="6.9"
        height="6.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M4.55 4.05V2.55h4.9v4.9H8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect
        x="2.55"
        y="4.55"
        width="4.9"
        height="4.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <line x1="2.7" y1="2.7" x2="9.3" y2="9.3" stroke="currentColor" strokeWidth="1.1" />
      <line x1="9.3" y1="2.7" x2="2.7" y2="9.3" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

interface TopBarProps {
  secondarySidebarVisible: boolean;
  onToggleSecondarySidebar: () => void;
}

function TopBar({
  secondarySidebarVisible,
  onToggleSecondarySidebar,
}: TopBarProps) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const taskCenterOpen = useTaskStore((s) => s.taskCenterOpen);
  const taskRunning = useTaskStore((s) => s.taskStatus === "running");
  const toggleTaskCenter = useTaskStore((s) => s.toggleTaskCenter);

  // Track the maximized state so the middle window button flips between the
  // maximize and restore glyphs.
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized).catch(() => undefined);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  return (
    <header className="top-bar" data-tauri-drag-region>
      <span className="top-bar-brand" data-tauri-drag-region>
        lite-ide
      </span>
      {workspacePath && (
        <span
          className="top-bar-workspace"
          data-tauri-drag-region
          title={workspacePath}
        >
          {workspaceName(workspacePath)}
        </span>
      )}
      <span className="top-bar-spacer" data-tauri-drag-region />
      <button
        type="button"
        className={
          secondarySidebarVisible ? "top-bar-button active" : "top-bar-button"
        }
        title={secondarySidebarVisible ? "隐藏右侧栏" : "显示右侧栏"}
        onClick={onToggleSecondarySidebar}
      >
        <SecondarySidebarIcon />
      </button>
      <div className="top-bar-task-center">
        <button
          type="button"
          className={
            taskCenterOpen ? "top-bar-task-trigger active" : "top-bar-task-trigger"
          }
          title="任务中心（双击 Ctrl）"
          onClick={toggleTaskCenter}
        >
          {taskRunning && <span className="top-bar-task-dot" />}
          任务
        </button>
      </div>
      <div className="top-bar-window-controls">
        <button
          type="button"
          className="top-bar-window-button"
          title="最小化"
          onClick={() => void getCurrentWindow().minimize()}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className="top-bar-window-button"
          title={maximized ? "还原" : "最大化"}
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        <button
          type="button"
          className="top-bar-window-button close"
          title="关闭"
          onClick={() => void getCurrentWindow().close()}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  );
}

export default TopBar;