import { useState } from "react";
import { useConfigStore } from "../../stores/configStore";
import GeneralSection from "./GeneralSection";
import EditorSection from "./EditorSection";
import TerminalSection from "./TerminalSection";
import TasksSection from "./TasksSection";
import KeyboardSection from "./KeyboardSection";

type SettingsSection =
  | "general"
  | "editor"
  | "terminal"
  | "tasks"
  | "keyboard";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "editor", label: "编辑器" },
  { id: "terminal", label: "终端" },
  { id: "tasks", label: "任务" },
  { id: "keyboard", label: "键盘快捷键" },
];

function SettingsView() {
  const [section, setSection] = useState<SettingsSection>("general");
  const closeSettings = useConfigStore((s) => s.closeSettings);

  return (
    <div className="settings-view">
      <div className="settings-header">
        <button
          type="button"
          className="settings-back"
          onClick={closeSettings}
          title="返回编辑器"
        >
          ◀ 返回编辑器
        </button>
        <span className="settings-title">设置</span>
      </div>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分类">
          {SECTIONS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={
                section === item.id
                  ? "settings-nav-item active"
                  : "settings-nav-item"
              }
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "general" && <GeneralSection />}
          {section === "editor" && <EditorSection />}
          {section === "terminal" && <TerminalSection />}
          {section === "tasks" && <TasksSection />}
          {section === "keyboard" && <KeyboardSection />}
        </div>
      </div>
    </div>
  );
}

export default SettingsView;