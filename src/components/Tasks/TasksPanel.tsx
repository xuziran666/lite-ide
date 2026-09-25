import { useEffect } from "react";
import { useTaskStore } from "../../stores/taskStore";

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.5 2.5v2.2h-2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Left-primary-sidebar task list (VS Code style). Reuses the shared taskStore
 *  and the normal task terminal; the TaskCenter dropdown stays untouched. */
function TasksPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const tasksError = useTaskStore((s) => s.tasksError);
  const loading = useTaskStore((s) => s.loading);
  const taskStatus = useTaskStore((s) => s.taskStatus);
  const activeTaskName = useTaskStore((s) => s.activeTaskName);
  const runTask = useTaskStore((s) => s.runTask);
  const refresh = useTaskStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel sc-panel">
      <div className="sc-header">
        <span className="sc-title">任务</span>
        <div className="sc-header-actions">
          <button
            type="button"
            className="sc-icon-button"
            title="刷新"
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className="sc-scroll">
        {loading && tasks.length === 0 && (
          <p className="sc-hint">加载中…</p>
        )}
        {!loading && tasksError && <p className="sc-error">{tasksError}</p>}
        {!loading && !tasksError && tasks.length === 0 && (
          <p className="sc-hint">暂无任务</p>
        )}
        {tasks.map((task) => {
          const running = taskStatus === "running" && activeTaskName === task.name;
          return (
            <div className="sc-row" key={task.name}>
              <button
                type="button"
                className="sc-row-open"
                title={`运行 ${task.name}`}
                onClick={() => void runTask(task.name)}
              >
                <span
                  className={
                    running ? "tasks-status tasks-status-running" : "tasks-status"
                  }
                >
                  {running ? "●" : "▶"}
                </span>
                <span className="sc-row-path">{task.name}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TasksPanel;