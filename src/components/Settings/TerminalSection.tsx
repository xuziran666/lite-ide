import { useEffect } from "react";
import { useConfigStore, loadShells } from "../../stores/configStore";

function shellLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TerminalSection() {
  const terminal = useConfigStore((s) => s.terminal);
  const shells = useConfigStore((s) => s.shells);
  const updateTerminal = useConfigStore((s) => s.updateTerminal);

  // Refresh the detected shell list whenever the section is opened.
  useEffect(() => {
    void loadShells(true);
  }, []);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">终端</h3>
      <label className="settings-field settings-row">
        <span className="settings-label">默认终端外壳</span>
        <select
          className="settings-select"
          value={terminal.defaultShell}
          onChange={(e) => void updateTerminal({ defaultShell: e.target.value })}
        >
          <option value="auto">自动检测</option>
          {shells.map((shell) => (
            <option key={shell} value={shell}>
              {shellLabel(shell)}（{shell}）
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint">
        修改后仅对之后新建的终端生效，当前已打开的终端不受影响。
      </p>
    </div>
  );
}

export default TerminalSection;