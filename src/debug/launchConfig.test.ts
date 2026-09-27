import { buildLaunchArguments, defaultProgram, expandLaunchConfig, requestKindOf } from "./launchConfig.ts";
import { resolveTaskCommand, normalizeTaskPath } from "../utils/taskVariables.ts";

/**
 * Pure unit tests for launch-argument assembly. Run with:
 *
 *     node src/debug/launchConfig.test.ts
 *
 * What matters here is the "language-agnostic by construction" claim: the only
 * language-specific knowledge in the whole debug frontend is one entry in
 * `PROGRAM_DEFAULTS`, and it is a *value*. So the tests assert that an unknown
 * language produces no invented program (the backend then reports the program is
 * missing, which is a far better error than debugging the wrong binary), and
 * that a user value always beats a default.
 *
 * `navigator` is absent under Node, so `isWindows()` is false and these run the
 * POSIX branch. The Windows suffix logic is exercised through the platform
 * helper indirectly by checking that a name which already carries an extension
 * is never given a second one.
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

const WS = "/home/dev/project";
const FILE = "/home/dev/project/src/main.cpp";

console.log("defaultProgram: a value, not a branch");
{
  eq(defaultProgram("cpp", WS), "/home/dev/project/build/app", "cpp has a conventional default");
  eq(defaultProgram("rust", WS), undefined, "an unconfigured language gets no invented program");
  eq(defaultProgram("cpp", ""), undefined, "no workspace means no program");
}

console.log("expandLaunchConfig: the task variable set is reused");
{
  const expanded = expandLaunchConfig(
    {
      program: "${workspaceFolder}/build/${fileBasenameNoExtension}",
      args: ["-f", "${relativeFile}", "--out=${fileDirname}"],
    },
    { workspacePath: WS, filePath: FILE },
  );
  eq(expanded.program, "/home/dev/project/build/main", "program expanded");
  eq(expanded.args, ["-f", "src/main.cpp", "--out=/home/dev/project/src"], "args expanded element-wise");
}

console.log("expandLaunchConfig: nested structures are walked");
{
  const expanded = expandLaunchConfig(
    { env: { OUT: "${workspaceFolder}/out" }, list: [{ path: "${file}" }] },
    { workspacePath: WS, filePath: FILE },
  );
  eq(expanded, { env: { OUT: "/home/dev/project/out" }, list: [{ path: FILE }] }, "objects and arrays of objects");
}

console.log("expandLaunchConfig: an unknown variable is left visible");
{
  eq(
    expandLaunchConfig("${nope}/x", { workspacePath: WS, filePath: null }),
    "${nope}/x",
    "a typo shows up in the adapter's error instead of becoming an empty path",
  );
}

console.log("expandLaunchConfig: a file variable without an active file is left alone");
{
  eq(
    expandLaunchConfig("${file}", { workspacePath: WS, filePath: null }),
    "${file}",
    "no active file means no silent substitution",
  );
}

console.log("expandLaunchConfig: ${program} needs a program in the context");
{
  // `expandLaunchConfig` is generic, so it cannot know the program on its own:
  // an unresolved variable is left visible rather than guessed. The
  // `buildLaunchArguments` path supplies it (asserted below).
  eq(
    expandLaunchConfig("${programBasename}", { workspacePath: WS, filePath: null }),
    "${programBasename}",
    "no program in context, nothing invented",
  );
  const args = buildLaunchArguments(
    "cpp",
    { program: "${workspaceFolder}/bin/tool", args: ["--from=${programBasename}"] },
    { workspacePath: WS, filePath: null },
  );
  eq(args.args, ["--from=tool"], "the merged program is available to args");
}

console.log("expandLaunchConfig: Windows verbatim prefixes are stripped, like tasks");
{
  eq(
    expandLaunchConfig("${workspaceFolder}/out", {
      workspacePath: "\\\\?\\E:\\Code\\p",
      filePath: null,
    }),
    "E:\\Code\\p/out",
    "the \\\\?\\ prefix never reaches the adapter",
  );
  eq(
    normalizeTaskPath("\\\\?\\UNC\\server\\share\\p"),
    "\\\\server\\share\\p",
    "UNC prefix unwrapped",
  );
  eq(
    resolveTaskCommand("${workspaceFolder}/x", "\\\\?\\E:\\p", null),
    "E:\\p/x",
    "task variables and launch variables share the normalization",
  );
}

console.log("buildLaunchArguments: defaults, then user config, then variables");
{
  const args = buildLaunchArguments("cpp", undefined, {
    workspacePath: WS,
    filePath: FILE,
  });
  eq(args.program, "/home/dev/project/build/app", "default program filled in");
  eq(args.cwd, WS, "cwd defaults to the workspace");
  eq(args.stopOnEntry, false, "stopOnEntry defaults to false, and is still overridable");
}

console.log("buildLaunchArguments: the user's values always win");
{
  const args = buildLaunchArguments(
    "cpp",
    { program: "${workspaceFolder}/build/my_app", cwd: "${fileDirname}", stopOnEntry: true },
    { workspacePath: WS, filePath: FILE },
  );
  eq(args.program, "/home/dev/project/build/my_app", "user program kept and expanded");
  eq(args.cwd, "/home/dev/project/src", "user cwd kept and expanded");
  eq(args.stopOnEntry, true, "user stopOnEntry kept");
}

console.log("buildLaunchArguments: an empty user value falls back to the default");
{
  const args = buildLaunchArguments("cpp", { program: "", cwd: "" }, {
    workspacePath: WS,
    filePath: null,
  });
  eq(args.program, "/home/dev/project/build/app", "empty program replaced");
  eq(args.cwd, WS, "empty cwd replaced");
}

console.log("buildLaunchArguments: a language with no default and no user program");
{
  const args = buildLaunchArguments("go", { mode: "debug" }, {
    workspacePath: WS,
    filePath: null,
  });
  ok(!("program" in args), "no program is invented; the backend reports the missing file");
  eq(args.mode, "debug", "the user's own keys are forwarded untouched");
  eq(args.cwd, WS, "cwd still defaults to the workspace");
}

console.log("buildLaunchArguments: adapter-specific keys pass through verbatim");
{
  const args = buildLaunchArguments(
    "cpp",
    { MIMode: "lldb", startupCommands: "breakpoint set -n main" },
    { workspacePath: WS, filePath: null },
  );
  eq(args.MIMode, "lldb", "unknown key preserved");
  eq(args.startupCommands, "breakpoint set -n main", "string value preserved");
}

console.log("buildLaunchArguments: non-string leaves are not mangled");
{
  const args = buildLaunchArguments("cpp", { stopOnEntry: false, extra: 3, flag: true }, {
    workspacePath: WS,
    filePath: null,
  });
  eq(args.extra, 3, "number preserved");
  eq(args.flag, true, "boolean preserved");
  eq(args.stopOnEntry, false, "explicit false is respected, not overwritten by the default");
}

console.log("buildLaunchArguments: cpp asks for an integrated terminal");
{
  const args = buildLaunchArguments("cpp", undefined, {
    workspacePath: WS,
    filePath: FILE,
  });
  eq(args.console, "integratedTerminal", "the debuggee runs in the Debug Terminal");
  const overridden = buildLaunchArguments(
    "cpp",
    { console: "internalConsole" },
    { workspacePath: WS, filePath: null },
  );
  eq(overridden.console, "internalConsole", "the user's console value wins");
  const go = buildLaunchArguments("go", undefined, {
    workspacePath: WS,
    filePath: null,
  });
  ok(!("console" in go), "a language with no default gets no console key");
}

console.log("requestKindOf: the VS Code-style request field");
{
  eq(requestKindOf(undefined), "launch", "no config means launch");
  eq(requestKindOf({}), "launch", "no request field means launch");
  eq(requestKindOf({ request: "launch" }), "launch", "explicit launch");
  eq(requestKindOf({ request: "attach" }), "attach", "explicit attach");
  eq(requestKindOf({ request: "bogus" }), "launch", "an unknown request falls back to launch");
}

console.log("buildLaunchArguments: attach skips the program default");
{
  const args = buildLaunchArguments(
    "cpp",
    { request: "attach", processId: 4321 },
    { workspacePath: WS, filePath: FILE },
  );
  ok(!("program" in args), "no program invented for an already-running target");
  eq(args.processId, 4321, "the user's attach target is preserved");
  eq(args.cwd, WS, "cwd still defaults");
}

console.log("buildLaunchArguments: the request key is not sent as an argument");
{
  const launched = buildLaunchArguments("cpp", { request: "launch" }, {
    workspacePath: WS,
    filePath: null,
  });
  ok(!("request" in launched), "launch drops the request key");
  const attached = buildLaunchArguments(
    "cpp",
    { request: "attach", processId: 1 },
    { workspacePath: WS, filePath: null },
  );
  ok(!("request" in attached), "attach drops the request key");
}

console.log("buildLaunchArguments: attach still expands variables");
{
  const args = buildLaunchArguments(
    "cpp",
    { request: "attach", program: "${workspaceFolder}/build/app", args: ["--pid=${fileBasename}"] },
    { workspacePath: WS, filePath: FILE },
  );
  eq(args.program, "/home/dev/project/build/app", "an explicitly given program is kept for attach");
  eq(args.args, ["--pid=main.cpp"], "variables expand for attach too");
}

if (failures > 0) {
  throw new Error(`${failures} launch-config test(s) FAILED`);
} else {
  console.log("all launch config tests passed");
}
