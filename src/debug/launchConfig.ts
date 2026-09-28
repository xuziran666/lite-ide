// `.ts` extensions so this module runs directly under `node` for its test.
import { basename, dirname } from "../utils/language.ts";
import { normalizeTaskPath } from "../utils/taskVariables.ts";
import { asRecord, asString } from "./protocol.ts";
import type { DapLaunchArguments } from "./protocol.ts";
import type { DebugAdapterConfig } from "../commands/index.ts";

/**
 * Assembling a DAP `launch` request out of a debug configuration.
 *
 * Two configuration sources feed the same two functions below:
 *
 * - the global `launch.json` (`configurations[]` → `DebugConfiguration`), which
 *   says how to start *this program* and names the adapter through `type`;
 * - `debug.launch.<language>` in `user.json`, the older language-keyed form,
 *   still fully supported and used whenever there is no `launch.json`.
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
    // Normalized like `${workspaceFolder}` is, so an inferred cwd cannot carry
    // the `\\?\` prefix the Windows workspace scan produces — no adapter can
    // use such a path as a working directory.
    if (context.workspacePath) merged.cwd = normalizeTaskPath(context.workspacePath);
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

/* ------------------------------------------------------------------ launch.json --
 *
 * The global `launch.json` (next to `user.json` in the app config directory) is
 * the second half of the debug configuration story, and it exists because two
 * different files answer two different questions:
 *
 *   launch.json  →  "how do I start *this program*?"   (type, program, args, …)
 *   user.json    →  "how do I start *the adapter*?"    (debug.adapters.<type>)
 *
 * Nothing below knows GDB, LLDB or any language. `type` is an adapter id that
 * is looked up as `debug.adapters.<type>`, exactly as `debug.launch.<language>`
 * is today — the only difference is which key the user wrote it under, and
 * `resolveAdapterArgv` accepts the old `cpp` key for a `cpp-gdb` type so an
 * existing `user.json` needs no edit.
 */

/**
 * One entry of the global `launch.json`'s `configurations` array, after
 * validation.
 *
 * The fields the app acts on are named and typed; everything else the user
 * wrote is kept in `extras` so adapter-specific arguments (an LLDB `initCommands`,
 * a `MIMode`, …) still reach the adapter untouched, as they do today through
 * `debug.launch.<language>`.
 */
export interface DebugConfiguration {
  /** Display name; falls back to the entry's position when absent. */
  name: string;
  /** The adapter id: looked up as `debug.adapters[type]`. */
  type: string;
  /** Which DAP request to send. Defaults to `launch`. */
  request: DebugRequestKind;
  program?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Passed through **verbatim** under this name.
   *
   * Deliberately not renamed: the spelling is the adapter's own (`stopAtEntry`
   * for gdb, `stopOnEntry` for lldb-dap), and phase 1 already fills its own
   * `stopOnEntry` default in `buildLaunchArguments`. Inventing a mapping here
   * would add a translation layer for no behavior gain, so a user who needs
   * lldb's spelling writes `stopOnEntry` in the file and it is forwarded like
   * any other extra.
   */
  stopAtEntry?: boolean;
  console?: string;
  /**
   * The entry's own fields that this phase does not model, kept as written.
   *
   * The canonical fields are *removed* when this is built, so merging it can
   * never duplicate a key nor override a validated value — `program` here is
   * always `DebugConfiguration.program` and nothing else.
   */
  extras: Record<string, unknown>;
}

/** A parsed global `launch.json`. */
export interface LaunchFile {
  /** The `version` string when present, otherwise null. */
  version: string | null;
  /** Every entry that validated. Bad entries are dropped, not fatal. */
  configurations: DebugConfiguration[];
  /** One message per rejected file/entry; empty when the file is usable. */
  errors: string[];
}

/** The keys `DebugConfiguration` owns. Everything else ends up in `extras`. */
const CANONICAL_KEYS = new Set([
  "name",
  "type",
  "request",
  "program",
  "cwd",
  "args",
  "env",
  "stopAtEntry",
  "console",
]);

/** Describe an entry in an error message, even when its `name` is unusable. */
function labelOf(entry: Record<string, unknown>, index: number): string {
  const name = asString(entry.name);
  return name ?? `#${index + 1}`;
}

/** `DebugConfiguration` from one `configurations[]` entry, or an error. */
function parseConfiguration(
  raw: unknown,
  index: number,
): { config?: DebugConfiguration; error?: string } {
  const entry = asRecord(raw);
  if (!entry) {
    return { error: `launch.json configurations[${index}] must be an object` };
  }
  const label = labelOf(entry, index);
  const invalid = (reason: string) => ({
    error: `Debug configuration "${label}" is invalid: ${reason}`,
  });

  const type = asString(entry.type);
  if (entry.type === undefined) return invalid("type is required");
  if (type === undefined) return invalid("type must be a string");

  if (entry.name !== undefined && asString(entry.name) === undefined) {
    return invalid("name must be a string");
  }

  let request: DebugRequestKind = "launch";
  if (entry.request !== undefined) {
    if (entry.request !== "launch" && entry.request !== "attach") {
      return invalid('request must be "launch" or "attach"');
    }
    request = entry.request;
  }

  const program = asString(entry.program);
  if (entry.program !== undefined && program === undefined) {
    return invalid("program must be a string");
  }
  const cwd = asString(entry.cwd);
  if (entry.cwd !== undefined && cwd === undefined) {
    return invalid("cwd must be a string");
  }
  // Named `consoleField` rather than `console` to keep the global reachable.
  const consoleField = asString(entry.console);
  if (entry.console !== undefined && consoleField === undefined) {
    return invalid("console must be a string");
  }
  const stopAtEntry = entry.stopAtEntry;
  if (
    stopAtEntry !== undefined &&
    typeof stopAtEntry !== "boolean"
  ) {
    return invalid("stopAtEntry must be a boolean");
  }

  let args: string[] | undefined;
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) {
      return invalid("args must be an array of strings");
    }
    if (entry.args.some((item) => typeof item !== "string")) {
      // Dropping an element would silently change the debuggee's command line,
      // so the whole entry is rejected instead.
      return invalid("args must be an array of strings");
    }
    args = entry.args as string[];
  }

  let env: Record<string, string> | undefined;
  if (entry.env !== undefined) {
    const map = asRecord(entry.env);
    if (!map) {
      return invalid("env must be an object of string values");
    }
    if (Object.values(map).some((value) => typeof value !== "string")) {
      return invalid("env must be an object of string values");
    }
    env = map as Record<string, string>;
  }

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!CANONICAL_KEYS.has(key)) extras[key] = value;
  }

  return {
    config: {
      name: asString(entry.name) ?? label,
      type,
      request,
      ...(program !== undefined ? { program } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(stopAtEntry !== undefined ? { stopAtEntry } : {}),
      ...(consoleField !== undefined ? { console: consoleField } : {}),
      extras,
    },
  };
}

/**
 * Parse the global `launch.json`.
 *
 * Failure is scoped, never fatal. A missing file (`null`) and an empty file are
 * the same thing — "the user has not written one yet" — and yield no
 * configurations and no error, which is what keeps the built-in C++ fallback
 * working. Malformed JSON, a non-object root or a non-array `configurations`
 * rejects the file; a single bad entry only drops that entry, so one typo
 * cannot take the other configurations down with it.
 *
 * Validation is deliberately shallow: unknown fields are allowed, and only the
 * fields this app acts on are type-checked. A stricter schema would reject
 * configurations that a real adapter would have accepted.
 */
export function parseLaunchFile(text: string | null): LaunchFile {
  const empty: LaunchFile = { version: null, configurations: [], errors: [] };
  if (text === null || text.trim() === "") return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ...empty,
      errors: [`Failed to parse global launch.json: ${String(err)}`],
    };
  }
  const root = asRecord(parsed);
  if (!root) {
    return { ...empty, errors: ["launch.json must contain a JSON object"] };
  }

  const errors: string[] = [];
  let version: string | null = null;
  if (root.version !== undefined) {
    const parsedVersion = asString(root.version);
    if (parsedVersion === undefined) {
      errors.push('launch.json: "version" must be a string');
    } else {
      version = parsedVersion;
    }
  }

  const configurations: DebugConfiguration[] = [];
  const list = root.configurations;
  if (list === undefined) {
    return { version, configurations, errors };
  }
  if (!Array.isArray(list)) {
    errors.push('launch.json: "configurations" must be an array');
    return { version, configurations, errors };
  }
  list.forEach((entry, index) => {
    const result = parseConfiguration(entry, index);
    if (result.config) configurations.push(result.config);
    else if (result.error) errors.push(result.error);
  });
  return { version, configurations, errors };
}

/**
 * Turn one configuration into the argument record `buildLaunchArguments` takes.
 *
 * Canonical fields are written **after** `extras` and only when present, so a
 * validated value always wins and an absent one stays absent (the caller then
 * applies its own defaults, exactly as for `debug.launch.<language>`). `request`
 * is included because `requestKindOf` reads it from here; `buildLaunchArguments`
 * drops it again before the arguments reach the adapter.
 */
export function toLaunchArguments(
  config: DebugConfiguration,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...config.extras };
  record.request = config.request;
  if (config.program !== undefined) record.program = config.program;
  if (config.cwd !== undefined) record.cwd = config.cwd;
  if (config.args !== undefined) record.args = config.args;
  if (config.env !== undefined) record.env = config.env;
  if (config.stopAtEntry !== undefined) record.stopAtEntry = config.stopAtEntry;
  if (config.console !== undefined) record.console = config.console;
  return record;
}

/**
 * The configuration to run for this F5.
 *
 * There is no configuration picker yet, so the first entry whose `type` has a
 * configured adapter wins; when none does, the first entry is used anyway, so
 * the session fails with the real "adapter not configured" error instead of
 * silently doing nothing. Every configuration stays in the store either way.
 */
export function selectLaunchConfiguration(
  configurations: readonly DebugConfiguration[],
  hasAdapter: (type: string) => boolean,
): DebugConfiguration | undefined {
  return configurations.find((config) => hasAdapter(config.type)) ?? configurations[0];
}

/**
 * `type` → adapter id for the legacy `debug.adapters.<language>` keys.
 *
 * An existing `user.json` configures the C/C++ debugger under `cpp`; a
 * `launch.json` names the same debugger `cpp-gdb`. Data, not a branch, so
 * adding a second alias later is a table entry — and nothing is ever written
 * back to `user.json`, so both spellings keep working.
 */
export const LEGACY_ADAPTER_ALIASES: Record<string, string> = {
  "cpp-gdb": "cpp",
};

/**
 * The argv of the adapter a `type` names: the `debug.adapters[type]` entry, or
 * its legacy alias when the exact key is absent.
 *
 * The lookup is case-insensitive because the backend already lowercases the
 * adapter keys it sends. There is still no *invented* default: a `type` with no
 * entry yields `undefined` and the caller reports which key to add.
 */
export function resolveAdapterArgv(
  adapters: Readonly<Record<string, DebugAdapterConfig>>,
  type: string,
): string[] | undefined {
  const key = type.trim().toLowerCase();
  const alias = LEGACY_ADAPTER_ALIASES[key];
  const entry = adapters[key] ?? (alias ? adapters[alias] : undefined);
  if (!entry || !entry.command) return undefined;
  return [entry.command, ...entry.args];
}
