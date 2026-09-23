import * as monaco from "monaco-editor";
import { useEditorStore } from "../stores/editorStore";
import { getModel } from "../editor/modelStore";

/**
 * Open a file and move the single Monaco editor to the given position (or just
 * bring it to the front when no line is given). Used by Quick Open, Global
 * Search, Problems and Outline. A helper — not a manager, just wires the
 * existing editor store back to the editor instance.
 */
export async function openAndReveal(
  path: string,
  line?: number,
  column?: number,
): Promise<void> {
  await useEditorStore.getState().openFile(path);

  const editor = monaco.editor.getEditors()[0];
  const model = getModel(path);
  if (!editor || !model) return;

  if (editor.getModel() !== model) {
    editor.setModel(model);
  }
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: column ?? 1 });
  }
  editor.focus();
}