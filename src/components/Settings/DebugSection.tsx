import { useEditorStore } from "../../stores/editorStore";
import { useConfigStore, ensureUserConfigFile } from "../../stores/configStore";

/**
 * Debug settings.
 *
 * There is no debug form on purpose: adapters and launch arguments are
 * per-language and richer than a handful of inputs can express, so they live in
 * `user.json` (the real global config the app reads). This section only opens
 * that file — the same way the Tasks section opens `tasks.json` — reusing
 * `editorStore.openGlobalFile`, so the Debug Core stays config-driven and no
 * second configuration schema exists.
 */

/** Only used if the file cannot be created; a valid empty JSON object. */
const USER_FALLBACK = "{}\n";

function DebugSection() {
  const closeSettings = useConfigStore((s) => s.closeSettings);

  const openUserJson = async () => {
    // Create the global user.json through the normal config path when it does
    // not exist yet, then open that same file in the editor.
    await ensureUserConfigFile();
    await useEditorStore
      .getState()
      .openGlobalFile("user.json", USER_FALLBACK);
    // Return to the editor so the file is visible right away.
    closeSettings();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">调试</h3>
      <p className="settings-detail">
        调试适配器和启动配置保存在全局配置文件 user.json 中。
      </p>
      <div className="settings-field settings-row">
        <button type="button" className="settings-button" onClick={openUserJson}>
          打开 user.json
        </button>
      </div>
    </div>
  );
}

export default DebugSection;
