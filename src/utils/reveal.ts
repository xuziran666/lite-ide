import * as monaco from "monaco-editor";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getModel } from "../editor/modelStore";

/**
 * Case-insensitive, verbatim-prefix-tolerant key for comparing local paths:
 * backslashes become slashes, a Windows extended-length (`\\?\`) or UNC
 * (`\\?\UNC`) prefix is stripped, and the result is lowercased.
 */
function pathKey(path: string): string {
  let key = path.replace(/\\/g, "/");
  const unc = key.match(/^\/\/\?\/?UNC\/(.*)$/i);
  if (unc) {
    key = "//" + unc[1];
  } else if (key.startsWith("//?")) {
    key = key.slice(4).replace(/^\/+/, "");
  }
  return key.toLowerCase();
}

/** Whether `path` lies inside the current workspace (or is the workspace). */
function isPathInsideWorkspace(path: string): boolean {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return false;
  const root = pathKey(ws);
  const needle = pathKey(path);
  return needle === root || needle.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Open a file and move the single Monaco editor to the given position (or just
 * bring it to the front when no line is given). Used by Quick Open, Global
 * Search, Problems, Outline and the LSP definition jump. A helper — not a
 * manager, just wires the existing editor store back to the editor instance.
 *
 * Files inside the workspace open through the normal `openFile` path; paths
 * outside it (e.g. a rust-analyzer definition in the standard library) open as
 * a read-only external tab.
 */
export async function openAndReveal(
  path: string,
  line?: number,
  column?: number,
): Promise<void> {
  if (isPathInsideWorkspace(path)) {
    await useEditorStore.getState().openFile(path);
  } else {
    await useEditorStore.getState().openExternalFile(path);
  }

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