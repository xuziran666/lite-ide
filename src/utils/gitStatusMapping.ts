import type { GitFileStatus } from "../commands";
import { fileKey, resolveAgainstWorkspace } from "./pathIdentity.ts";

/**
 * Materialised lookup tables for git decorations in the file tree.
 *
 * The tree renders one row per node; a per-node `gitStore.files.find(...)`
 * would be O(n) per node. The store builds these Maps once per refresh and
 * every tree node queries its own path in O(1).
 *
 * Git reports *workspace-relative* paths with `/` separators while tree nodes
 * hold absolute (often Windows verbatim `\\?\…`) paths. Both sides go through
 * `resolveAgainstWorkspace` + `fileKey` (see pathIdentity.ts) so backslash /
 * forward-slash, drive-letter case, `\\?\` and `\\?\UNC\…` prefixes all
 * compare equal.
 *
 * NOTE: fileKey is `isWindowsPlatform()`-dependent, so this module keeps the
 * two platform-sensitive roles injectable through `keyOf` for deterministic
 * tests. Production callers use the default (fileKey).
 */

/** Most-significant-to-least precedence used to pick a folder's badge. */
const STATUS_PRECEDENCE: Record<string, number> = {
  M: 0,
  D: 1,
  A: 2,
  R: 3,
  U: 4,
  C: 5,
  "?": 6,
};

export interface GitStatusLookups {
  /** Absolute path key -> status for individual files. */
  statusByPath: Map<string, GitFileStatus>;
  /** Absolute path key -> representative status for ancestor directories. */
  dirStatusByPath: Map<string, GitFileStatus>;
}

function statusRank(status: string): number {
  return STATUS_PRECEDENCE[status] ?? 9;
}

/**
 * Build the independent badge category for a status letter: `?` maps to `q`
 * (untracked), every other porcelain letter maps to its lowercase self.
 */
export function gitBadgeKey(status: string): string {
  return status === "?" ? "q" : status.toLowerCase();
}

/**
 * Build the lookup tables for a single git snapshot. `workspacePath` is the
 * absolute workspace root (paths are resolved against it). `keyOf` mirrors
 * `fileKey` and is overridable in tests to simulate the Windows branch of
 * fileKey without depending on `navigator`.
 */
export function buildGitStatusLookups(
  files: readonly GitFileStatus[],
  workspacePath: string | null,
  keyOf: (absolutePath: string) => string = fileKey,
): GitStatusLookups {
  const statusByPath = new Map<string, GitFileStatus>();
  const dirStatusByPath = new Map<string, GitFileStatus>();

  if (!workspacePath) {
    return { statusByPath, dirStatusByPath };
  }

  for (const file of files) {
    if (!file.path) continue;
    const absolute = resolveAgainstWorkspace(file.path, workspacePath);
    statusByPath.set(keyOf(absolute), file);

    // Mark every ancestor directory up to (but excluding) the workspace root.
    // `a/b/c.txt` marks `a` and `a/b`. A folder keeps the most significant
    // status among its changed descendants.
    let slash = file.path.indexOf("/");
    while (slash > 0) {
      const dirAbsolute = resolveAgainstWorkspace(
        file.path.slice(0, slash),
        workspacePath,
      );
      const dirKey = keyOf(dirAbsolute);
      const current = dirStatusByPath.get(dirKey);
      if (!current || statusRank(file.status) < statusRank(current.status)) {
        dirStatusByPath.set(dirKey, file);
      }
      slash = file.path.indexOf("/", slash + 1);
    }
  }

  return { statusByPath, dirStatusByPath };
}