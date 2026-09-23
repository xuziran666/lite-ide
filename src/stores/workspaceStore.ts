import { create } from "zustand";
import { getWorkspace, setWorkspace as setWorkspaceCommand } from "../commands";
import { useEditorStore } from "./editorStore";
import { useFileTreeStore } from "./fileTreeStore";

interface WorkspaceStore {
  workspacePath: string | null;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspacePath: null,
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
      useEditorStore.getState().reset();
      useFileTreeStore.getState().reset();
      await useFileTreeStore.getState().loadRoot(resolved);
      set({ workspacePath: resolved, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
}));