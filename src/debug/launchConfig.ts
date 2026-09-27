// `.ts` extensions so this module runs directly under `node` for its test.
import { basename, dirname } from "../utils/language.ts";
import { normalizeTaskPath } from "../utils/taskVariables.ts";
import type { DapLaunchArguments } from "./protocol.ts";

/**
 * Building the `launch` request from `debug.launch.<languageId>`.
 *
 * Two rules make this language-agnostic:
 *
 * 1. **Defaults are data, not code.** `program`'s default value is a
 *    *conventional build path* for the C/C++ toolchain, expressed as a string
 *    (`build/app`, with `.exe` appended on Windows). It is a value in a table
 *    below, editable by the user in `user.json`, not an `if (language === "cpp")`
 *    branch. Any other language simply has no default and must set `program`
 *    itself — or the backend reports that the program does not exist.
 * 2. **No debugger knowledge.** Nothing here knows about GDB, LLDB, MIMode or
 *    `stopOnEntry` semantics; those are the adapter's business, driven by the
 *    JSON the user wrote.
 *
 * Variable expansion mirrors tasks (`${workspaceFolder}`, `${file}`, …) so a
 * launch config reads like a task command, and reuses `normalizeTaskPath` so the
 * Windows `\\?\` prefix that `canonicalize` produces never reaches an adapter.
 */

/**
 * Per-language `program` defaults. There is no entry for a language that has no
 * conventional build layout — an empty table is the correct answer there, not a
 * missing feature.
 */
const PROGRAM_DEFAULTS: Record<string, string> = {
  // The conventional CMake/Ninja output name for a C/C++ project. Edit it in
  // `debug.launch.cpp` when the project uses another layout.
  cpp: "build/app",
};

/**
 * Per-language launch-argument defaults, merged *under* the user's
 * `debug.launch.<language>`.
 *
 * `console: "integratedTerminal"` asks lldb-dap to run the program in a
 * terminal (via the DAP `runInTerminal` request) instead of piping its stdio.
 * That is what makes `stdin` interactive and keeps the program's own stdout
 * out of the Output panel. A user who prefers the old behavior sets
 * `"console": "internalConsole"` in their launch config.
 */
const LAUNCH_DEFAULTS: Record<string, Record<string, unknown>> = {
  cpp: { console: "integratedTerminal" },
};

/** `true` on Windows, where executables carry an extension. */
function isWindows(): boolean {
  return navigator.userAgent.includes("Windows");
}

/** The default program for a language, platform suffix included. */
export function defaultProgram(
  language: string,
  workspacePath: string,
): string | undefined {
  const relative = PROGRAM_DEFAULTS[language];
  if (!relative || !workspacePath) return undefined;
  const program = `${workspacePath.replace(/[\\/]+$/, "")}/${relative}`;
  return isWindows() && !/\.[A-Za-z0-9]+$/.test(relative)
    ? `${program}.exe`
    : program;
}

/** Values available to `${…}` in a launch configuration. */
export interface LaunchContext {
  workspacePath: string;
  /** The active file, when one is open. */
  filePath: string | null;
  /** The program being launched, so `${fileBasenameNoExtension}.o` style names resolve. */
  program?: string;
}

function basenameNoExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function relativePath(workspace: string, file: string): string {
  const ws = workspace.replace(/[\\/]+$/, "");
  const sep = ws.includes("\\") ? "\\" : "/";
  const rest = file.startsWith(ws + sep) ? file.slice(ws.length + sep.length) : file;
  return rest.replace(/\\/g, "/");
}

/**
 * Expand `${…}` in every string of a launch configuration, recursively.
 *
 * Recursion is what makes a nested config work: `program` may itself be
 * `${workspaceFolder}/build/${fileBasenameNoExtension}`, and `args` may contain
 * the same variables. An unknown variable is left untouched rather than blanked,
 * so a typo is visible in the error the adapter gives instead of silently
 * producing a wrong path.
 */
export function expandLaunchConfig<T>(value: T, context: LaunchContext): T {
  if (typeof value === "string") {
    return expandString(value, context) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandLaunchConfig(item, context)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = expandLaunchConfig(item, context);
    }
    return out as unknown as T;
  }
  return value;
}

function expandString(
  value: string,
  context: LaunchContext,
): string {
  const { workspacePath, filePath } = context;
  return value.replace(/\$\{([a-zA-Z]+)\}/g, (match, name: string) => {
    switch (name) {
      case "workspaceFolder":
        return normalizeTaskPath(workspacePath);
      case "workspaceFolderBasename":
        return basename(workspacePath).replace(/[\\/]+$/, "") || workspacePath;
      case "file":
        return filePath ? normalizeTaskPath(filePath) : match;
      case "fileBasename":
        return filePath ? basename(filePath) : match;
      case "fileBasenameNoExtension":
        return filePath ? basenameNoExtension(filePath) : match;
      case "fileDirname":
        return filePath ? normalizeTaskPath(dirname(filePath)) : match;
      case "relativeFile":
        return filePath ? relativePath(workspacePath, filePath) : match;
      case "fileDirnameBasename":
        return filePath ? basename(dirname(filePath)) : match;
      case "program":
        return context.program ?? match;
      case "programBasename":
        return context.program ? basenameNoExtension(context.program) : match;
      default:
        return match;
    }
  });
}

/**
 * Assemble the DAP `launch` arguments.
 *
 * Precedence is defaults → user config → expanded variables, so a user always
 * wins, and the result is a plain object forwarded to the adapter untouched.
 * The user's own `cwd` is respected; otherwise the workspace is used, which is
 * what every adapter expects for relative paths in `program` and `args`.
 */
export function buildLaunchArguments(
  language: string,
  configured: Record<string, unknown> | undefined,
  context: LaunchContext,
): DapLaunchArguments {
  const kind = requestKindOf(configured);
  // `request` selects the DAP request, so it is not itself an argument; sending
  // it through would hand the adapter a key it never asked for.
  const { request: _request, ...rest } = configured ?? {};
  const merged: Record<string, unknown> = {
    ...LAUNCH_DEFAULTS[language],
    ...rest,
  };
  // An attach target is already running, so there is no local program to default
  // — injecting one would make the adapter try to launch a binary the user never
  // mentioned. The user's own values (a pid, a process name, …) flow through.
  if (kind === "launch") {
    const program = defaultProgram(language, context.workspacePath);
    if ((typeof merged.program !== "string" || merged.program === "") && program) {
      merged.program = program;
    }
  }
  if (typeof merged.cwd !== "string" || merged.cwd === "") {
    if (context.workspacePath) merged.cwd = context.workspacePath;
  }
  // `stopOnEntry: false` is the useful default: the user asked to debug, and
  // stopping at `main` before their breakpoints are meaningful is noise. It is
  // still just a value they can override.
  if (typeof merged.stopOnEntry !== "boolean") {
    merged.stopOnEntry = false;
  }
  // `merged.program` is already the user's value or, when they gave none, the
  // default filled in above. It is deliberately *not* re-spread here: doing so
  // would overwrite the user's program with the default, which is the opposite
  // of the precedence documented above.
  return expandLaunchConfig(merged, {
    ...context,
    program: typeof merged.program === "string" ? merged.program : undefined,
  });
}

/** A short description of the launch configuration, for the toolbar tooltip. */
export function describeLaunch(
  language: string,
  args: DapLaunchArguments,
): string {
  const program = typeof args.program === "string" ? args.program : "(no program)";
  return `${language}: ${program}`;
}

/** Which DAP request a configuration asks for. Defaults to `launch`. */
export type DebugRequestKind = "launch" | "attach";

/**
 * Read the request kind from a configuration.
 *
 * `request` is the same field VS Code's `launch.json` uses, which is why launch
 * and attach configurations can share one `debug.launch.<language>` entry
 * instead of needing two: a config with `"request": "attach"` attaches, and one
 * with no `request` (or `"request": "launch"`) launches. Any other value falls
 * back to launch rather than failing — an unknown request name is a typo, and a
 * failed launch reports the real problem better than "unsupported request".
 */
export function requestKindOf(
  configured: Record<string, unknown> | undefined,
): DebugRequestKind {
  return configured?.request === "attach" ? "attach" : "launch";
}
