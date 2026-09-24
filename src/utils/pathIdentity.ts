/**
 * Single source of truth for "is this the same physical file?".
 *
 * The same file reaches the app in several shapes, depending on the entry
 * point:
 *  - the file tree uses absolute paths with backslashes and, because the
 *    backend `canonicalize`s the workspace, often the Windows verbatim prefix
 *    (`\\?\E:\...`);
 *  - LSP positions arrive as `file:///e:/...` URIs (forward slashes, lowercased
 *    drive) and are converted back with `fileUriToPath`;
 *  - Quick Open / global search pass workspace-relative paths.
 *
 * `configPath`/`fileKey` collapse all of these to one identity so a file can
 * only ever own a single tab and a single Monaco model. Comparison is
 * case-insensitive on Windows only; POSIX paths stay case-sensitive.
 */

/** Whether the app runs on Windows (case-insensitive paths, drive letters). */
export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** Forward-slash form with any Windows verbatim (`\\?\`) prefix removed. */
export function canonicalPath(path: string): string {
  let p = path.replace(/\\/g, "/");
  const unc = p.match(/^\/\/\?\/?UNC\/(.*)$/i);
  if (unc) {
    p = "//" + unc[1];
  } else if (p.startsWith("//?")) {
    p = p.slice(4).replace(/^\/+/, "");
  }
  return p;
}

/** Comparison key: canonical path, lowercased on Windows, verbatim on POSIX. */
export function fileKey(path: string): string {
  const canonical = canonicalPath(path);
  return isWindowsPlatform() ? canonical.toLowerCase() : canonical;
}

export function sameFile(a: string, b: string): boolean {
  return fileKey(a) === fileKey(b);
}

/** Whether a path is absolute (Windows drive, UNC, or POSIX root). */
export function isAbsolutePath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) || p.startsWith("//") || p.startsWith("/");
}

/** Resolve a possibly workspace-relative path against the workspace root. */
export function resolveAgainstWorkspace(
  path: string,
  workspace: string | null,
): string {
  if (isAbsolutePath(path) || !workspace) return path;
  const sep = workspace.includes("\\") ? "\\" : "/";
  return workspace.endsWith(sep) ? workspace + path : workspace + sep + path;
}

/** Whether `path` is the workspace root or lies inside it. */
export function isPathInsideWorkspace(
  path: string,
  workspace: string | null,
): boolean {
  if (!workspace) return false;
  const root = fileKey(workspace).replace(/\/+$/, "");
  const needle = fileKey(path);
  return needle === root || needle.startsWith(root + "/");
}
