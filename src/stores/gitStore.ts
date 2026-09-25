import { create } from "zustand";
import {
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
  type GitFileStatus,
} from "../commands";
import { useWorkspaceStore } from "./workspaceStore";
import { buildGitStatusLookups } from "../utils/gitStatusMapping";
import { fileKey } from "../utils/pathIdentity";

/** Debounce before re-reading git status after file-system events. */
const REFRESH_DEBOUNCE_MS = 400;

export interface GitStore {
  /** The workspace is inside a Git repository. */
  isRepository: boolean;
  /** Absolute repository root, or null when not a Git repo. */
  repositoryRoot: string | null;
  /** True while the first status load for a workspace hasn't finished. */
  loading: boolean;
  /** User-facing error from the last refresh or mutation, or null. */
  error: string | null;
  /** A stage/unstage operation is in flight (buttons stay disabled). */
  busy: boolean;
  /** Per-file status for the current workspace. */
  files: GitFileStatus[];
  /**
   * O(1) file-status lookup for the file tree, keyed by `fileKey(absolute)`.
   * Rebuilt on every snapshot; the FileTree reads it per node instead of
   * scanning `files`.
   */
  statusByPath: ReadonlyMap<string, GitFileStatus>;
  /** O(1) folder-status summary, keyed by the directory's `fileKey`. */
  dirStatusByPath: ReadonlyMap<string, GitFileStatus>;

  refresh: () => Promise<void>;
  /** Debounced refresh triggered by file-system events. */
  scheduleRefresh: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  /** Invalidate state for a workspace switch (drops in-flight results). */
  clear: () => void;
}

export const useGitStore = create<GitStore>((set, get) => {
  // Bumped on every refresh and on `clear`; async results from an older
  // generation are discarded so a slow load never overwrites a newer one.
  let refreshSeq = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const refresh = async () => {
    const seq = ++refreshSeq;
    clearTimer();
    set({ loading: true, error: null });
    try {
      const snapshot = await gitStatus();
      if (seq !== refreshSeq) return;
      const workspacePath = useWorkspaceStore.getState().workspacePath;
      const lookups = buildGitStatusLookups(snapshot.files, workspacePath);
      set({
        isRepository: snapshot.repositoryRoot != null,
        repositoryRoot: snapshot.repositoryRoot,
        files: snapshot.files,
        statusByPath: lookups.statusByPath,
        dirStatusByPath: lookups.dirStatusByPath,
        loading: false,
        error: null,
      });
    } catch (e) {
      if (seq !== refreshSeq) return;
      set({
        isRepository: false,
        repositoryRoot: null,
        files: [],
        statusByPath: new Map(),
        dirStatusByPath: new Map(),
        loading: false,
        error: String(e),
      });
    }
  };

  const scheduleRefresh = () => {
    clearTimer();
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  const mutate = async (run: () => Promise<void>) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      await run();
      await get().refresh();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  };

  return {
    isRepository: false,
    repositoryRoot: null,
    loading: true,
    error: null,
    busy: false,
    files: [],
    statusByPath: new Map(),
    dirStatusByPath: new Map(),

    refresh,
    scheduleRefresh,
    stage: (paths) => mutate(() => gitStage(paths)),
    unstage: (paths) => mutate(() => gitUnstage(paths)),
    stageAll: () => mutate(() => gitStageAll()),
    unstageAll: () => mutate(() => gitUnstageAll()),
    clear: () => {
      ++refreshSeq;
      clearTimer();
      set({
        isRepository: false,
        repositoryRoot: null,
        loading: true,
        error: null,
        files: [],
        statusByPath: new Map(),
        dirStatusByPath: new Map(),
      });
    },
  };
});

// Every workspace switch invalidates the cached status and starts a fresh
// load (the backend already killed terminals / LSP on `set_workspace`).
//
// Deferred to a microtask like searchStore: this store is imported during the
// frontend module cycle, so `useWorkspaceStore` may still be initializing when
// this file evaluates.
queueMicrotask(() => {
  useWorkspaceStore.subscribe((state, prev) => {
    if (state.workspacePath === prev.workspacePath) return;
    useGitStore.getState().clear();
    void useGitStore.getState().refresh();
  });
});

/** Reactive selector for one tree node's git badge (`isDir` picks the map). */
export function selectNodeGitStatus(path: string, isDir: boolean) {
  const key = fileKey(path);
  return (s: GitStore): GitFileStatus | undefined =>
    (isDir ? s.dirStatusByPath : s.statusByPath).get(key);
}

/** Non-reactive lookup of a file's git status by its absolute path. */
export function getGitStatusByPath(path: string): GitFileStatus | undefined {
  return useGitStore.getState().statusByPath.get(fileKey(path));
}