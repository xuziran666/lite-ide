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
    <svg
      width="20"
      height="20"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" />
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.892-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z" />
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