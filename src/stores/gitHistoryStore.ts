import { create } from "zustand";
import {
  gitCommitDetails,
  gitLog,
  type GitCommitDetails,
  type GitCommitInfo,
} from "../commands";
import { useWorkspaceStore } from "./workspaceStore";

/** Commits fetched per history page; a page of exactly this size means "more". */
export const HISTORY_PAGE_SIZE = 50;

export interface GitHistoryStore {
  /** Loaded history, newest first. */
  commits: GitCommitInfo[];
  /** The first page is loading. */
  loading: boolean;
  /** An older page is being appended. */
  loadingMore: boolean;
  /** A next page exists (the last page was exactly `HISTORY_PAGE_SIZE`). */
  hasMore: boolean;
  error: string;
  /** The commit shown in the detail pane, or null. */
  selected: GitCommitInfo | null;
  /** The selected commit's changed files, or null while loading. */
  details: GitCommitDetails | null;
  detailsLoading: boolean;
  detailsError: string;

  /** Load the first page, resetting the list and selection. */
  load: () => Promise<void>;
  /** Append the next page below the current list. */
  loadMore: () => Promise<void>;
  /** Select a commit and fetch its changed files (null clears the pane). */
  select: (commit: GitCommitInfo | null) => Promise<void>;
  /** Invalidate state for a workspace switch (drops in-flight results). */
  clear: () => void;
}

export const useGitHistoryStore = create<GitHistoryStore>((set, get) => {
  // Bumped on every load / clear. Results from an older generation are dropped
  // so a slow first page never overwrites a newer load.
  let loadSeq = 0;
  let detailSeq = 0;

  const load = async () => {
    const seq = ++loadSeq;
    set({ loading: true, error: "", selected: null, details: null });
    try {
      const commits = await gitLog(HISTORY_PAGE_SIZE, 0);
      if (seq !== loadSeq) return;
      set({
        commits,
        loading: false,
        hasMore: commits.length === HISTORY_PAGE_SIZE,
      });
    } catch (e) {
      if (seq !== loadSeq) return;
      set({ commits: [], loading: false, error: String(e) });
    }
  };

  const loadMore = async () => {
    const { commits, loading, loadingMore, hasMore } = get();
    if (loading || loadingMore || !hasMore) return;
    set({ loadingMore: true });
    const seq = loadSeq;
    try {
      const page = await gitLog(HISTORY_PAGE_SIZE, commits.length);
      if (seq !== loadSeq) return;
      set({
        commits: [...get().commits, ...page],
        loadingMore: false,
        hasMore: page.length === HISTORY_PAGE_SIZE,
      });
    } catch (e) {
      if (seq !== loadSeq) return;
      set({ loadingMore: false, error: String(e) });
    }
  };

  const select = async (commit: GitCommitInfo | null) => {
    const dSeq = ++detailSeq;
    if (!commit) {
      set({ selected: null, details: null, detailsLoading: false, detailsError: "" });
      return;
    }
    set({ selected: commit, details: null, detailsLoading: true, detailsError: "" });
    try {
      const details = await gitCommitDetails(commit.hash);
      if (dSeq !== detailSeq) return;
      set({ details, detailsLoading: false });
    } catch (e) {
      if (dSeq !== detailSeq) return;
      set({ detailsLoading: false, detailsError: String(e) });
    }
  };

  return {
    commits: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    error: "",
    selected: null,
    details: null,
    detailsLoading: false,
    detailsError: "",

    load,
    loadMore,
    select,
    clear: () => {
      ++loadSeq;
      ++detailSeq;
      set({
        commits: [],
        loading: true,
        loadingMore: false,
        hasMore: false,
        error: "",
        selected: null,
        details: null,
        detailsLoading: false,
        detailsError: "",
      });
    },
  };
});

// Every workspace switch invalidates the history (the backend Git state, and
// any in-flight call, belongs to the old workspace). Deferred to a microtask
// like gitStore/diffStore because this store is imported during the frontend
// module cycle.
queueMicrotask(() => {
  useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspacePath === prev.workspacePath) return;
    useGitHistoryStore.getState().clear();
  });
});