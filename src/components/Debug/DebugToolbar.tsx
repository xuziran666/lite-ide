import { useDebugStore } from "../../stores/debugStore";
import { startDebugging } from "../../debug/session";
import { useEditorStore } from "../../stores/editorStore";
import { requestKindOf } from "../../debug/launchConfig";
import { debugLaunchFor } from "../../stores/configStore";

/**
 * The Run and Debug sidebar's start control.
 *
 * It only starts a session; the session controls (pause/continue/step/restart/
 * stop) live in the floating toolbar over the editor, exactly as VS Code splits
 * the "Run and Debug" view from the in-editor session toolbar. While a session
 * is live this shows a short status line instead of the buttons, so there is
 * never a second, competing set of run controls.
 */
export default function DebugToolbar() {
  const status = useDebugStore((s) => s.session.status);
  const adapter = useDebugStore((s) => s.session.adapter);
  const stopReason = useDebugStore((s) => s.session.stopReason);
  const error = useDebugStore((s) => s.session.error);

  const starting = status === "starting";
  // The floating toolbar owns the controls while a session is live; the sidebar
  // then shows only a status line. `starting` still shows the (disabled) Start
  // so the pending action stays visible in place.
  const live = status === "running" || status === "stopped";

  const activeLanguage = useEditorStore((s) => {
    const tab = s.openFiles.find((file) => file.path === s.activePath);
    return tab?.language;
  });
  const configuredKind = activeLanguage
    ? requestKindOf(debugLaunchFor(activeLanguage))
    : "launch";

  return (
    <div className="debug-toolbar">
      {!live ? (
        <div className="debug-toolbar-buttons">
          <button
            type="button"
            className="debug-button primary"
            title={
              activeLanguage
                ? `${configuredKind === "attach" ? "附加到" : "启动"} ${activeLanguage}`
                : "当前文件没有可调试的语言"
            }
            disabled={starting || !activeLanguage}
            onClick={() => void startDebugging()}
          >
            {configuredKind === "attach" ? "🔗 附加" : "▶ 启动"}
          </button>
          {activeLanguage ? (
            <button
              type="button"
              className="debug-button"
              title={
                configuredKind === "attach"
                  ? "改为启动一个新进程"
                  : "改为附加到已运行的进程"
              }
              disabled={starting}
              onClick={() =>
                void startDebugging(
                  activeLanguage,
                  configuredKind === "attach" ? "launch" : "attach",
                )
              }
            >
              {configuredKind === "attach" ? "▶ 启动" : "🔗 附加"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="debug-toolbar-status">
        {error ? (
          <span className="debug-status error" title={error}>
            {error}
          </span>
        ) : status === "stopped" && stopReason ? (
          <span className="debug-status">{`已暂停：${stopReason}`}</span>
        ) : status === "running" ? (
          <span className="debug-status">运行中</span>
        ) : status === "starting" ? (
          <span className="debug-status">正在启动…</span>
        ) : null}
        {adapter ? (
          <span className="debug-adapter" title="当前调试适配器">
            {adapter}
          </span>
        ) : null}
      </div>
    </div>
  );
}
