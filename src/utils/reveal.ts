import * as monaco from "monaco-editor";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getModel } from "../editor/modelStore";
import {
  canonicalPath,
  isPathInsideWorkspace,
  matchingOpenPath,
  resolveAgainstWorkspace,
} from "./pathIdentity";

/**
 * Open a file and move the single Monaco editor to the given position (or just
 * bring it to the front when no line is given). Used by Quick Open, Global
 * Search, Problems, Outline, the LSP definition jump, Find References and the
 * debug navigation (call stack / stopped location).
 *
 * This is the single navigation entry point. It resolves workspace-relative
 * input, canonicalizes the path, and then:
 *
 * 1. **reuses an already-open tab or model** — no read at all, so unsaved state
 *    is preserved and a redundant read is never attempted;
 * 2. opens a workspace file normally (through `openFile`, which validates the
 *    workspace boundary);
 * 3. for an external source, opens it only when it really is readable. A source
 *    that cannot be resolved — a lldb-dap synthetic `module\`symbol` path, a
 *    library frame whose source is not on disk, or any unreadable target — is a
 *    **silent no-op**: no tab, no `editorStore.error`, no "Failed to resolve
 *    file". This is what keeps a call-stack click into libc from surfacing an
 *    error while leaving every real file's error handling intact.
 */
export async function openAndReveal(
  path: string,
  line?: number,
  column?: number,
): Promise<void> {
  const workspace = useWorkspaceStore.getState().workspacePath;
  const absolute = resolveAgainstWorkspace(path, workspace);
  const target = canonicalPath(absolute);

  const store = useEditorStore.getState();

  // 1) Already open as a tab: activate it and move, without reading.
  const openPath = matchingOpenPath(
    store.openFiles.map((tab) => tab.path),
    target,
  );
  if (openPath) {
    if (store.activePath !== openPath) store.setActive(openPath);
    revealInEditor(openPath, line, column);
    return;
  }

  // 1b) Open as a model without a tab (e.g. an LSP hover preview): reuse it.
  if (getModel(target)) {
    revealInEditor(target, line, column);
    return;
  }

  // 2) Workspace file: normal open, normal errors.
  if (isPathInsideWorkspace(target, workspace)) {
    await store.openFile(target);
    revealInEditor(target, line, column);
    return;
  }

  // 3) External source: navigate only if it actually opens. Otherwise do
  //    nothing (and set no error) — see the doc comment above.
  const opened = await useEditorStore
    .getState()
    .openExternalFile(target, { quiet: true });
  if (opened) {
    revealInEditor(target, line, column);
  }
}

/** Move the editor to a model that is already loaded; never reads anything. */
function revealInEditor(
  path: string,
  line?: number,
  column?: number,
): void {
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
