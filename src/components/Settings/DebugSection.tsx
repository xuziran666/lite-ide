import { useEditorStore } from "../../stores/editorStore";
import { useConfigStore, ensureUserConfigFile } from "../../stores/configStore";

/**
 * Debug settings.
 *
 * There is no debug form on purpose: adapters and launch arguments are
 * per-language and richer than a handful of inputs can express, so they live in
 * real files in the app config directory. This section only opens them — the
 * same way the Tasks section opens `tasks.json` — reusing
 * `editorStore.openGlobalFile`, so the Debug Core stays config-driven and no
 * second configuration schema exists.
 *
 * The two files answer different questions and must not be merged into one:
 * `user.json`'s `debug.adapters` says how to start the *adapter*
 * (`"cpp-gdb": { "command": "gdb", "args": ["-i", "dap"] }`), while
 * `launch.json` says how to start *the program* (which `type`, `program`, args,
 * cwd, env).
 */

/** Only used if the file cannot be created; a valid, empty debug section. */
const USER_FALLBACK = "{}\n";

/** A valid, empty global launch file, so the editor opens something usable. */
const LAUNCH_FALLBACK = `{
  "version": "0.2.0",
  "configurations": []
}
`;

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

  const openLaunchJson = async () => {
    await useEditorStore
      .getState()
      .openGlobalFile("launch.json", LAUNCH_FALLBACK);
    closeSettings();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">调试</h3>
      <p className="settings-detail">
        调试适配器保存在全局配置文件 user.json 中，启动配置保存在同目录的
        launch.json 中。保存后需要重启应用才会生效。
      </p>
      <div className="settings-field settings-row">
        <button type="button" className="settings-button" onClick={openUserJson}>
          打开 user.json
        </button>
        <button type="button" className="settings-button" onClick={openLaunchJson}>
          打开 launch.json
        </button>
      </div>
    </div>
  );
}

export default DebugSection;
