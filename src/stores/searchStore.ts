import { create } from "zustand";
import { listWorkspaceFiles } from "../commands";
import { useWorkspaceStore } from "./workspaceStore";

export type RightSidebarTab = "search" | "references" | "outline" | "problems";

/** One `textDocument/references` result row. */
export interface ReferenceItem {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The surrounding line when the file is open, otherwise empty. */
  preview: string;
}

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
  /** Find References results; null until a search has run for the symbol. */
  references: ReferenceItem[] | null;
  referencesSymbol: string | null;
  referencesLoading: boolean;

  loadFiles: () => Promise<void>;
  resetFiles: () => void;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
  toggleQuickOpen: () => void;
  openRightSidebar: (tab: RightSidebarTab) => void;
  toggleRightSidebar: () => void;
  closeRightSidebar: () => void;
  beginReferences: (symbol: string) => void;
  finishReferences: (items: ReferenceItem[]) => void;
  clearReferences: () => void;
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  files: [],
  filesLoaded: false,
  filesError: null,
  quickOpenOpen: false,
  rightSidebarOpen: false,
  rightSidebarTab: "outline",
  references: null,
  referencesSymbol: null,
  referencesLoading: false,

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

  beginReferences: (symbol) =>
    set({
      referencesSymbol: symbol,
      references: null,
      referencesLoading: true,
      rightSidebarOpen: true,
      rightSidebarTab: "references",
    }),
  finishReferences: (items) =>
    set({ references: items, referencesLoading: false }),
  clearReferences: () =>
    set({ references: null, referencesSymbol: null, referencesLoading: false }),
}));

// Switching workspace invalidates the cached file index and any reference
// results. The terminal/explorer stores already reset in `openWorkspace`; doing
// it here keeps Quick Open and Find References from offering stale data.
useWorkspaceStore.subscribe(() => {
  useSearchStore.getState().resetFiles();
  useSearchStore.getState().clearReferences();
});