import { dapSourcePath } from "./sourcePath.ts";
import { breakpointRequest } from "./stateMachine.ts";
import { canonicalPath } from "../utils/pathIdentity.ts";

/**
 * Pure unit tests for the path that goes into a DAP message. Run with:
 *
 *     node src/debug/sourcePath.test.ts
 *
 * (Node >= 22 type-strips `.ts` directly; no framework needed.)
 *
 * This pins the regression behind
 *
 *     No source file named e:/code/corc++/algorithm_win/test.cpp.
 *     Breakpoint 1 (...) pending.
 *
 * The `setBreakpoints` payload carried the **identity key** (`fileKey`, which
 * folds case on Windows) instead of the real path, so GDB could not match it
 * against its debug information and never bound the breakpoint.
 *
 * `navigator` is absent under Node, so the platform-dependent `fileKey` cannot
 * be exercised here -- which is exactly why `dapSourcePath` decides by the
 * *shape* of the path and can therefore be tested on any platform.
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
      `  FAIL ${msg} -- got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
    );
  }
}

/** The workspace/file from the bug report, verbatim. */
const WINDOWS_FILE = "E:\\Code\\CorC++\\Algorithm_Win\\test.cpp";
/** What `fileKey` produces on Windows: the form that must never be sent. */
const LOWERCASED = "e:/code/corc++/algorithm_win/test.cpp";

console.log("dapSourcePath: a Windows path reaches the adapter as the compiler wrote it");
{
  eq(dapSourcePath(WINDOWS_FILE), WINDOWS_FILE, "a native Windows path is sent unchanged");
  eq(
    dapSourcePath("E:/Code/CorC++/Algorithm_Win/test.cpp"),
    WINDOWS_FILE,
    "the canonical (forward-slash) form becomes the native one",
  );
  eq(
    dapSourcePath("\\\\?\\E:\\Code\\CorC++\\Algorithm_Win\\test.cpp"),
    WINDOWS_FILE,
    "the verbatim prefix is stripped",
  );
  ok(
    dapSourcePath(WINDOWS_FILE) !== LOWERCASED,
    "the case-folded identity form is never produced",
  );
  eq(
    dapSourcePath("e:\\code\\corc++\\algorithm_win\\test.cpp"),
    "e:\\code\\corc++\\algorithm_win\\test.cpp",
    "case is never rewritten, only preserved",
  );
  eq(
    dapSourcePath("D:\\Code\\Project\\main.cpp"),
    "D:\\Code\\Project\\main.cpp",
    "the drive-letter case is preserved too",
  );
}

console.log("dapSourcePath: UNC and POSIX paths");
{
  eq(
    dapSourcePath("\\\\?\\UNC\\server\\share\\proj\\a.cpp"),
    "\\\\server\\share\\proj\\a.cpp",
    "a verbatim UNC path becomes the native UNC form",
  );
  eq(
    dapSourcePath("//server/share/proj/a.cpp"),
    "\\\\server\\share\\proj\\a.cpp",
    "a canonical UNC path becomes the native UNC form",
  );
  eq(
    dapSourcePath("/home/dev/project/src/main.cpp"),
    "/home/dev/project/src/main.cpp",
    "POSIX paths are untouched, separators included",
  );
  eq(dapSourcePath("src/main.cpp"), "src/main.cpp", "a relative POSIX path is untouched");
}

console.log("breakpointRequest: the payload carries the real path, not the identity key");
{
  const payload = breakpointRequest(WINDOWS_FILE, [6]);
  eq(payload.source.path, WINDOWS_FILE, "setBreakpoints sends the real Windows path");
  ok(payload.source.path !== LOWERCASED, "...and not the lowercased form");
  eq(payload.breakpoints, [{ line: 6 }], "lines stay 1-based and untouched");
  eq(payload.sourceModified, false, "sourceModified stays false");

  eq(
    breakpointRequest(canonicalPath(WINDOWS_FILE), [6]).source.path,
    WINDOWS_FILE,
    "the canonical path a Monaco model holds is converted back for the adapter",
  );
}

console.log("breakpointRequest: POSIX files keep their forward slashes");
{
  eq(
    breakpointRequest("/ws/main.cpp", [12, 3]).source.path,
    "/ws/main.cpp",
    "a Linux/macOS path is byte-identical to what the adapter sees",
  );
}

if (failures > 0) {
  throw new Error(`${failures} debug source-path test(s) FAILED`);
} else {
  console.log("all debug source-path tests passed");
}
