import { useTaskStore } from "../../stores/taskStore";
import { useConfigStore } from "../../stores/configStore";

function ExplorerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 2h8.5l4.5 4.5V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V3.5A1.5 1.5 0 0 1 6 2z"
        fill="currentColor"
      />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h10v2H4zm0 5h10v2H4zm0 5h6v2H4z" fill="currentColor" />
      <path
        d="M15.5 16l2 2 3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"
        fill="currentColor"
      />
    </svg>
  );
}

interface ActivityBarProps {
  explorerVisible: boolean;
  onToggleExplorer: () => void;
}

function ActivityBar({ explorerVisible, onToggleExplorer }: ActivityBarProps) {
  const taskCenterOpen = useTaskStore((s) => s.taskCenterOpen);
  const taskRunning = useTaskStore((s) => s.taskStatus === "running");
  const toggleTaskCenter = useTaskStore((s) => s.toggleTaskCenter);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const openSettings = useConfigStore((s) => s.openSettings);
  const closeSettings = useConfigStore((s) => s.closeSettings);

  const handleExplorer = () => {
    if (settingsOpen) closeSettings();
    onToggleExplorer();
  };

  const handleTasks = () => {
    if (settingsOpen) closeSettings();
    toggleTaskCenter();
  };

  return (
    <nav className="activity-bar" aria-label="活动栏">
      <div className="activity-bar-top">
        <button
          type="button"
          className={
            explorerVisible ? "activity-bar-button active" : "activity-bar-button"
          }
          title="资源管理器"
          onClick={handleExplorer}
        >
          <ExplorerIcon />
        </button>
        <button
          type="button"
          className={
            taskCenterOpen ? "activity-bar-button active" : "activity-bar-button"
          }
          title={taskRunning ? "任务（运行中）" : "任务"}
          onClick={handleTasks}
        >
          <TasksIcon />
        </button>
      </div>
      <div className="activity-bar-bottom">
        <button
          type="button"
          className={
            settingsOpen ? "activity-bar-button active" : "activity-bar-button"
          }
          title="设置"
          onClick={() => (settingsOpen ? closeSettings() : openSettings())}
        >
          <SettingsIcon />
        </button>
      </div>
    </nav>
  );
}

export default ActivityBar;