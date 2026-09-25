import { buildCommitTree } from "./gitCommitTree.ts";
import type { CommitTreeNode } from "./gitCommitTree.ts";
import type { GitCommitFile } from "../commands";

/**
 * Pure unit tests for the commit file directory tree. Run:
 *
 *     node src/utils/gitCommitTree.test.ts
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

function names(nodes: CommitTreeNode[]): string[] {
  return nodes.map((n) => `${n.kind}:${n.name}`);
}

console.log("single root file");
{
  const tree = buildCommitTree([file({ path: "main.cpp", status: "M" })]);
  eq(names(tree), ["file:main.cpp"], "one file at the root");
  eq(tree[0].status, "M", "status preserved");
  eq(tree[0].children, undefined, "files have no children");
}

console.log("files nest into directories");
{
  const tree = buildCommitTree([
    file({ path: "src/lib/util.cpp", status: "M" }),
    file({ path: "src/main.cpp", status: "M" }),
  ]);
  eq(names(tree), ["dir:src"], "single top-level directory");
  const src = tree[0].children!;
  eq(names(src), ["dir:lib", "file:main.cpp"], "dirs first, then files");
  eq(names(src[0].children!), ["file:util.cpp"], "nested lib");
}

console.log("directories sort first, case-insensitively");
{
  const tree = buildCommitTree([
    file({ path: "Zebra.cpp", status: "A" }),
    file({ path: "app/thing.cpp", status: "A" }),
    file({ path: "zoo.cpp", status: "A" }),
    file({ path: "Apple.cpp", status: "A" }),
  ]);
  eq(names(tree), ["dir:app", "file:Apple.cpp", "file:Zebra.cpp", "file:zoo.cpp"], "dirs first, files alpha (case-insensitive)");
}

console.log("deep unicode path");
{
  const tree = buildCommitTree([
    file({ path: "中文/新 文件.txt", status: "M" }),
  ]);
  eq(tree[0].name, "中文", "directory name is the segment");
  eq(tree[0].path, "中文/", "directory path keeps the trailing slash");
  eq(tree[0].children![0].name, "新 文件.txt", "filename kept verbatim");
}

console.log("two files in the same directory reuse one node");
{
  const tree = buildCommitTree([
    file({ path: "a/b/one.cpp", status: "A" }),
    file({ path: "a/b/two.cpp", status: "A" }),
  ]);
  const a = tree[0].children![0];
  eq(names(tree[0].children!), ["dir:b"], "single b node");
  eq(names(a.children!), ["file:one.cpp", "file:two.cpp"], "both files under b");
}

console.log("multiple top-level directories + files");
{
  const tree = buildCommitTree([
    file({ path: "scripts/build.ps1", status: "M" }),
    file({ path: "README.md", status: "M" }),
    file({ path: "src/App.tsx", status: "M" }),
  ]);
  eq(names(tree), ["dir:scripts", "dir:src", "file:README.md"], "dirs alpha, then the root file");
}

console.log("rename keeps status and old path on the file node");
{
  const tree = buildCommitTree([file({ path: "new.cpp", status: "R", oldPath: "old.cpp" })]);
  eq(tree[0].status, "R", "status preserved");
  eq(tree[0].oldPath, "old.cpp", "old path preserved");
}

console.log("empty input");
{
  eq(buildCommitTree([]), [], "no files -> empty tree");
}

if (failures > 0) {
  throw new Error(`${failures} git-commit-tree test(s) FAILED`);
} else {
  console.log("all git-commit-tree tests passed");
}