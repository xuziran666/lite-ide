import { diffSidesFor } from "./diffSides.ts";
import type { GitFileStatus } from "../commands";

/**
 * Pure unit tests for the Source Control click -> diff-side mapping. Run with:
 *
 *     node src/utils/diffSides.test.ts
 *
 * (Node >= 22 type-strips `.ts` directly; no framework needed.)
 */

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const cond = JSON.stringify(actual) === JSON.stringify(expected);
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(
      `  FAIL ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

function status(partial: Partial<GitFileStatus> & { path: string }): GitFileStatus {
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

console.log("更改 (changes) group");
{
  const m = status({ path: "main.cpp", status: "M", unstagedStatus: "M", unstaged: true });
  eq(diffSidesFor(m, "changes").original, { source: "HEAD", path: "main.cpp" }, "modified -> HEAD vs worktree");
  eq(diffSidesFor(m, "changes").modified, { source: "WORKTREE", path: "main.cpp" }, "modified side is the worktree");

  const untracked = status({ path: "todo.md", status: "?", untracked: true, unstaged: true, unstagedStatus: "?" });
  eq(diffSidesFor(untracked, "changes").original, { source: "EMPTY", path: "todo.md" }, "untracked -> empty vs worktree");

  const unstagedDeleted = status({ path: "gone.txt", status: "D", unstaged: true, unstagedStatus: "D" });
  eq(diffSidesFor(unstagedDeleted, "changes").original, { source: "INDEX", path: "gone.txt" }, "worktree deletion -> index vs empty");
  eq(diffSidesFor(unstagedDeleted, "changes").modified, { source: "EMPTY", path: "gone.txt" }, "deleted side never reads the worktree");
}

console.log("已暂存 (staged) group");
{
  const stagedM = status({ path: "main.cpp", status: "M", staged: true, stagedStatus: "M" });
  eq(diffSidesFor(stagedM, "staged").original, { source: "HEAD", path: "main.cpp" }, "staged modified -> HEAD vs index");
  eq(diffSidesFor(stagedM, "staged").modified, { source: "INDEX", path: "main.cpp" }, "modified side is the index");

  const stagedA = status({ path: "new.cpp", status: "A", staged: true, stagedStatus: "A" });
  eq(diffSidesFor(stagedA, "staged").original, { source: "EMPTY", path: "new.cpp" }, "staged added -> empty vs index");

  const stagedD = status({ path: "old.cpp", status: "D", staged: true, stagedStatus: "D" });
  eq(diffSidesFor(stagedD, "staged").original, { source: "HEAD", path: "old.cpp" }, "staged deletion -> HEAD vs index (index side empty)");
}

console.log("both staged and modified (MM)");
{
  const mm = status({ path: "main.cpp", status: "M", staged: true, unstaged: true, stagedStatus: "M", unstagedStatus: "M" });
  eq(diffSidesFor(mm, "changes").original, { source: "INDEX", path: "main.cpp" }, "更改 click -> index vs worktree");
  eq(diffSidesFor(mm, "changes").modified, { source: "WORKTREE", path: "main.cpp" }, "worktree side for changes click");
  eq(diffSidesFor(mm, "staged").original, { source: "HEAD", path: "main.cpp" }, "已暂存 click -> HEAD vs index");
  eq(diffSidesFor(mm, "staged").modified, { source: "INDEX", path: "main.cpp" }, "index side for staged click");
}

console.log("added then modified (AM)");
{
  const am = status({ path: "new.cpp", status: "A", staged: true, unstaged: true, stagedStatus: "A", unstagedStatus: "M" });
  eq(diffSidesFor(am, "changes").original, { source: "INDEX", path: "new.cpp" }, "changes click compares against the staged add");
  eq(diffSidesFor(am, "staged").original, { source: "EMPTY", path: "new.cpp" }, "staged click is empty -> index");
}

console.log("rename uses the pre-rename path on the original side");
{
  const renamed = status({ path: "new.cpp", status: "R", staged: true, stagedStatus: "R", renamedFrom: "old.cpp" });
  eq(diffSidesFor(renamed, "staged").original, { source: "HEAD", path: "old.cpp" }, "HEAD side reads the old path");
  eq(diffSidesFor(renamed, "staged").modified, { source: "INDEX", path: "new.cpp" }, "index side is the new path");
}

if (failures > 0) {
  throw new Error(`${failures} diff-sides test(s) FAILED`);
} else {
  console.log("all diff-sides tests passed");
}