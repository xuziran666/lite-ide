import type { DiffSideRequest, GitFileStatus } from "../commands";

/** Which Source Control group a row belongs to. The two sides of a diff depend
 *  on the group: a file that is both staged and modified shows different diffs
 *  from the "更改" list (Index vs Worktree) and the "已暂存更改" list (HEAD vs
 *  Index). */
export type DiffGroup = "changes" | "staged";

/**
 * Resolve the two sides of a Git diff from a file's status and the group the
 * row was clicked in. This is a pure mapping — the actual blobs are fetched by
 * `git_diff_file`. Rules:
 * - 已暂存 list: original = HEAD (空 for newly added files), modified = Index.
 * - 更改 list, untracked: 空 vs Worktree.
 * - 更改 list, worktree deletion (` D`): Index vs 空 — never read the worktree.
 * - 更改 list, otherwise: Index (when the file is also staged, so the worktree
 *   change shows against the staged snapshot) or HEAD; modified = Worktree.
 * - Renames fetch the original side from the pre-rename path when available.
 */
export function diffSidesFor(
  file: GitFileStatus,
  group: DiffGroup,
): { original: DiffSideRequest; modified: DiffSideRequest } {
  const path = file.path;

  if (group === "staged") {
    const added = file.stagedStatus === "A";
    return {
      original: added
        ? { source: "EMPTY", path }
        : { source: "HEAD", path: file.renamedFrom ?? path },
      modified: { source: "INDEX", path },
    };
  }

  if (file.untracked) {
    return {
      original: { source: "EMPTY", path },
      modified: { source: "WORKTREE", path },
    };
  }

  if (file.unstagedStatus === "D") {
    return {
      original: { source: "INDEX", path },
      modified: { source: "EMPTY", path },
    };
  }

  return {
    original: file.staged
      ? { source: "INDEX", path }
      : { source: "HEAD", path: file.renamedFrom ?? path },
    modified: { source: "WORKTREE", path },
  };
}