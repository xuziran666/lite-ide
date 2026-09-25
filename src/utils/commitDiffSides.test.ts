import { commitDiffSides, shortHash } from "./commitDiffSides.ts";
import type { GitCommitFile } from "../commands";

/**
 * Pure unit tests for the History panel click -> commit diff-side mapping. Run:
 *
 *     node src/utils/commitDiffSides.test.ts
 */

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(
      `  FAIL ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

function file(partial: Partial<GitCommitFile> & { path: string }): GitCommitFile {
  return { status: "M", oldPath: null, ...partial };
}

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const PARENT = "fedcba9876543210fedcba9876543210fedcba98";

console.log("shortHash");
{
  eq(shortHash(COMMIT), "abcdef0", "full hash -> 7 chars");
  eq(shortHash(null), undefined, "null -> undefined");
  eq(shortHash(""), undefined, "empty -> undefined");
  eq(shortHash("abc"), "abc", "already-short hash passes through");
}

console.log("modified");
{
  const sides = commitDiffSides(file({ path: "src/main.cpp", status: "M" }), COMMIT, PARENT);
  eq(sides.original, {
    source: "COMMIT",
    path: "src/main.cpp",
    commit: PARENT,
    label: "fedcba9: src/main.cpp",
  }, "original side is the parent commit");
  eq(sides.modified, {
    source: "COMMIT",
    path: "src/main.cpp",
    commit: COMMIT,
    label: "abcdef0: src/main.cpp",
  }, "modified side is the commit itself");
}

console.log("added");
{
  const sides = commitDiffSides(file({ path: "new.cpp", status: "A" }), COMMIT, PARENT);
  eq(sides.original, { source: "EMPTY", path: "new.cpp" }, "original is empty");
  eq(sides.modified.label, "abcdef0: new.cpp", "modified reads the new file");
}

console.log("deleted");
{
  const sides = commitDiffSides(file({ path: "gone.cpp", status: "D" }), COMMIT, PARENT);
  eq(sides.original.label, "fedcba9: gone.cpp", "original reads the parent");
  eq(sides.modified, { source: "EMPTY", path: "gone.cpp" }, "modified is empty");
}

console.log("rename uses old path on the parent side");
{
  const renamed = file({ path: "new.cpp", status: "R", oldPath: "old.cpp" });
  const sides = commitDiffSides(renamed, COMMIT, PARENT);
  eq(sides.original.path, "old.cpp", "parent side reads pre-rename path");
  eq(sides.original.label, "fedcba9: old.cpp", "label shows the old path");
  eq(sides.modified.path, "new.cpp", "commit side reads the new path");
}

console.log("copy mirrors rename");
{
  const copied = file({ path: "copy.cpp", status: "C", oldPath: "src.cpp" });
  const sides = commitDiffSides(copied, COMMIT, PARENT);
  eq(sides.original.path, "src.cpp", "copy parent side reads the source");
  eq(sides.modified.path, "copy.cpp", "copy commit side reads the copy");
}

console.log("unknown status falls back to modified");
{
  const sides = commitDiffSides(file({ path: "odd.txt", status: "?" }), COMMIT, PARENT);
  eq(sides.original.label, "fedcba9: odd.txt", "original compares the parent");
  eq(sides.modified.label, "abcdef0: odd.txt", "modified compares the commit");
}

console.log("root commit (no parent) keeps empty for adds");
{
  const sides = commitDiffSides(file({ path: "only.txt", status: "A" }), COMMIT, null);
  eq(sides.original, { source: "EMPTY", path: "only.txt" }, "add needs no parent");
  eq(sides.modified.label, "abcdef0: only.txt", "commit side still labelled");
}

console.log("no commit hash degrades to a HEAD label");
{
  const sides = commitDiffSides(file({ path: "a.txt", status: "M" }), null, PARENT);
  eq(sides.modified.label, "HEAD: a.txt", "modified falls back to HEAD");
  eq(sides.modified.commit, undefined, "commit omitted");
}

if (failures > 0) {
  throw new Error(`${failures} commit-diff-sides test(s) FAILED`);
} else {
  console.log("all commit-diff-sides tests passed");
}