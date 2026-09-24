import { create } from "zustand";
import type { CursorInfo, Tab } from "../types";
import {
  listDir,
  readFile,
  readExternalFile,
  readGlobalFile,
  writeFile,
  writeGlobalFile,
} from "../commands";
import * as modelStore from "../editor/modelStore";
import { useConfigStore } from "./configStore";
import { basename, dirname, joinPath, languageForPath } from "../utils/language";
import { canonicalPath, sameFile } from "../utils/pathIdentity";

/**
 * Tabs being closed in a batch (close others / close right / close all).
 * `dirtyTargets` holds the tabs that still need a save/discard decision, asked
 * one at a time through the existing confirm modal. `finalActive` is the active
 * path to apply once the whole batch finishes.
 */
interface PendingCloseQueue {
  anchor: string | null;
  dirtyTargets: string[];
  finalActive: string | null;
}

interface EditorStore {
  openFiles: Tab[];
  activePath: string | null;
  error: string | null;
  externalNotice: string[] | null;
  /** Dirty tab waiting for a save/discard decision before it can be closed. */
  pendingClosePath: string | null;
  /** Batch close state, null while only single-tab closes happen. */
  pendingCloseQueue: PendingCloseQueue | null;
  /** Recently closed tab paths, most recent first (LIFO). Never persisted. */
  closedTabs: string[];
  cursor: CursorInfo | null;
  openFile: (path: string) => Promise<void>;
  openGlobalFile: (name: string, fallbackContent?: string) => Promise<void>;
  /** Open a file from outside the workspace (e.g. an LSP definition jump into
   *  the standard library) as a read-only tab. Never dirty, never saveable. */
  openExternalFile: (path: string) => Promise<void>;
  setActive: (path: string) => void;
  closeTab: (path: string, record?: boolean) => void;
  closeMany: (
    paths: string[],
    record: boolean,
    activeOverride: string | null | undefined,
  ) => void;
  beginBatchClose: (
    anchor: string | null,
    targets: string[],
    finalActive: string | null,
  ) => void;
  requestCloseTab: (path: string) => void;
  confirmCloseTab: (saveChanges: boolean) => Promise<void>;
  cancelCloseTab: () => void;
  save: (path?: string) => Promise<boolean>;
  saveAll: () => Promise<boolean>;
  setCursorInfo: (info: CursorInfo | null) => void;
  markDirty: (path: string, dirty: boolean) => void;
  applyRename: (path: string, newPath: string) => void;
  applyDelete: (path: string) => void;
  onExternalChange: (paths: string[]) => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  closeOthers: (path: string) => void;
  closeRight: (path: string) => void;
  closeAll: () => void;
  restoreClosedTab: () => Promise<void>;
  clearError: () => void;
  dismissExternalNotice: () => void;
  reset: () => void;
}

/** Prepend a path to the closed-tab stack, dropping any older entry for it. */
function pushClosedTab(closedTabs: string[], path: string): string[] {
  return [path, ...closedTabs.filter((p) => p !== path)];
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openFiles: [],
  activePath: null,
  error: null,
  externalNotice: null,
  pendingClosePath: null,
  pendingCloseQueue: null,
  closedTabs: [],
  cursor: null,

  openFile: async (path: string) => {
    const target = canonicalPath(path);
    const existing = get().openFiles.find((t) => sameFile(t.path, target));
    if (existing) {
      set({ activePath: existing.path, error: null });
      return;
    }

    let content: string;
    try {
      content = await readFile(target);
    } catch (e) {
      set({ error: String(e) });
      return;
    }

    const raced = get().openFiles.find((t) => sameFile(t.path, target));
    if (raced) {
      set({ activePath: raced.path, error: null });
      return;
    }

    modelStore.createModel(target, content, (dirty) => {
      get().markDirty(target, dirty);
    });

    set((s) => ({
      openFiles: [
        ...s.openFiles,
        {
          path: target,
          name: basename(target),
          language: languageForPath(target),
          dirty: false,
        },
      ],
      activePath: target,
      error: null,
    }));
  },

  /// Open a global configuration file (e.g. `tasks.json`) from the app config
  /// directory. When it does not exist yet, it is opened with the given
  /// fallback content without being considered dirty.
  openGlobalFile: async (name, fallbackContent) => {
    const dir = useConfigStore.getState().configDir;
    if (!dir) {
      set({ error: "无法解析配置目录" });
      return;
    }
    const path = canonicalPath(joinPath(dir, name));
    const existing = get().openFiles.find((t) => sameFile(t.path, path));
    if (existing) {
      set({ activePath: existing.path, error: null });
      return;
    }

    let content: string;
    try {
      content = (await readGlobalFile(name)) ?? fallbackContent ?? "";
    } catch (e) {
      set({ error: String(e) });
      return;
    }

    const raced = get().openFiles.find((t) => sameFile(t.path, path));
    if (raced) {
      set({ activePath: raced.path, error: null });
      return;
    }

    modelStore.createModel(path, content, (dirty) => {
      get().markDirty(path, dirty);
    });

    set((s) => ({
      openFiles: [
        ...s.openFiles,
        {
          path,
          name,
          language: languageForPath(name),
          dirty: false,
          external: true,
        },
      ],
      activePath: path,
      error: null,
    }));
  },

  openExternalFile: async (path: string) => {
    const target = canonicalPath(path);
    const existing = get().openFiles.find((t) => sameFile(t.path, target));
    if (existing) {
      set({ activePath: existing.path, error: null });
      return;
    }

    let content: string;
    try {
      content = await readExternalFile(target);
    } catch (e) {
      set({ error: String(e) });
      return;
    }

    const raced = get().openFiles.find((t) => sameFile(t.path, target));
    if (raced) {
      set({ activePath: raced.path, error: null });
      return;
    }

    // Read-only: never mark the tab dirty no matter what is typed, so closing
    // it never asks to save.
    modelStore.createModel(target, content, () => {});

    set((s) => ({
      openFiles: [
        ...s.openFiles,
        {
          path: target,
          name: basename(target),
          language: languageForPath(target),
          dirty: false,
          readOnly: true,
        },
      ],
      activePath: target,
      error: null,
    }));
  },

  setActive: (path: string) => {
    set({ activePath: path, error: null });
  },

  // Close one or more tabs in a single state transition, keeping the existing
  // single-close behavior when `activeOverride` is undefined. `record` controls
  // whether the closed paths are pushed onto the closed-tab history.
  closeMany: (
    paths: string[],
    record: boolean,
    activeOverride: string | null | undefined,
  ) => {
    const { openFiles, activePath } = get();
    const closing = new Set(paths);
    const targets = paths.filter((p) => openFiles.some((t) => t.path === p));
    if (targets.length === 0) return;

    for (const p of targets) {
      modelStore.disposeModel(p);
    }

    const remaining = openFiles.filter((t) => !closing.has(t.path));
    let active = activePath;
    if (activePath && closing.has(activePath)) {
      if (activeOverride !== undefined) {
        active = activeOverride;
      } else {
        const idx = openFiles.findIndex((t) => t.path === activePath);
        const next = remaining[idx] ?? remaining[idx - 1] ?? null;
        active = next ? next.path : null;
      }
    }

    set((s) => {
      let closed = s.closedTabs;
      if (record) {
        for (const p of targets) {
          // Read-only external files cannot be reopened with `openFile`, so
          // they are never added to the closed-tab history.
          if (openFiles.find((t) => t.path === p)?.readOnly) continue;
          closed = pushClosedTab(closed, p);
        }
      }
      return {
        openFiles: remaining,
        activePath: active,
        error: null,
        closedTabs: closed,
        pendingClosePath:
          s.pendingClosePath && closing.has(s.pendingClosePath)
            ? null
            : s.pendingClosePath,
      };
    });
  },

  closeTab: (path: string, record = true) => {
    get().closeMany([path], record, undefined);
  },

  save: async (path?: string) => {
    const target = path ?? get().activePath;
    if (!target) return false;

    const tracked = modelStore.getTracked(target);
    if (!tracked) return false;

    const tab = get().openFiles.find((t) => t.path === target);
    if (tab?.readOnly) return false;
    const content = tracked.model.getValue();
    try {
      if (tab?.external) {
        await writeGlobalFile(basename(target), content);
      } else {
        await writeFile(target, content);
      }
      modelStore.markSaved(target);
      set((s) => ({
        openFiles: s.openFiles.map((t) =>
          t.path === target ? { ...t, dirty: false } : t,
        ),
        error: null,
      }));
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  requestCloseTab: (path: string) => {
    const tab = get().openFiles.find((t) => t.path === path);
    if (!tab) return;
    if (!tab.dirty) {
      get().closeTab(path);
      return;
    }
    set({ pendingClosePath: path });
  },

  cancelCloseTab: () => {
    if (get().pendingCloseQueue) {
      set({ pendingCloseQueue: null, pendingClosePath: null });
      return;
    }
    set({ pendingClosePath: null });
  },

  confirmCloseTab: async (saveChanges: boolean) => {
    const path = get().pendingClosePath;
    if (!path) return;

    const queue = get().pendingCloseQueue;
    if (queue) {
      if (saveChanges) {
        const ok = await get().save(path);
        // Keep the confirmation open when saving fails, so nothing is lost.
        if (!ok) return;
      }
      const remaining = queue.dirtyTargets.filter((p) => p !== path);
      // Discarded dirty content is not recoverable, so only saved closes are
      // recorded in the closed-tab history.
      get().closeTab(path, saveChanges);
      if (remaining.length > 0) {
        set({
          pendingCloseQueue: { ...queue, dirtyTargets: remaining },
          pendingClosePath: remaining[0],
        });
      } else {
        set({ pendingCloseQueue: null, pendingClosePath: null });
        const finalActive =
          queue.finalActive &&
          get().openFiles.some((t) => t.path === queue.finalActive)
            ? queue.finalActive
            : null;
        set({ activePath: finalActive });
      }
      return;
    }

    if (saveChanges) {
      const ok = await get().save(path);
      // Keep the confirmation open when saving fails, so nothing is lost.
      if (!ok) return;
    }
    get().closeTab(path, saveChanges);
    set({ pendingClosePath: null });
  },

  saveAll: async () => {
    for (const tab of get().openFiles) {
      if (!tab.dirty) continue;
      const ok = await get().save(tab.path);
      if (!ok) return false;
    }
    return true;
  },

  setCursorInfo: (info: CursorInfo | null) => set({ cursor: info }),

  markDirty: (path: string, dirty: boolean) => {
    set((s) => ({
      openFiles: s.openFiles.map((t) =>
        t.path === path ? { ...t, dirty } : t,
      ),
    }));
  },

  applyRename: (path: string, newPath: string) => {
    const tab = get().openFiles.find((t) => sameFile(t.path, path));
    if (!tab) return;

    const oldPath = tab.path;
    const target = canonicalPath(newPath);
    const dirty = modelStore.isDirty(oldPath);
    modelStore.rekeyPath(oldPath, target, (d) => get().markDirty(target, d));

    set((s) => ({
      openFiles: s.openFiles.map((t) =>
        t.path === oldPath
          ? {
              path: target,
              name: basename(target),
              language: languageForPath(target),
              dirty,
            }
          : t,
      ),
      activePath: sameFile(s.activePath ?? "", oldPath) ? target : s.activePath,
    }));
  },

  applyDelete: (path: string) => {
    const tab = get().openFiles.find((t) => sameFile(t.path, path));
    if (!tab) return;
    if (tab.dirty) return;
    // A deleted file cannot be reopened, so don't add it to the history.
    get().closeTab(tab.path, false);
  },

  onExternalChange: async (paths: string[]) => {
    const notices: string[] = [];
    for (const eventPath of paths) {
      const tab = get().openFiles.find((t) => sameFile(t.path, eventPath));
      if (!tab) continue;
      // Read-only external files are not workspace backed and the watcher only
      // covers the workspace; nothing to refresh here.
      if (tab.readOnly) continue;

      const path = tab.path;
      if (modelStore.isDirty(path)) {
        notices.push(`${basename(path)} 已在磁盘上被修改，本地未保存的更改已保留`);
        continue;
      }

      try {
        const content = await readFile(path);
        if (modelStore.isDirty(path)) {
          notices.push(`${basename(path)} 已在磁盘上被修改，本地未保存的更改已保留`);
          continue;
        }
        // The app's own save (Auto Save / Ctrl+S) returns to us as a watcher
        // event carrying the exact same content. Reloading that with setValue
        // would reset the cursor/selection/scroll position, so only replace the
        // model content when the file really changed on disk.
        const model = modelStore.getModel(path);
        if (model && model.getValue() !== content) {
          modelStore.setModelContent(path, content);
        }
        get().markDirty(path, false);
      } catch {
        // The file may have been deleted between the event and the read.
      }
    }
    if (notices.length > 0) {
      set((s) => ({
        externalNotice: [...(s.externalNotice ?? []), ...notices],
      }));
    }
  },

  reorderTabs: (fromIndex: number, toIndex: number) => {
    const { openFiles } = get();
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= openFiles.length ||
      toIndex >= openFiles.length
    ) {
      return;
    }
    const next = [...openFiles];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    set({ openFiles: next, error: null });
  },

  // Start a batch close while keeping dirty tabs protected. Clean targets are
  // closed right away; dirty targets are confirmed one at a time through the
  // existing save/discard modal.
  beginBatchClose: (
    anchor: string | null,
    targets: string[],
    finalActive: string | null,
  ) => {
    const openFiles = get().openFiles;
    const existing = targets.filter((p) =>
      openFiles.some((t) => t.path === p),
    );
    if (existing.length === 0) return;

    const dirtyTargets = existing.filter(
      (p) => get().openFiles.find((t) => t.path === p)?.dirty,
    );
    const cleanTargets = existing.filter((p) => !dirtyTargets.includes(p));

    if (cleanTargets.length > 0) {
      get().closeMany(cleanTargets, true, undefined);
    }

    if (dirtyTargets.length === 0) {
      set({
        activePath: finalActive,
        pendingCloseQueue: null,
        pendingClosePath: null,
      });
      return;
    }

    set({
      pendingCloseQueue: { anchor, dirtyTargets, finalActive },
      pendingClosePath: dirtyTargets[0],
    });
  },

  closeOthers: (path: string) => {
    const { openFiles } = get();
    if (!openFiles.some((t) => t.path === path)) return;
    const targets = openFiles
      .filter((t) => t.path !== path)
      .map((t) => t.path);
    get().beginBatchClose(path, targets, path);
  },

  closeRight: (path: string) => {
    const { openFiles, activePath } = get();
    const idx = openFiles.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const targets = openFiles.slice(idx + 1).map((t) => t.path);
    const finalActive =
      activePath && openFiles.slice(idx).some((t) => t.path === activePath)
        ? path
        : activePath;
    get().beginBatchClose(path, targets, finalActive);
  },

  closeAll: () => {
    const targets = get().openFiles.map((t) => t.path);
    get().beginBatchClose(null, targets, null);
  },

  restoreClosedTab: async () => {
    const skipped: string[] = [];
    for (;;) {
      const { closedTabs, openFiles } = get();
      if (closedTabs.length === 0) break;

      // Never duplicate an already open tab; just activate it.
      const alreadyOpen = closedTabs.find((p) =>
        openFiles.some((t) => sameFile(t.path, p)),
      );
      if (alreadyOpen) {
        set({
          closedTabs: closedTabs.filter((p) => p !== alreadyOpen),
          activePath: alreadyOpen,
          error: null,
        });
        return;
      }

      const path = closedTabs[0];
      set({ closedTabs: closedTabs.slice(1) });

      let exists = false;
      try {
        const entries = await listDir(dirname(path));
        exists = entries.some((e) => sameFile(e.path, path) && !e.is_dir);
      } catch {
        exists = false;
      }
      if (!exists) {
        skipped.push(path);
        continue;
      }

      await get().openFile(path);
      return;
    }
    if (skipped.length > 0) {
      set({
        error: `${skipped.map((p) => basename(p)).join("、")} 已不存在，已从最近关闭中移除`,
      });
    }
  },

  clearError: () => set({ error: null }),

  dismissExternalNotice: () => set({ externalNotice: null }),

  reset: () => {
    for (const t of get().openFiles) {
      modelStore.disposeModel(t.path);
    }
    set({
      openFiles: [],
      activePath: null,
      error: null,
      externalNotice: null,
      pendingClosePath: null,
      pendingCloseQueue: null,
      closedTabs: [],
      cursor: null,
    });
  },
}));