import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useEditorStore } from "../../stores/editorStore";
import { getModel } from "../../editor/modelStore";

function Editor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activePath = useEditorStore((s) => s.activePath);
  const error = useEditorStore((s) => s.error);
  const clearError = useEditorStore((s) => s.clearError);
  const save = useEditorStore((s) => s.save);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      model: null,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 14,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "off",
    });
    editorRef.current = editor;

    return () => {
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
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
      <div className="editor-host" ref={hostRef} />
      {!activePath && <div className="editor-empty">点击左侧文件以打开</div>}
    </div>
  );
}

export default Editor;