import { create } from "zustand";
import {
  gitDiffFile,
  type DiffSideRequest,
  type GitDiffContent,
} from "../commands";
import { useWorkspaceStore } from "./workspaceStore";

/** The live temporary Git diff shown by the DiffView. `content` is filled
 *  after the backend fetch resolves; while it is null the view stays on its
 *  loading / message states. */
export interface ActiveDiff {
  /** The changed file's git-relative path (used for the title). */
  path: string;
  original: DiffSideRequest;
  modified: DiffSideRequest;
  originalLabel: string;
  modifiedLabel: string;
  content: GitDiffContent | null;
  loading: boolean;
  error: string | null;
}

interface DiffStore {
  /** The active temporary diff, or null when no diff is open. */
  diff: ActiveDiff | null;
  open: (
    path: string,
    original: DiffSideRequest,
    modified: DiffSideRequest,
  ) => Promise<void>;
  close: () => void;
}

export const useDiffStore = create<DiffStore>((set, get) => {
  // Bumped on every open and on close; a slow backend response from an older
  // request is discarded so switching files (or closing) never mutates the
  // current diff.
  let openSeq = 0;

  const open = async (
    path: string,
    original: DiffSideRequest,
    modified: DiffSideRequest,
  ) => {
    const seq = ++openSeq;
    set({
      diff: {
        path,
        original,
        modified,
        originalLabel: "",
        modifiedLabel: "",
        content: null,
        loading: true,
        error: null,
      },
    });

    try {
      const content = await gitDiffFile(original, modified);
      if (seq !== openSeq) return;
      const current = get().diff;
      if (!current || current.path !== path) return;
      set({
        diff: {
          ...current,
          content,
          originalLabel: content.originalLabel,
          modifiedLabel: content.modifiedLabel,
          loading: false,
        },
      });
    } catch (e) {
      if (seq !== openSeq) return;
      const current = get().diff;
      if (!current || current.path !== path) return;
      set({ diff: { ...current, error: String(e), loading: false } });
    }
  };

  const close = () => {
    ++openSeq;
    set({ diff: null });
  };

  // A workspace switch invalidates the diff: the backend Git state (and any
  // in-flight fetch) belongs to the old workspace. Deferred to a microtask
  // like gitStore because this store is imported during the frontend module
  // cycle, when `useWorkspaceStore` may still be initializing.
  queueMicrotask(() => {
    useWorkspaceStore.subscribe((state, prev) => {
      if (state.workspacePath === prev.workspacePath) return;
      useDiffStore.getState().close();
    });
  });

  return {
    diff: null,
    open,
    close,
  };
});