import { create } from "zustand";
import { listWorkspaceFiles } from "../commands";
import { useWorkspaceStore } from "./workspaceStore";

export type RightSidebarTab = "search" | "references" | "outline" | "problems";

/** Active view of the left primary sidebar; null means fully collapsed. */
export type PrimarySidebarView = "explorer" | "sourceControl" | "tasks";

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
  /** Left (primary) sidebar active view, or null when it is collapsed. */
  activePrimarySidebar: PrimarySidebarView | null;
  /** The last non-collapsed primary sidebar view, restored on re-expand. */
  primarySidebarLastView: PrimarySidebarView;
  /** References results; null until a search has run for the symbol. */
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
  selectPrimarySidebar: (tab: PrimarySidebarView) => void;
  togglePrimarySidebar: () => void;
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
  activePrimarySidebar: "explorer",
  primarySidebarLastView: "explorer",
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

  // VS Code semantics: clicking the already-active Activity Bar icon collapses
  // the primary sidebar; clicking any other icon switches the view.
  selectPrimarySidebar: (tab) =>
    set((s) => {
      const next = s.activePrimarySidebar === tab ? null : tab;
      return {
        activePrimarySidebar: next,
        primarySidebarLastView: next ?? s.primarySidebarLastView,
      };
    }),

  // Top Bar left-panel button: fully collapse/expand the shared primary
  // sidebar. Collapsing remembers the current view so re-expanding restores it,
  // and the width is kept by AppLayout (it never resets on collapse).
  togglePrimarySidebar: () =>
    set((s) => ({
      activePrimarySidebar:
        s.activePrimarySidebar === null ? s.primarySidebarLastView : null,
    })),

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
//
// Deferred: this module is imported during the early module cycle
// (monacoSetup -> lsp/client -> searchStore), so `useWorkspaceStore` is still
// being initialized when this file evaluates. A microtask runs after the whole
// module graph has finished evaluating.
queueMicrotask(() => {
  useWorkspaceStore.subscribe(() => {
    useSearchStore.getState().resetFiles();
    useSearchStore.getState().clearReferences();
  });
});