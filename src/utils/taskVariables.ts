import { basename, dirname } from "./language";

/**
 * Substitution variables supported in task commands. Both the workspace-based
 * and the file-based set are resolved at run time.
 */
const FILE_VARS = new Set([
  "file",
  "fileBasename",
  "fileBasenameNoExtension",
  "fileDirname",
  "relativeFile",
  "relativeFileDirname",
]);

/** Whether a command uses at least one variable that needs an open file. */
export function needsActiveFile(command: string): boolean {
  for (const name of FILE_VARS) {
    if (command.includes(`\${${name}}`)) return true;
  }
  return false;
}

function basenameNoExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Path of `file` relative to `workspace`, using forward slashes. */
function relativePath(workspace: string, file: string): string {
  const ws = workspace.replace(/[\\/]+$/, "");
  const sep = ws.includes("\\") ? "\\" : "/";
  const rest = file.startsWith(ws + sep) ? file.slice(ws.length + sep.length) : file;
  return rest.replace(/\\/g, "/");
}

/** The workspace-relative directory of `file`; "." when the file sits in the root. */
function relativeDir(workspace: string, file: string): string {
  const rel = relativePath(workspace, file);
  const slash = rel.lastIndexOf("/");
  return slash >= 0 ? rel.slice(0, slash) : ".";
}

/**
 * A Windows extended-length path prefix produced by `fs::canonicalize` on the
 * backend. Shell tools like MinGW `g++` do not understand it, so the absolute
 * path variables are normalized before the command is expanded. Only the value
 * that ends up in the shell command is touched - the workspace's canonical
 * path and the file-system safety logic are left untouched.
 */
export function normalizeTaskPath(path: string): string {
  const UNC_PREFIX = "\\\\?\\UNC\\";
  if (path.startsWith(UNC_PREFIX)) {
    // \\?\UNC\server\share\project -> \\server\share\project
    return "\\\\" + path.slice(UNC_PREFIX.length);
  }
  const EXT_PREFIX = "\\\\?\\";
  if (path.startsWith(EXT_PREFIX)) {
    // \\?\E:\Code\... -> E:\Code\...
    return path.slice(EXT_PREFIX.length);
  }
  return path;
}

/**
 * Resolve the substitution variables in a task command. The `file` variables
 * are left untouched when there is no active file; callers should check
 * `needsActiveFile` first and refuse to run without one.
 */
export function resolveTaskCommand(
  command: string,
  workspacePath: string,
  filePath: string | null,
): string {
  const workspaceFolderBasename =
    basename(workspacePath).replace(/[\\/]+$/, "") || workspacePath;
  return command.replace(/\$\{([a-zA-Z]+)}/g, (match, name: string) => {
    switch (name) {
      case "workspaceFolder":
        return normalizeTaskPath(workspacePath);
      case "workspaceFolderBasename":
        return workspaceFolderBasename;
      case "file":
        return filePath ? normalizeTaskPath(filePath) : match;
      case "fileBasename":
        return filePath ? basename(filePath) : match;
      case "fileBasenameNoExtension":
        return filePath ? basenameNoExtension(filePath) : match;
      case "fileDirname":
        return filePath ? normalizeTaskPath(dirname(filePath)) : match;
      case "relativeFile":
        // Already relative, forward slashes, never carries the extended prefix.
        return filePath ? relativePath(workspacePath, filePath) : match;
      case "relativeFileDirname":
        return filePath ? relativeDir(workspacePath, filePath) : match;
      default:
        return match;
    }
  });
}