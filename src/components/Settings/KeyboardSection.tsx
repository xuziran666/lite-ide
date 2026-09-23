import { useEffect, useRef, useState } from "react";
import { useConfigStore } from "../../stores/configStore";
import { useUiStore } from "../../stores/uiStore";
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_LABELS,
  chordFromEvent,
  isDoubleCtrlChord,
  isUsableShortcut,
  type KeybindingAction,
} from "../../config/keybindings";

const DOUBLE_CTRL_WINDOW = 300;

function displayChord(chord: string): string {
  return isDoubleCtrlChord(chord) ? "按 Ctrl 两次" : chord;
}

function KeyboardSection() {
  const keybindings = useConfigStore((s) => s.keybindings);
  const saveKeybinding = useConfigStore((s) => s.saveKeybinding);
  const showToast = useUiStore((s) => s.showToast);
  const [recording, setRecording] = useState<KeybindingAction | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const lastCtrlPress = useRef(0);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(null);
        setHint(null);
        return;
      }

      // A double Ctrl press is recorded as the special Ctrl+Ctrl chord; it is
      // only meaningful for openTaskCenter.
      if (e.key === "Control") {
        if (e.repeat) return;
        const now = performance.now();
        if (now - lastCtrlPress.current <= DOUBLE_CTRL_WINDOW) {
          lastCtrlPress.current = 0;
          void finish("Ctrl+Ctrl");
        } else {
          lastCtrlPress.current = now;
        }
        return;
      }
      lastCtrlPress.current = 0;

      const chord = chordFromEvent(e);
      if (!chord) {
        setHint("请按下一个快捷键");
        return;
      }
      if (!isUsableShortcut(chord)) {
        setHint(
          chord.includes("Alt")
            ? "该快捷键不能包含 Alt"
            : "快捷键需要包含 Ctrl 或 Meta 键",
        );
        return;
      }
      void finish(chord);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const finish = async (chord: string) => {
    if (!recording) return;
    const action = recording;
    setRecording(null);
    setHint(null);

    const result = await saveKeybinding(action, chord);
    if (result.ok) return;
    if (chord === "Ctrl+Ctrl" && action !== "openTaskCenter") {
      showToast("Ctrl 连按仅可用于“打开任务中心”", "error");
      return;
    }
    if (result.conflict) {
      const label = KEYBINDING_LABELS[result.conflict];
      showToast(`“${label}”已在使用该快捷键`, "error");
      return;
    }
    showToast("该快捷键不可用", "error");
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">键盘快捷键</h3>
      <p className="settings-detail">
        点击右侧按钮开始录制：按下新的组合键即可保存并立即生效；按 Esc 取消录制。
      </p>
      {hint && <p className="settings-hint">{hint}</p>}
      <div className="kb-list">
        {KEYBINDING_ACTIONS.map((action) => {
          const isRecording = recording === action;
          return (
            <div className="kb-row" key={action}>
              <span className="kb-label">{KEYBINDING_LABELS[action]}</span>
              <span className="kb-chord">
                {isRecording
                  ? "请按新快捷键…"
                  : displayChord(keybindings[action])}
              </span>
              <button
                type="button"
                className={
                  isRecording ? "kb-record active" : "kb-record"
                }
                onClick={() => {
                  if (isRecording) {
                    setRecording(null);
                    setHint(null);
                    return;
                  }
                  lastCtrlPress.current = 0;
                  setHint(null);
                  setRecording(action);
                }}
              >
                {isRecording ? "取消" : "录制"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default KeyboardSection;