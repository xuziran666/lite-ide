import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useEditorStore } from "../../stores/editorStore";
import { useConfigStore } from "../../stores/configStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { getModel } from "../../editor/modelStore";
import {
  autoSaveOnFocusChange,
  autoSaveOnWindowChange,
  cancelAutoSave,
  scheduleAutoSave,
} from "../../utils/autoSave";

function Editor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activePath = useEditorStore((s) => s.activePath);
  const error = useEditorStore((s) => s.error);
  const externalNotice = useEditorStore((s) => s.externalNotice);
  const clearError = useEditorStore((s) => s.clearError);
  const dismissExternalNotice = useEditorStore((s) => s.dismissExternalNotice);
  const save = useEditorStore((s) => s.save);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      model: null,
      theme: useConfigStore.getState().editor.theme,
      automaticLayout: true,
      fontSize: 14,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "off",
    });
    editorRef.current = editor;

    const pushCursor = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        useEditorStore.getState().setCursorInfo(null);
        return;
      }
      const selection = editor.getSelection();
      useEditorStore.getState().setCursorInfo({
        line: position.lineNumber,
        column: position.column,
        selected: selection ? model.getValueLengthInRange(selection) : 0,
      });
    };

    let lastPush = 0;
    const pushCursorThrottled = () => {
      const now = performance.now();
      if (now - lastPush < 50) return;
      lastPush = now;
      pushCursor();
    };

    const subscriptions = [
      editor.onDidChangeCursorPosition(pushCursorThrottled),
      editor.onDidChangeCursorSelection(pushCursorThrottled),
      editor.onDidChangeModel(() => {
        // Bypass the throttle so switching files updates immediately.
        lastPush = 0;
        pushCursor();
      }),
      // Auto Save: re-arm the "After Delay" timer on every edit, and save when
      // the editor loses focus if "On Focus Change" is enabled.
      editor.onDidChangeModelContent(() => scheduleAutoSave()),
      editor.onDidBlurEditorWidget(() => autoSaveOnFocusChange()),
    ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = activePath ? getModel(activePath) : undefined;
    editor.setModel(model ?? null);
  }, [activePath]);

  // Hot-apply the editor settings from the Settings page. This only touches
  // display options; open models, tabs and cursor positions are preserved.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const apply = () => {
      const s = useConfigStore.getState();
      if (!s.loaded) return;
      // Theme is global in Monaco; set it once and every editor (current and
      // future) picks it up without recreating models/editors.
      monaco.editor.setTheme(s.editor.theme);
      editor.updateOptions({
        fontSize: s.editor.fontSize,
        tabSize: s.editor.tabSize,
        wordWrap: s.editor.wordWrap as "off" | "on" | "wordWrapColumn",
        minimap: { enabled: s.editor.minimap },
      });
    };
    apply();
    return useConfigStore.subscribe(apply);
  }, []);

  // Auto Save: the app window losing focus is one of the triggers.
  useEffect(() => {
    window.addEventListener("blur", autoSaveOnWindowChange);
    return () => window.removeEventListener("blur", autoSaveOnWindowChange);
  }, []);

  // Auto Save: drop any pending "After Delay" timer when the workspace changes,
  // so it can never save into the next workspace.
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  useEffect(() => () => cancelAutoSave(), [workspacePath]);

  // Editor: Mouse Wheel Zoom. Resizes the Monaco font (8..40, step 1) on
  // Ctrl/Cmd + wheel. The listener is scoped to the editor host so the
  // Explorer / Terminal / Sidebar are unaffected and no page zoom happens.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Swallow the event so neither the webview nor Monaco zoom/scrolls it.
      e.preventDefault();
      e.stopPropagation();
      const store = useConfigStore.getState();
      if (!store.editor.mouseWheelZoom) return;
      const step = e.deltaY > 0 ? -1 : 1;
      const next = Math.min(40, Math.max(8, store.editor.fontSize + step));
      if (next !== store.editor.fontSize) {
        void store.updateEditor({ fontSize: next });
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () =>
      host.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        if (useConfigStore.getState().settingsOpen) return;
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  return (
    <div className="editor-pane">
      {error && (
        <div className="editor-error-bar">
          <span className="editor-error-text">{error}</span>
          <button type="button" className="editor-error-close" onClick={clearError}>
            关闭
          </button>
        </div>
      )}
      {externalNotice && externalNotice.length > 0 && (
        <div className="editor-external-bar">
          <span className="editor-error-text">
            {externalNotice.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </span>
          <button
            type="button"
            className="editor-error-close"
            onClick={dismissExternalNotice}
          >
            关闭
          </button>
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
      {!activePath && <div className="editor-empty">点击左侧文件以打开</div>}
    </div>
  );
}

export default Editor;