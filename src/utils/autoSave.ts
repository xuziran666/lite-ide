import { useConfigStore } from "../stores/configStore";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Auto Save wiring. A tiny helper (not a manager): it reuses the existing
 * `editorStore.saveAll` (which only persists dirty tabs and keeps a tab dirty
 * when its save fails) and the `files.autoSave` settings. Each trigger is
 * independent — any enabled trigger that fires saves the dirty editors.
 */

let delayTimer: number | undefined;

function hasDirty(): boolean {
  return useEditorStore.getState().openFiles.some((tab) => tab.dirty);
}

/** Persist every dirty editor (no-op when nothing is dirty). */
export async function autoSaveDirty(): Promise<void> {
  if (!hasDirty()) return;
  await useEditorStore.getState().saveAll();
}

/** "After Delay": (re)arm the debounce after an edit. */
export function scheduleAutoSave(): void {
  const autoSave = useConfigStore.getState().files.autoSave;
  if (!autoSave.afterDelay || !hasDirty()) return;

  cancelAutoSave();
  const workspace = useWorkspaceStore.getState().workspacePath;
  delayTimer = window.setTimeout(() => {
    delayTimer = undefined;
    // Skip when the setting was turned off or the workspace switched while
    // waiting, so a stale timer never saves into the wrong workspace.
    if (!useConfigStore.getState().files.autoSave.afterDelay) return;
    if (useWorkspaceStore.getState().workspacePath !== workspace) return;
    void autoSaveDirty();
  }, autoSave.delay);
}

export function cancelAutoSave(): void {
  if (delayTimer !== undefined) {
    window.clearTimeout(delayTimer);
    delayTimer = undefined;
  }
}

/** "On Focus Change": the Monaco editor lost focus. */
export function autoSaveOnFocusChange(): void {
  if (!useConfigStore.getState().files.autoSave.onFocusChange) return;
  void autoSaveDirty();
}

/** "On Window Change": the app window lost focus. */
export function autoSaveOnWindowChange(): void {
  if (!useConfigStore.getState().files.autoSave.onWindowChange) return;
  void autoSaveDirty();
}
