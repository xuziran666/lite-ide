import { create } from "zustand";
import type { Tab } from "../types";
import { readFile, writeFile } from "../commands";
import * as modelStore from "../editor/modelStore";
import { basename, languageForPath } from "../utils/language";

interface EditorStore {
  openFiles: Tab[];
  activePath: string | null;
  error: string | null;
  openFile: (path: string) => Promise<void>;
  setActive: (path: string) => void;
  closeTab: (path: string) => void;
  save: (path?: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openFiles: [],
  activePath: null,
  error: null,

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
      set((s) => ({
        openFiles: s.openFiles.map((t) =>
          t.path === path ? { ...t, dirty } : t,
        ),
      }));
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
    set({ openFiles: remaining, activePath: active, error: null });
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

  clearError: () => set({ error: null }),

  reset: () => {
    for (const t of get().openFiles) {
      modelStore.disposeModel(t.path);
    }
    set({ openFiles: [], activePath: null, error: null });
  },
}));