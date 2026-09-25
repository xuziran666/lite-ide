import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useDiffStore } from "../../stores/diffStore";
import { useConfigStore } from "../../stores/configStore";
import { languageForPath } from "../../utils/language";
import {
  changedMonacoOptions,
  monacoOptions,
} from "../Editor/Editor";

/** A model for one side of the diff. The `diff` scheme URI keeps these models
 *  out of the file modelStore entirely, so a diff can never affect an open
 *  tab's model, dirty state or undo history. */
function createDiffModel(text: string, label: string, path: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({
    scheme: "diff",
    authority: encodeURIComponent(label),
    path: "/" + path.replace(/\\/g, "/"),
  });
  return monaco.editor.createModel(text, languageForPath(path), uri);
}

/** The temporary Git diff view. It overlays the code editor while open and owns
 *  its own Monaco diff editor + diff-side models, which are disposed when it
 *  closes — the normal editor instance, its tabs and modelStore are untouched. */
function DiffView() {
  const diff = useDiffStore((s) => s.diff);
  const close = useDiffStore((s) => s.close);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<monaco.editor.ITextModel[]>([]);

  // Create the diff editor once per mount and keep it hot-applyable to the
  // Settings page (theme + display options) exactly like the code editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.createDiffEditor(host, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      renderOverviewRuler: true,
      theme: useConfigStore.getState().editor.theme,
    });
    editor.updateOptions(monacoOptions(useConfigStore.getState().editor));
    editorRef.current = editor;

    const unsubscribe = useConfigStore.subscribe((state, prev) => {
      if (!state.loaded) return;
      if (state.editor.theme !== prev.editor.theme) {
        monaco.editor.setTheme(state.editor.theme);
      }
      const patch = changedMonacoOptions(prev.editor, state.editor);
      if (Object.keys(patch).length > 0) {
        editor.updateOptions(patch);
      }
    });

    return () => {
      unsubscribe();
      editor.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current) {
        if (!model.isDisposed()) model.dispose();
      }
      modelsRef.current = [];
    };
  }, []);

  // Close the diff with Esc (there is no editable text to lose, so stealing the
  // key while the diff is open is safe).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useDiffStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Feed the fetched content into the diff editor. Every new `content` object
  // (a new open) disposes the previous models before recreating them.
  const content = diff?.content ?? null;
  const diffPath = diff?.path ?? "";
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    for (const model of modelsRef.current) {
      if (!model.isDisposed()) model.dispose();
    }
    modelsRef.current = [];

    if (content && diff) {
      const original = createDiffModel(content.original, content.originalLabel, diffPath);
      const modified = createDiffModel(content.modified, content.modifiedLabel, diffPath);
      modelsRef.current = [original, modified];
      editor.setModel({ original, modified });
    } else {
      editor.setModel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  if (!diff) return null;

  const title = `${diff.path}${diff.loading ? " — 正在读取…" : " — Diff"}`;

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-title" title={diff.path}>
          {title}
        </span>
        {!diff.loading && !diff.error && diff.content && (
          <span className="diff-subtitle">
            {diff.originalLabel} → {diff.modifiedLabel}
          </span>
        )}
        <span className="diff-spacer" />
        <button type="button" className="diff-close" title="关闭 Diff (Esc)" onClick={close}>
          关闭
        </button>
      </div>
      <div className="diff-body">
        <div className="diff-host" ref={hostRef} />
        {diff.error && (
          <div className="diff-cover">
            <span className="diff-cover-text">{diff.error}</span>
            <button type="button" className="sc-icon-button" onClick={close}>
              关闭
            </button>
          </div>
        )}
        {!diff.error && diff.content?.binary && (
          <div className="diff-cover">
            <span className="diff-cover-text">该文件是二进制文件，无法在 Diff 中显示。</span>
            <button type="button" className="sc-icon-button" onClick={close}>
              关闭
            </button>
          </div>
        )}
        {!diff.error && diff.loading && <div className="diff-cover">
          <span className="diff-cover-text">正在读取文件内容…</span>
        </div>}
      </div>
    </div>
  );
}

export default DiffView;