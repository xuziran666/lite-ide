// The `.ts` extension matches `debug/launchConfig.ts`: it lets Node load this
// module directly for its test. Vite and tsc resolve both forms.
import { canonicalPath } from "../utils/pathIdentity.ts";

/**
 * The path to put in a DAP message -- `Source.path`, and any other path an
 * adapter compares against its own debug information.
 *
 * Two rules, both of which matter on Windows:
 *
 * 1. **The case is preserved exactly.** A debug adapter matches this string
 *    against the paths baked into the debug information (for GDB, what
 *    `info sources` prints), and that comparison is case-sensitive on the
 *    adapter's side. `E:\Code\CorC++\Algorithm_Win\test.cpp` is that file;
 *    `e:/code/corc++/algorithm_win/test.cpp` is a different string, which is
 *    why GDB answers `No source file named ...` and leaves the breakpoint
 *    pending. The *identity* key (`fileKey`, deliberately case-folded on
 *    Windows) must therefore never reach an adapter -- this function exists to
 *    make that impossible to get wrong.
 * 2. **Windows paths use backslashes.** `canonicalPath` normalizes to forward
 *    slashes for identity comparison and for Monaco URIs; a Windows adapter
 *    spells its own paths with the native separator, and only that spelling is
 *    byte-identical to the debug information.
 *
 * Which form applies is decided by the **shape of the path**, never by
 * `navigator.userAgent`: a drive letter or a UNC prefix means Windows
 * separators, and anything else is returned unchanged. That keeps POSIX
 * behavior untouched and makes this function testable under Node, where
 * `navigator` is absent.
 */
export function dapSourcePath(path: string): string {
  const canonical = canonicalPath(path);
  return isWindowsShaped(canonical)
    ? canonical.replace(/\//g, "\\")
    : canonical;
}

/** Whether a canonical path is a Windows one (`E:/...`, `//server/share/...`). */
function isWindowsShaped(canonical: string): boolean {
  return /^[A-Za-z]:\//.test(canonical) || canonical.startsWith("//");
}
