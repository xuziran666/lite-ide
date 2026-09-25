import type { DiffSideRequest, GitCommitFile } from "../commands";

/** `parent` and `commit` may be full 40-char hashes; the diff labels show the
 *  short form. Falls back to null/undefined when not provided. */
export function shortHash(hash: string | null | undefined): string | undefined {
  return hash ? hash.slice(0, 7) : undefined;
}

/**
 * Resolve the two sides of the History panel's Parent → Commit diff for one
 * changed file. Pure mapping — the actual blobs are fetched by `git_diff_file`.
 * Rules:
 * - M (modified) and unknown ("?"): parent commit at `path` vs commit at `path`.
 * - A (added): 空 vs commit at `path`.
 * - D (deleted): parent commit at `path` vs 空.
 * - R / C (rename/copy): parent commit at `oldPath` vs commit at `path`.
 * Labels show the short commit hash, e.g. `a1b2c3d: src/main.cpp`.
 */
export function commitDiffSides(
  file: GitCommitFile,
  commitHash: string | null,
  parentHash: string | null,
): { original: DiffSideRequest; modified: DiffSideRequest } {
  const originalPath =
    file.status === "R" || file.status === "C"
      ? file.oldPath ?? file.path
      : file.path;

  const original: DiffSideRequest =
    file.status === "A"
      ? { source: "EMPTY", path: file.path }
      : {
          source: "COMMIT",
          path: originalPath,
          commit: parentHash ?? undefined,
          label: `${shortHash(parentHash) ?? "HEAD"}: ${originalPath}`,
        };

  const modified: DiffSideRequest =
    file.status === "D"
      ? { source: "EMPTY", path: file.path }
      : {
          source: "COMMIT",
          path: file.path,
          commit: commitHash ?? undefined,
          label: `${shortHash(commitHash) ?? "HEAD"}: ${file.path}`,
        };

  return { original, modified };
}