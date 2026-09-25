import { useEffect, useState } from "react";
import { useConfigStore, loadShells } from "../../stores/configStore";

const DEFAULT_FONT_FAMILY =
  "Cascadia Mono, Consolas, \"Courier New\", monospace";

function shellLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TerminalSection() {
  const terminal = useConfigStore((s) => s.terminal);
  const shells = useConfigStore((s) => s.shells);
  const updateTerminal = useConfigStore((s) => s.updateTerminal);

  // Local draft so typing doesn't persist the config on every keystroke.
  const [fontDraft, setFontDraft] = useState(terminal.fontFamily);

  // Refresh the detected shell list whenever the section is opened.
  useEffect(() => {
    void loadShells(true);
  }, []);

  // Keep the draft in sync when the config is replaced (e.g. reload), but not
  // while the user is mid-edit (typing never persists, so the value only
  // changes here after an explicit commit).
  useEffect(() => {
    setFontDraft(terminal.fontFamily);
  }, [terminal.fontFamily]);

  const commitFontFamily = () => {
    const trimmed = fontDraft.trim();
    void updateTerminal({
      fontFamily: trimmed === "" ? DEFAULT_FONT_FAMILY : trimmed,
    });
  };

  const handleFontSize = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    void updateTerminal({ fontSize: Math.min(Math.max(parsed, 8), 40) });
  };

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
      <label className="settings-field settings-row">
        <span className="settings-label">字体</span>
        <input
          type="text"
          className="settings-input"
          spellCheck={false}
          placeholder={DEFAULT_FONT_FAMILY}
          value={fontDraft}
          onChange={(e) => setFontDraft(e.target.value)}
          onBlur={commitFontFamily}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <label className="settings-field settings-row">
        <span className="settings-label">字号</span>
        <input
          type="number"
          className="settings-input"
          value={terminal.fontSize}
          min={8}
          max={40}
          onChange={(e) => handleFontSize(e.target.value)}
        />
      </label>
      <p className="settings-hint">
        字体和字号修改会立即应用到已打开的终端。
      </p>
    </div>
  );
}

export default TerminalSection;