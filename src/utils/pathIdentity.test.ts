import {
  canonicalPath,
  isAbsolutePath,
  isPathInsideWorkspace,
  resolveAgainstWorkspace,
  sameFile,
} from "./pathIdentity.ts";
import type { GitFileStatus } from "../commands";

/**
 * Pure unit tests for the path-identity layer used by every navigation
 * feature (Source Control click, file tree, Quick Open, global search, LSP).
 * Run with:
 *
 *     node src/utils/pathIdentity.test.ts
 *
 * (Node >= 22 type-strips `.ts` directly; no framework needed.)
 *
 * These pin the exact regression behind "Not a file: \\?\E:\..." when clicking
 * a file in Git Source Control: the resolve chain must produce one canonical
 * identity no matter whether the workspace is stored verbatim (`\\?\E:\...`),
 * UNC (`\\?\UNC\...`), plain Windows or POSIX — and deletion entries must never
 * be treated as openable on-disk files.
 *
 * Note: `fileKey` folds case only when `navigator.userAgent` reports Windows,
 * which is absent under Node (POSIX-like behavior). The assertions here only
 * depend on canonical prefix/suffix handling, so they are valid in both modes.
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
  const cond = JSON.stringify(actual) === JSON.stringify(expected);
  if (cond) {
    console.log(`  ok   ${msg} (${JSON.stringify(expected)})`);
  } else {
    failures += 1;
    console.error(
      `  FAIL ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

/** Mirrors `isDeletedFile` in SourceControlPanel (staged or unstaged D). */
function isDeletedFile(file: Pick<GitFileStatus, "stagedStatus" | "unstagedStatus">): boolean {
  return file.stagedStatus === "D" || file.unstagedStatus === "D";
}

const REL = "笔记/时间复杂度判断.md";
const WS = "E:\\Code\\CorC++\\Algorithm_Win";
const WS_VERBATIM = "\\\\?\\E:\\Code\\CorC++\\Algorithm_Win";

console.log("resolveAgainstWorkspace: git relative path + plain Windows workspace");
{
  const abs = resolveAgainstWorkspace(REL, WS);
  eq(abs, "E:\\Code\\CorC++\\Algorithm_Win\\笔记/时间复杂度判断.md", "joined with backslash separator");
  eq(canonicalPath(abs), "E:/Code/CorC++/Algorithm_Win/笔记/时间复杂度判断.md", "canonical form");
}

console.log("resolveAgainstWorkspace: git relative path + verbatim workspace");
{
  const abs = resolveAgainstWorkspace(REL, WS_VERBATIM);
  eq(abs, "\\\\?\\E:\\Code\\CorC++\\Algorithm_Win\\笔记/时间复杂度判断.md", "verbatim prefix kept while resolving");
  eq(
    canonicalPath(abs),
    "E:/Code/CorC++/Algorithm_Win/笔记/时间复杂度判断.md",
    "canonical form strips the verbatim prefix",
  );
  ok(
    sameFile(abs, resolveAgainstWorkspace(REL, WS)),
    "verbatim and plain workspace resolve to the same file identity",
  );
  ok(
    isPathInsideWorkspace(canonicalPath(abs), WS_VERBATIM),
    "resolved target is inside the verbatim workspace",
  );
}

console.log("workspace with trailing separator / null workspace");
{
  eq(
    resolveAgainstWorkspace(REL, WS + "\\"),
    "E:\\Code\\CorC++\\Algorithm_Win\\笔记/时间复杂度判断.md",
    "trailing separator is not duplicated",
  );
  eq(resolveAgainstWorkspace(REL, null), REL, "no workspace -> path kept as-is");
  eq(resolveAgainstWorkspace("E:\\abs\\x.cpp", WS), "E:\\abs\\x.cpp", "absolute input never re-joined");
}

console.log("canonicalPath across Windows / UNC / verbatim / POSIX");
{
  eq(canonicalPath("\\\\?\\E:\\a\\b\\c.ts"), "E:/a/b/c.ts", "verbatim drive");
  eq(canonicalPath("E:\\a\\b\\c.ts"), "E:/a/b/c.ts", "plain backslashes");
  eq(canonicalPath("\\\\server\\share\\x.ts"), "//server/share/x.ts", "UNC");
  eq(canonicalPath("\\\\?\\UNC\\server\\share\\x.ts"), "//server/share/x.ts", "verbatim UNC");
  eq(canonicalPath("\\\\?\\UNC\\server\\share\\x.ts"), canonicalPath("\\\\server\\share\\x.ts"), "verbatim UNC == UNC identity");
  eq(canonicalPath("/home/fedora/project/a.cpp"), "/home/fedora/project/a.cpp", "POSIX unchanged");
  eq(canonicalPath("NOTE/新笔记 2.md"), "NOTE/新笔记 2.md", "Chinese + spaces unchanged");
}

console.log("sameFile: one identity across shapes");
{
  ok(sameFile("\\\\?\\E:\\Code\\CorC++\\Algorithm_Win\\笔记\\时间复杂度判断.md", "E:/Code/CorC++/Algorithm_Win/笔记/时间复杂度判断.md"), "verbatim == canonical");
  ok(sameFile("\\\\?\\UNC\\server\\share\\proj\\a.cpp", "//server/share/proj/a.cpp"), "verbatim UNC == UNC");
  ok(sameFile("C:\\Users\\me\\repo\\src\\main.cpp", "C:/Users/me/repo/src/main.cpp"), "backslash == forward slash");
}

console.log("isAbsolutePath");
{
  ok(isAbsolutePath("E:\\a\\b"), "drive absolute");
  ok(isAbsolutePath("e:/a/b"), "lowercase drive absolute");
  ok(isAbsolutePath("\\\\server\\share"), "UNC absolute");
  ok(isAbsolutePath("/home/u/x"), "POSIX absolute");
  ok(!isAbsolutePath("笔记/时间复杂度判断.md"), "git-relative path is not absolute");
}

console.log("the reported regression: deleted Git entry is not openable");
{
  const stagedDelete = { stagedStatus: "D", unstagedStatus: " " };
  const unstagedDelete = { stagedStatus: " ", unstagedStatus: "D" };
  const addedThenWorktreeDeleted = { stagedStatus: "A", unstagedStatus: "D" };
  const modified = { stagedStatus: "M", unstagedStatus: " " };
  ok(isDeletedFile(stagedDelete), "staged deletion (D in column X) detected");
  ok(isDeletedFile(unstagedDelete), "unstaged deletion (D in column Y) detected");
  ok(isDeletedFile(addedThenWorktreeDeleted), "AD (added then worktree-deleted) detected through column Y");
  ok(!isDeletedFile(modified), "modified file stays openable");
}

console.log("regression intent: what actually failed before the fix");
{
  // Rust `do_read_file` canonicalizes the deepest existing ancestor and appends
  // the remaining leaf, so for a deleted file the read surfaces exactly as
  // `Not a file: \\?\E:\Code\CorC++\Algorithm_Win\笔记\时间复杂度判断.md` — the
  // verbatim prefix in the message is just the canonical form, NOT the bug. The
  // file is simply gone. The resolve chain itself is correct (verified above);
  // the panel now refuses to open deletion entries, so the failing read is never
  // reached. These assertions pin the resolved identity for that exact scenario.
  eq(
    canonicalPath(resolveAgainstWorkspace(REL, WS_VERBATIM)),
    "E:/Code/CorC++/Algorithm_Win/笔记/时间复杂度判断.md",
    "verbatim workspace + deleted git path resolves to the exact leaf",
  );
  eq(
    canonicalPath(resolveAgainstWorkspace(REL, WS)),
    canonicalPath(resolveAgainstWorkspace(REL, WS_VERBATIM)),
    "plain and verbatim workspaces yield one identity for a Chinese/space path",
  );
}

if (failures > 0) {
  throw new Error(`${failures} path-identity test(s) FAILED`);
} else {
  console.log("all path-identity tests passed");
}