import { useConfigStore } from "../../stores/configStore";

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const handleChange = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    onChange(Math.min(Math.max(parsed, min), max));
  };
  return (
    <label className="settings-field settings-row">
      <span className="settings-label">{label}</span>
      <input
        type="number"
        className="settings-input"
        value={value}
        min={min}
        max={max}
        onChange={(e) => handleChange(e.target.value)}
      />
    </label>
  );
}

function EditorSection() {
  const editor = useConfigStore((s) => s.editor);
  const updateEditor = useConfigStore((s) => s.updateEditor);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">编辑器</h3>
      <NumberField
        label="字号"
        value={editor.fontSize}
        min={6}
        max={64}
        onChange={(fontSize) => void updateEditor({ fontSize })}
      />
      <NumberField
        label="制表符大小"
        value={editor.tabSize}
        min={1}
        max={16}
        onChange={(tabSize) => void updateEditor({ tabSize })}
      />
      <label className="settings-field settings-row">
        <span className="settings-label">自动换行</span>
        <select
          className="settings-select"
          value={editor.wordWrap}
          onChange={(e) => void updateEditor({ wordWrap: e.target.value })}
        >
          <option value="off">关闭</option>
          <option value="on">开启</option>
        </select>
      </label>
      <label className="settings-field settings-check">
        <span className="settings-check-text">
          <span className="settings-label">显示缩略图</span>
          <span className="settings-detail">在右侧显示代码概览缩略图。</span>
        </span>
        <input
          type="checkbox"
          checked={editor.minimap}
          onChange={(e) => void updateEditor({ minimap: e.target.checked })}
        />
      </label>
      <p className="settings-hint">以上修改会立即应用到当前已打开的编辑器。</p>
    </div>
  );
}

export default EditorSection;