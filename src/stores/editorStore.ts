import { create } from "zustand";
import type { CursorInfo, Tab } from "../types";
import { readFile, writeFile } from "../commands";
import * as modelStore from "../editor/modelStore";
import { basename, languageForPath } from "../utils/language";

interface EditorStore {
  openFiles: Tab[];
  activePath: string | null;
  error: string | null;
  externalNotice: string[] | null;
  /** Dirty tab waiting for a save/discard decision before it can be closed. */
  pendingClosePath: string | null;
  cursor: CursorInfo | null;
  openFile: (path: string) => Promise<void>;
  setActive: (path: string) => void;
  closeTab: (path: string) => void;
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
  clearError: () => void;
  dismissExternalNotice: () => void;
  reset: () => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openFiles: [],
  activePath: null,
  error: null,
  externalNotice: null,
  pendingClosePath: null,
  cursor: null,

  openFile: async (path: string) => {
    if (get().openFiles.some((t) => t.path === path)) {
      set({ activePath: path, error: null });
      return;
    }

    let content: string;
    try {
      content = await readFile(path);
    } catch (e) {
      set({ error: String(e) });
      return;
    }

    if (get().openFiles.some((t) => t.path === path)) {
      set({ activePath: path, error: null });
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
          name: basename(path),
          language: languageForPath(path),
          dirty: false,
        },
      ],
      activePath: path,
      error: null,
    }));
  },

  setActive: (path: string) => {
    set({ activePath: path, error: null });
  },

  closeTab: (path: string) => {
    modelStore.disposeModel(path);
    const { openFiles, activePath } = get();
    const idx = openFiles.findIndex((t) => t.path === path);
    if (idx < 0) return;

    const remaining = openFiles.filter((t) => t.path !== path);
    let active = activePath;
    if (activePath === path) {
      const next = remaining[idx] ?? remaining[idx - 1] ?? null;
      active = next ? next.path : null;
    }
    set((s) => ({
      openFiles: remaining,
      activePath: active,
      error: null,
      pendingClosePath: s.pendingClosePath === path ? null : s.pendingClosePath,
    }));
  },

  save: async (path?: string) => {
    const target = path ?? get().activePath;
    if (!target) return false;

    const tracked = modelStore.getTracked(target);
    if (!tracked) return false;

    const content = tracked.model.getValue();
    try {
      await writeFile(target, content);
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

  cancelCloseTab: () => set({ pendingClosePath: null }),

  confirmCloseTab: async (saveChanges: boolean) => {
    const path = get().pendingClosePath;
    if (!path) return;
    if (saveChanges) {
      const ok = await get().save(path);
      // Keep the confirmation open when saving fails, so nothing is lost.
      if (!ok) return;
    }
    get().closeTab(path);
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
    const { openFiles } = get();
    if (!openFiles.some((t) => t.path === path)) return;

    const dirty = modelStore.isDirty(path);
    modelStore.rekeyPath(path, newPath, (d) => get().markDirty(newPath, d));

    set((s) => ({
      openFiles: s.openFiles.map((t) =>
        t.path === path
          ? {
              path: newPath,
              name: basename(newPath),
              language: languageForPath(newPath),
              dirty,
            }
          : t,
      ),
      activePath: s.activePath === path ? newPath : s.activePath,
    }));
  },

  applyDelete: (path: string) => {
    const tab = get().openFiles.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty) return;
    get().closeTab(path);
  },

  onExternalChange: async (paths: string[]) => {
    const notices: string[] = [];
    for (const p of paths) {
      if (!get().openFiles.some((t) => t.path === p)) continue;

      if (modelStore.isDirty(p)) {
        notices.push(`${basename(p)} 已在磁盘上被修改，本地未保存的更改已保留`);
        continue;
      }

      try {
        const content = await readFile(p);
        if (modelStore.isDirty(p)) {
          notices.push(`${basename(p)} 已在磁盘上被修改，本地未保存的更改已保留`);
          continue;
        }
        modelStore.setModelContent(p, content);
        get().markDirty(p, false);
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
      cursor: null,
    });
  },
}));