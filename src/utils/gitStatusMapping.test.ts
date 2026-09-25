import {
  buildGitStatusLookups,
  gitBadgeKey,
} from "./gitStatusMapping.ts";
import {
  canonicalPath,
  resolveAgainstWorkspace,
} from "./pathIdentity.ts";
import type { GitFileStatus } from "../commands";

/**
 * Pure unit tests for the file-tree git-status mapping. Run with:
 *
 *     node src/utils/gitStatusMapping.test.ts
 *
 * (Node >= 22 type-strips `.ts` directly; no framework needed.)
 *
 * The Windows branch of `fileKey` depends on `navigator.userAgent`, which is
 * absent under Node. Windows semantics are therefore exercised with the
 * explicit `keyOf = (p) => canonicalPath(p).toLowerCase()` — exactly what
 * `fileKey` performs on Windows — while the default (POSIX-like) `fileKey`
 * covers non-Windows behavior.
 */

let failures = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const cond =
    JSON.stringify(actual) === JSON.stringify(expected);
  if (cond) {
    console.log(`  ok   ${msg} (${JSON.stringify(expected)})`);
  } else {
    failures += 1;
    console.error(
      `  FAIL ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

/** Windows-mode keyer: canonical + case-fold, exactly fileKey on Windows. */
const winKey = (p: string): string => canonicalPath(p).toLowerCase();
/** Default keyer: POSIX-like in Node (isWindowsPlatform() is false). */
const posixKey = (p: string): string => canonicalPath(p);

function status(
  partial: Partial<GitFileStatus> & { path: string },
): GitFileStatus {
  return {
    status: "M",
    staged: false,
    unstaged: false,
    untracked: false,
    renamedFrom: null,
    stagedStatus: " ",
    unstagedStatus: " ",
    ...partial,
  };
}

const WS_ON_WINDOWS = "E:\\Projects\\repo";
const WS_ON_WINDOWS_VERBATIM = "\\\\?\\E:\\Projects\\repo";

function filesModifiedAddedDeleted(): GitFileStatus[] {
  return [
    status({ path: "src/app.cpp", status: "M" }),
    status({ path: "src/new.cpp", status: "A" }),
    status({ path: "old.cpp", status: "D" }),
  ];
}

console.log("badge key mapping");
eq(gitBadgeKey("?"), "q", "? -> q");
eq(gitBadgeKey("M"), "m", "M -> m");
eq(gitBadgeKey("R"), "r", "R -> r");

console.log("M / A / D / untracked / conflict statuses");
{
  const files = [
    ...filesModifiedAddedDeleted(),
    status({ path: "todo.md", status: "?", untracked: true, unstaged: true }),
    status({
      path: "conflict.txt",
      status: "U",
      stagedStatus: "U",
      unstagedStatus: "U",
    }),
  ];
  const l = buildGitStatusLookups(files, WS_ON_WINDOWS, winKey);
  eq(l.statusByPath.get(winKey("E:\\Projects\\repo\\src\\app.cpp"))?.status, "M", "modified file -> M");
  eq(l.statusByPath.get(winKey("E:/Projects/repo/src/new.cpp"))?.status, "A", "added file -> A");
  eq(l.statusByPath.get(winKey("E:\\Projects\\repo\\old.cpp"))?.status, "D", "deleted file -> D (tree has no node, so nothing is rendered)");
  eq(l.statusByPath.get(winKey("E:/Projects/repo/todo.md"))?.status, "?", "untracked -> ? (git porcelain letter, rendered as ?)");
  eq(l.statusByPath.get(winKey("E:/Projects/repo/conflict.txt"))?.status, "U", "conflict/unmerged -> U");
}

console.log("renamed -> R on the new path, renamedFrom stays on the entry");
{
  const files = [
    status({ path: "new.cpp", status: "R", renamedFrom: "old.cpp" }),
  ];
  const l = buildGitStatusLookups(files, WS_ON_WINDOWS, winKey);
  const entry = l.statusByPath.get(winKey("E:/Projects/repo/new.cpp"));
  eq(entry?.status, "R", "renamed new path -> R");
  eq(entry?.renamedFrom ?? null, "old.cpp", "renamedFrom recorded");
  ok(
    !l.statusByPath.has(winKey("E:/Projects/repo/old.cpp")),
    "old path gets no entry (no fabricated node)",
  );
}

console.log("refresh / stage / unstage — rebuilt maps reflect the new snapshot");
{
  const staged = [status({ path: "a.cpp", status: "A", staged: true })];
  const afterUnstage = [status({ path: "a.cpp", status: "?", unstaged: true, untracked: true })];
  const l1 = buildGitStatusLookups(staged, WS_ON_WINDOWS, winKey);
  const l2 = buildGitStatusLookups(afterUnstage, WS_ON_WINDOWS, winKey);
  eq(l1.statusByPath.get(winKey("E:/Projects/repo/a.cpp"))?.staged, true, "staged flag before unstage");
  eq(l2.statusByPath.get(winKey("E:/Projects/repo/a.cpp"))?.status, "?", "badge flips A -> ? after unstage");
  eq(l2.statusByPath.get(winKey("E:/Projects/repo/a.cpp"))?.staged, false, "staged flag clears after unstage");

  const refreshed = [status({ path: "b.cpp", status: "M" })];
  const l3 = buildGitStatusLookups(refreshed, WS_ON_WINDOWS, winKey);
  ok(
    !l3.statusByPath.has(winKey("E:/Projects/repo/a.cpp")),
    "file gone from the snapshot -> no badge anymore (auto refresh re-renders)",
  );
}

console.log("Windows path shapes all resolve to one key");
{
  const files = filesModifiedAddedDeleted();
  const l = buildGitStatusLookups(files, WS_ON_WINDOWS, winKey);
  const shapes = [
    "E:\\Projects\\repo\\src\\app.cpp",
    "e:/projects/repo/src/app.cpp",
    "\\\\?\\E:\\Projects\\repo\\src\\app.cpp",
    "E:\\Projects\\repo\\src\\app.CPP",
  ];
  for (const shape of shapes) {
    eq(
      l.statusByPath.get(winKey(shape))?.status,
      "M",
      `status of "${shape}" matches M`,
    );
  }
  eq(
    canonicalPath("\\\\?\\E:\\Projects\\repo\\src\\app.cpp"),
    "E:/Projects/repo/src/app.cpp",
    "verbatim prefix canonicalises to a drive path (case is folded by fileKey on Windows)",
  );
}

console.log("workspace given in verbatim form (already canonicalized)");
{
  const l = buildGitStatusLookups(filesModifiedAddedDeleted(), WS_ON_WINDOWS_VERBATIM, winKey);
  eq(
    l.statusByPath.get(winKey("E:/Projects/repo/src/app.cpp"))?.status,
    "M",
    "verbatim workspace maps to the same key",
  );
  ok(
    l.statusByPath.get(winKey("\\\\?\\E:\\Projects\\repo\\src\\app.cpp"))?.status === "M",
    "query with verbatim tree path hits the same entry",
  );
}

console.log("UNC (\\\\?\\UNC\\...) workspace");
{
  const ws = "\\\\?\\UNC\\server\\share";
  const l = buildGitStatusLookups([status({ path: "docs/x.md", status: "M" })], ws, winKey);
  eq(
    canonicalPath("\\\\?\\UNC\\server\\share\\docs\\x.md"),
    "//server/share/docs/x.md",
    "verbatim UNC canonicalises to //server/share/...",
  );
  eq(
    l.statusByPath.get(winKey("//server/share/docs/x.md"))?.status,
    "M",
    "UNC path hit through the canonical key",
  );
}

console.log("POSIX paths (default keyer, case-sensitive)");
{
  const l = buildGitStatusLookups([status({ path: "src/A.cpp", status: "M" })], "/home/user/repo");
  eq(
    l.statusByPath.get(posixKey("/home/user/repo/src/A.cpp"))?.status,
    "M",
    "POSIX path matched",
  );
  ok(
    !l.statusByPath.has(posixKey("/home/user/repo/src/a.cpp")),
    "POSIX keys stay case-sensitive",
  );
  eq(
    resolveAgainstWorkspace("src/A.cpp", "/home/user/repo"),
    "/home/user/repo/src/A.cpp",
    "resolveAgainstWorkspace joins with / on POSIX",
  );
}

console.log("Chinese + spaces in file names");
{
  const files = [
    status({ path: "中文/新文件.cpp", status: "A" }),
    status({ path: "with space.txt", status: "M" }),
  ];
  const l = buildGitStatusLookups(files, WS_ON_WINDOWS, winKey);
  eq(l.statusByPath.get(winKey("E:/Projects/repo/中文/新文件.cpp"))?.status, "A", "Chinese name matched");
  eq(l.statusByPath.get(winKey("E:/Projects/repo/with space.txt"))?.status, "M", "name with spaces matched");
}

console.log("no git workspace -> empty lookups");
{
  const l = buildGitStatusLookups(filesModifiedAddedDeleted(), null, winKey);
  eq(l.statusByPath.size, 0, "no workspace -> no file entries");
  eq(l.dirStatusByPath.size, 0, "no workspace -> no dir entries");
  const l2 = buildGitStatusLookups([], WS_ON_WINDOWS, winKey);
  eq(l2.statusByPath.size, 0, "empty snapshot -> empty maps");
}

console.log("folder aggregates");
{
  const files = [
    status({ path: "src/deep/app.cpp", status: "A" }),
    status({ path: "src/app.cpp", status: "M" }),
    status({ path: "src/old.cpp", status: "D" }),
    status({ path: "root.txt", status: "M" }),
  ];
  const l = buildGitStatusLookups(files, WS_ON_WINDOWS, winKey);
  eq(
    l.dirStatusByPath.get(winKey("E:/Projects/repo/src"))?.status,
    "M",
    "folder shows the most significant descendant status (M over D/A)",
  );
  eq(
    l.dirStatusByPath.get(winKey("E:/Projects/repo/src/deep"))?.status,
    "A",
    "nested folder aggregate",
  );
  ok(
    !l.dirStatusByPath.has(winKey("E:/Projects/repo")),
    "workspace root itself is never marked",
  );
}

if (failures > 0) {
  throw new Error(`${failures} git-status mapping test(s) FAILED`);
} else {
  console.log("all git-status mapping tests passed");
}