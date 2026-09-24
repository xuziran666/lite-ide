import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import type { EditorSettings } from "../../commands";
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

/** Exactly what `editor.updateOptions()` accepts: per-editor + global options. */
type MonacoEditorOptions = monaco.editor.IEditorOptions &
  monaco.editor.IGlobalEditorOptions;

/** Every Monaco option mirrored from `editor.*` in user.json. */
const MONACO_OPTION_KEYS = [
  "fontFamily",
  "fontSize",
  "fontLigatures",
  "tabSize",
  "wordWrap",
  "minimap",
  "lineNumbers",
  "renderWhitespace",
  "renderLineHighlight",
  "guides",
  "folding",
  "matchBrackets",
  "smoothScrolling",
  "cursorStyle",
  "cursorBlinking",
  "formatOnPaste",
  "formatOnType",
  "autoClosingBrackets",
  "autoClosingQuotes",
  "autoSurround",
  "trimAutoWhitespace",
  "dragAndDrop",
  "copyWithSyntaxHighlighting",
  "bracketPairColorization",
] as const;

/** The full Monaco option set for one `editor` configuration. */
function monacoOptions(editor: EditorSettings): MonacoEditorOptions {
  return {
    fontFamily: editor.fontFamily,
    fontSize: editor.fontSize,
    fontLigatures: editor.fontLigatures,
    tabSize: editor.tabSize,
    wordWrap: editor.wordWrap as "off" | "on" | "wordWrapColumn",
    minimap: { enabled: editor.minimap },
    lineNumbers: editor.lineNumbers,
    renderWhitespace: editor.renderWhitespace,
    renderLineHighlight: editor.renderLineHighlight,
    guides: { indentation: editor.guides.indentation },
    folding: editor.folding,
    matchBrackets: editor.matchBrackets,
    smoothScrolling: editor.smoothScrolling,
    cursorStyle: editor.cursorStyle,
    cursorBlinking: editor.cursorBlinking,
    formatOnPaste: editor.formatOnPaste,
    formatOnType: editor.formatOnType,
    autoClosingBrackets: editor.autoClosingBrackets,
    autoClosingQuotes: editor.autoClosingQuotes,
    autoSurround: editor.autoSurround,
    trimAutoWhitespace: editor.trimAutoWhitespace,
    dragAndDrop: editor.dragAndDrop,
    copyWithSyntaxHighlighting: editor.copyWithSyntaxHighlighting,
    bracketPairColorization: {
      enabled: editor.bracketPairColorization.enabled,
    },
  };
}

/**
 * Options whose Monaco value lives in a nested object: they are compared
 * through that sub-field so a patch only ever carries what really changed.
 */
const NESTED_OPTION_VALUES: Partial<
  Record<(typeof MONACO_OPTION_KEYS)[number], (o: MonacoEditorOptions) => unknown>
> = {
  minimap: (o) => o.minimap?.enabled,
  guides: (o) => o.guides?.indentation,
  bracketPairColorization: (o) => o.bracketPairColorization?.enabled,
};

/**
 * Only the options whose Monaco value actually changed, so a settings edit
 * touches nothing else: editing `cursorStyle` must not re-apply the font, and
 * the theme (handled separately with `setTheme`) is never part of this patch.
 */
function changedMonacoOptions(
  prev: EditorSettings,
  next: EditorSettings,
): MonacoEditorOptions {
  const before = monacoOptions(prev);
  const after = monacoOptions(next);
  const patch: Record<string, unknown> = {};
  for (const key of MONACO_OPTION_KEYS) {
    const read = NESTED_OPTION_VALUES[key];
    const same = read
      ? read(before) === read(after)
      : Object.is(before[key], after[key]);
    if (!same) {
      patch[key] = after[key];
    }
  }
  return patch as MonacoEditorOptions;
}

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
  // display options; open models, tabs, undo history, cursors and scroll
  // positions are preserved, and the editor itself is never recreated.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const applyAll = (state: ReturnType<typeof useConfigStore.getState>) => {
      // Theme is global in Monaco; set it once and every editor (current and
      // future) picks it up without recreating models/editors.
      monaco.editor.setTheme(state.editor.theme);
      editor.updateOptions(monacoOptions(state.editor));
    };

    const initial = useConfigStore.getState();
    if (initial.loaded) applyAll(initial);

    // Per-field application: only a theme change runs `setTheme` (which rebuilds
    // token colors), and every other option is pushed on its own, so editing one
    // setting never re-applies the rest.
    return useConfigStore.subscribe((state, prev) => {
      if (!state.loaded) return;
      if (!prev.loaded) {
        applyAll(state);
        return;
      }
      if (state.editor.theme !== prev.editor.theme) {
        monaco.editor.setTheme(state.editor.theme);
      }
      const patch = changedMonacoOptions(prev.editor, state.editor);
      if (Object.keys(patch).length > 0) {
        editor.updateOptions(patch);
      }
    });
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