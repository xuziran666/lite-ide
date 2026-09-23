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

  return (
    <header className="top-bar">
      <span className="top-bar-brand">lite-ide</span>
      {workspacePath && (
        <span className="top-bar-workspace" title={workspacePath}>
          {workspaceName(workspacePath)}
        </span>
      )}
      <span className="top-bar-spacer" />
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
    </header>
  );
}

export default TopBar;