import * as monaco from "monaco-editor";
import type { EditorSettings } from "../../commands";

/** Exactly what `editor.updateOptions()` accepts: per-editor + global options. */
export type MonacoEditorOptions = monaco.editor.IEditorOptions &
  monaco.editor.IGlobalEditorOptions;

/** Every Monaco option mirrored from `editor.*` in user.json. */
export const MONACO_OPTION_KEYS = [
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
export function monacoOptions(editor: EditorSettings): MonacoEditorOptions {
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
export function changedMonacoOptions(
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
