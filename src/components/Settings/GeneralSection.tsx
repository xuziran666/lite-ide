import { useConfigStore } from "../../stores/configStore";

const THEME_OPTIONS: { value: string; label: string }[] = [
  { value: "dark", label: "暗色" },
  { value: "light", label: "亮色" },
  { value: "system", label: "跟随系统" },
];

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

function GeneralSection() {
  const general = useConfigStore((s) => s.general);
  const updateGeneral = useConfigStore((s) => s.updateGeneral);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">通用</h3>
      <CheckField
        label="恢复上次打开的文件夹"
        detail="启动时自动打开上一次的工作目录。修改后将在下一次启动时生效。"
        checked={general.restoreLastWorkspace}
        onChange={(value) => void updateGeneral({ restoreLastWorkspace: value })}
      />
      <CheckField
        label="关闭时确认未保存的更改"
        detail="关闭应用前若有未保存的编辑会弹出确认。关闭后不再询问。"
        checked={general.confirmBeforeClose}
        onChange={(value) => void updateGeneral({ confirmBeforeClose: value })}
      />
      <label className="settings-field settings-row">
        <span className="settings-label">主题</span>
        <select
          className="settings-select"
          value={general.theme}
          onChange={(e) => void updateGeneral({ theme: e.target.value })}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default GeneralSection;