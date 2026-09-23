import { create } from "zustand";
import { listWorkspaceFiles } from "../commands";
import { useWorkspaceStore } from "./workspaceStore";

export type RightSidebarTab = "search" | "outline" | "problems";

interface SearchStore {
  /** Cached workspace file list for Quick Open (workspace-relative paths). */
  files: string[];
  filesLoaded: boolean;
  filesError: string | null;
  /** The centered Quick Open overlay is open. */
  quickOpenOpen: boolean;
  /** Right (secondary) sidebar visibility and active panel. */
  rightSidebarOpen: boolean;
  rightSidebarTab: RightSidebarTab;

  loadFiles: () => Promise<void>;
  resetFiles: () => void;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
  toggleQuickOpen: () => void;
  openRightSidebar: (tab: RightSidebarTab) => void;
  toggleRightSidebar: () => void;
  closeRightSidebar: () => void;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  files: [],
  filesLoaded: false,
  filesError: null,
  quickOpenOpen: false,
  rightSidebarOpen: false,
  rightSidebarTab: "outline",

  loadFiles: async () => {
    const { filesLoaded } = get();
    if (filesLoaded) return;
    set({ filesError: null });
    try {
      const files = await listWorkspaceFiles();
      set({ files, filesLoaded: true });
    } catch (e) {
      set({ filesError: String(e) });
    }
  },

  resetFiles: () => set({ files: [], filesLoaded: false, filesError: null }),

  openQuickOpen: () => {
    set({ quickOpenOpen: true });
    void get().loadFiles();
  },
  closeQuickOpen: () => set({ quickOpenOpen: false }),
  toggleQuickOpen: () => {
    if (get().quickOpenOpen) {
      get().closeQuickOpen();
    } else {
      get().openQuickOpen();
    }
  },

  openRightSidebar: (tab) => set({ rightSidebarOpen: true, rightSidebarTab: tab }),
  toggleRightSidebar: () =>
    set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  closeRightSidebar: () => set({ rightSidebarOpen: false }),
}));

// Switching workspace invalidates the cached file index. The terminal/explorer
// stores already reset in `openWorkspace`; doing it here keeps Quick Open from
// offering files of the previous project.
useWorkspaceStore.subscribe(() => {
  useSearchStore.getState().resetFiles();
});