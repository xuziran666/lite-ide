import { useConfigStore } from "../../stores/configStore";

type BoolKey = "afterDelay" | "onFocusChange" | "onWindowChange";

function CheckField({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-field settings-check">
      <span className="settings-check-text">
        <span className="settings-label">{label}</span>
        <span className="settings-detail">{detail}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function FilesSection() {
  const autoSave = useConfigStore((s) => s.files.autoSave);
  const updateAutoSave = useConfigStore((s) => s.updateAutoSave);

  const off =
    !autoSave.afterDelay && !autoSave.onFocusChange && !autoSave.onWindowChange;

  const toggle = (key: BoolKey, value: boolean) => {
    void updateAutoSave({ [key]: value } as Partial<typeof autoSave>);
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">文件</h3>
      <p className="settings-detail">
        控制具有未保存更改的编辑器的自动保存。Off 与其他选项互斥，三个触发条件可同时启用。
      </p>
      <CheckField
        label="Off"
        detail="关闭自动保存（取消下面全部触发条件）。"
        checked={off}
        onChange={(value) => {
          if (value) {
            void updateAutoSave({
              afterDelay: false,
              onFocusChange: false,
              onWindowChange: false,
            });
          }
        }}
      />
      <CheckField
        label="After Delay"
        detail="编辑停止一段时间后自动保存。"
        checked={autoSave.afterDelay}
        onChange={(value) => toggle("afterDelay", value)}
      />
      <CheckField
        label="On Focus Change"
        detail="编辑器失去焦点时自动保存。"
        checked={autoSave.onFocusChange}
        onChange={(value) => toggle("onFocusChange", value)}
      />
      <CheckField
        label="On Window Change"
        detail="应用窗口失去焦点时自动保存。"
        checked={autoSave.onWindowChange}
        onChange={(value) => toggle("onWindowChange", value)}
      />
      {autoSave.afterDelay && (
        <label className="settings-field settings-row">
          <span className="settings-label">Auto Save Delay (ms)</span>
          <input
            type="number"
            className="settings-input"
            value={autoSave.delay}
            min={100}
            max={60000}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(parsed)) return;
              void updateAutoSave({
                delay: Math.min(Math.max(parsed, 100), 60000),
              });
            }}
          />
        </label>
      )}
    </div>
  );
}

export default FilesSection;
