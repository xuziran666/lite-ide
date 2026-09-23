import { useWorkspaceStore } from "../../stores/workspaceStore";

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
      {/* Reserved slot for the Task Center; not implemented yet. */}
      <span className="top-bar-task-center" />
    </header>
  );
}

export default TopBar;