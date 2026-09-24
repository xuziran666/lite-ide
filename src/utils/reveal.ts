import * as monaco from "monaco-editor";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getModel } from "../editor/modelStore";
import {
  canonicalPath,
  isPathInsideWorkspace,
  resolveAgainstWorkspace,
} from "./pathIdentity";

/**
 * Open a file and move the single Monaco editor to the given position (or just
 * bring it to the front when no line is given). Used by Quick Open, Global
 * Search, Problems, Outline, the LSP definition jump and Find References.
 *
 * This is the single navigation entry point: it resolves workspace-relative
 * input, canonicalizes the path, decides workspace-internal vs external, and
 * delegates to the editor store — which guarantees exactly one tab and one
 * Monaco model per canonical file, so a file opened here reuses whatever the
 * file tree / another feature already opened.
 */
export async function openAndReveal(
  path: string,
  line?: number,
  column?: number,
): Promise<void> {
  const workspace = useWorkspaceStore.getState().workspacePath;
  const absolute = resolveAgainstWorkspace(path, workspace);
  const target = canonicalPath(absolute);

  if (isPathInsideWorkspace(target, workspace)) {
    await useEditorStore.getState().openFile(target);
  } else {
    await useEditorStore.getState().openExternalFile(target);
  }

  const editor = monaco.editor.getEditors()[0];
  const model = getModel(target);
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
