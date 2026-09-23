import { useEffect, useState } from "react";
import { useTaskStore } from "../../stores/taskStore";

/** Dropdown listing the workspace tasks. Rendered only while it is open (the
 * global shortcut handler skips everything else while it is). */
function TaskCenter() {
  const tasks = useTaskStore((s) => s.tasks);
  const tasksError = useTaskStore((s) => s.tasksError);
  const loading = useTaskStore((s) => s.loading);
  const taskStatus = useTaskStore((s) => s.taskStatus);
  const activeTaskName = useTaskStore((s) => s.activeTaskName);
  const runTask = useTaskStore((s) => s.runTask);
  const closeTaskCenter = useTaskStore((s) => s.closeTaskCenter);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [tasks]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelected((s) => Math.min(s + 1, Math.max(tasks.length - 1, 0)));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelected((s) => Math.max(s - 1, 0));
          break;
        case "Enter": {
          e.preventDefault();
          const task = tasks[selected];
          if (task) void runTask(task.name);
          break;
        }
        case "Escape":
          e.preventDefault();
          closeTaskCenter();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tasks, selected, runTask, closeTaskCenter]);

  return (
    <div className="task-center" role="menu">
      <div className="task-center-header">任务</div>
      <div className="task-center-list">
        {loading && tasks.length === 0 && (
          <div className="task-center-empty">加载中…</div>
        )}
        {!loading && tasksError && (
          <div className="task-center-error">{tasksError}</div>
        )}
        {!loading && !tasksError && tasks.length === 0 && (
          <div className="task-center-empty">暂无任务</div>
        )}
        {tasks.map((task, idx) => {
          const running =
            taskStatus === "running" && activeTaskName === task.name;
          return (
            <button
              key={task.name}
              type="button"
              role="menuitem"
              className={
                idx === selected ? "task-center-item selected" : "task-center-item"
              }
              onClick={() => void runTask(task.name)}
              onMouseEnter={() => setSelected(idx)}
            >
              <span
                className={
                  running
                    ? "task-center-icon task-center-status-running"
                    : "task-center-icon"
                }
              >
                {running ? "●" : "▶"}
              </span>
              <span className="task-center-name">{task.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TaskCenter;