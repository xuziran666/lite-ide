import { create } from "zustand";
import type { DirEntry } from "../types";
import { getWorkspace, listDir, setWorkspace as setWorkspaceCommand } from "../commands";
import { useEditorStore } from "./editorStore";

interface WorkspaceStore {
  workspacePath: string | null;
  entries: DirEntry[];
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspacePath: null,
  entries: [],
  loading: false,
  error: null,

  init: async () => {
    try {
      const path = await getWorkspace();
      if (path) {
        await get().openWorkspace(path);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openWorkspace: async (path: string) => {
    set({ loading: true, error: null });
    try {
      const resolved = await setWorkspaceCommand(path);
      const entries = await listDir(resolved);
      useEditorStore.getState().reset();
      set({ workspacePath: resolved, entries, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  refresh: async () => {
    const { workspacePath } = get();
    if (!workspacePath) return;
    set({ loading: true, error: null });
    try {
      const entries = await listDir(workspacePath);
      set({ entries, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
}));