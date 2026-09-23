import { useEditorStore } from "../../stores/editorStore";
import { useConfigStore } from "../../stores/configStore";

const TASKS_FALLBACK = '{\n  "tasks": []\n}\n';

function TasksSection() {
  const closeSettings = useConfigStore((s) => s.closeSettings);

  const openTasksJson = async () => {
    await useEditorStore
      .getState()
      .openGlobalFile("tasks.json", TASKS_FALLBACK);
    // Return to the editor so the file is visible right away.
    closeSettings();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">任务</h3>
      <p className="settings-detail">
        任务列表保存在全局配置文件 tasks.json 中，与 user.json 位于同一目录。
        可通过内置编辑器打开并编辑它；保存后需要重启应用才会生效。
      </p>
      <div className="settings-field settings-row">
        <button type="button" className="settings-button" onClick={openTasksJson}>
          打开 tasks.json
        </button>
      </div>
    </div>
  );
}

export default TasksSection;