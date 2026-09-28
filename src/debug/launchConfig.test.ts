import {
  buildLaunchArguments,
  defaultProgram,
  expandLaunchConfig,
  parseLaunchFile,
  requestKindOf,
  resolveAdapterArgv,
  selectLaunchConfiguration,
  toLaunchArguments,
} from "./launchConfig.ts";
import { resolveTaskCommand, normalizeTaskPath } from "../utils/taskVariables.ts";
import type { DebugAdapterConfig } from "../commands/index.ts";

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
 * The second half covers the global `launch.json`: parsing, validation, the
 * `type` → adapter lookup (including the legacy `cpp` key) and the fact that a
 * missing or unusable file leaves the old behavior intact.
 *
 * `navigator` is absent under Node, so `isWindows()` is false and these run the
 * POSIX branch. The Windows suffix logic is exercised through the platform
 * helper indirectly by checking that a name which already carries an extension
 * is never given a second one. Windows *paths* need no platform branch: the
 * workspace path is a literal in the test, so `E:\…` is asserted verbatim.
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

/* ------------------------------------------------------------------ launch.json */

/** The documented C++ entry from the global `launch.json`. */
const LAUNCH_SAMPLE = `{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "C++: Current File",
      "type": "cpp-gdb",
      "request": "launch",
      "program": "\${workspaceFolder}/bin/\${fileBasenameNoExtension}.exe",
      "cwd": "\${workspaceFolder}",
      "args": [],
      "env": { "FOO": "bar" },
      "stopAtEntry": false,
      "console": "integratedTerminal"
    }
  ]
}`;

console.log("parseLaunchFile: every documented field is read");
{
  const file = parseLaunchFile(LAUNCH_SAMPLE);
  eq(file.errors, [], "no errors");
  eq(file.version, "0.2.0", "version read");
  eq(file.configurations.length, 1, "one configuration");
  const config = file.configurations[0];
  eq(config.name, "C++: Current File", "name");
  eq(config.type, "cpp-gdb", "type");
  eq(config.request, "launch", "request");
  eq(config.program, "\${workspaceFolder}/bin/\${fileBasenameNoExtension}.exe", "program kept unexpanded");
  eq(config.cwd, "\${workspaceFolder}", "cwd kept unexpanded");
  eq(config.args, [], "args");
  eq(config.env, { FOO: "bar" }, "env");
  eq(config.stopAtEntry, false, "stopAtEntry");
  eq(config.console, "integratedTerminal", "console");
}

console.log("parseLaunchFile: configurations is an array, and every entry is kept");
{
  const file = parseLaunchFile(
    `{"configurations":[
      {"name":"gdb","type":"cpp-gdb"},
      {"name":"lldb","type":"cpp-lldb"}
    ]}`,
  );
  eq(file.errors, [], "no errors");
  eq(
    file.configurations.map((c) => c.type),
    ["cpp-gdb", "cpp-lldb"],
    "both configurations survive — reading the file must not drop all but the first",
  );
  eq(file.configurations[1].name, "lldb", "the second one's name is read too");
}

console.log("parseLaunchFile: optional fields default, name falls back to the position");
{
  const file = parseLaunchFile(`{"configurations":[{"type":"go"}]}`);
  eq(file.errors, [], "no errors");
  eq(file.configurations[0].name, "#1", "a nameless entry is still identifiable");
  eq(file.configurations[0].request, "launch", "request defaults to launch");
  ok(file.configurations[0].program === undefined, "no program is invented");
  eq(
    Object.keys(toLaunchArguments(file.configurations[0])),
    ["request"],
    "only `request` is emitted, so the caller's own defaults still apply",
  );
  const named = parseLaunchFile(`{"configurations":[{"name":"debug","type":"go"}]}`);
  eq(named.configurations[0].name, "debug", "an explicit name is kept");
}

console.log("parseLaunchFile: unknown fields are preserved but never shadow the rest");
{
  const file = parseLaunchFile(
    `{"configurations":[{
      "type":"cpp-lldb","program":"/p/app","args":["-v"],
      "MIMode":"lldb","initCommands":["br s -n main"],"stopOnEntry":true
    }]}`,
  );
  eq(file.errors, [], "an adapter-specific field is not an error");
  const config = file.configurations[0];
  eq(
    config.extras,
    { MIMode: "lldb", initCommands: ["br s -n main"], stopOnEntry: true },
    "unmodelled fields are kept verbatim",
  );
  for (const key of ["program", "args", "name", "type", "request", "cwd", "env", "stopAtEntry", "console"]) {
    ok(!(key in config.extras), `${key} is not duplicated in extras`);
  }
  const record = toLaunchArguments(config);
  eq(record.program, "/p/app", "the canonical program reaches the arguments");
  eq(record.args, ["-v"], "the canonical args reach the arguments");
  eq(record.MIMode, "lldb", "the adapter-specific key is forwarded");
  eq(record.stopOnEntry, true, "a lldb-style stopOnEntry is forwarded unchanged");
  eq(
    Object.keys(record).filter((k) => k === "program").length,
    1,
    "program appears exactly once",
  );
}

console.log("parseLaunchFile: the launch request is parsed and passed through");
{
  const attach = parseLaunchFile(
    `{"configurations":[{"name":"attach","type":"cpp-gdb","request":"attach","processId":42}]}`,
  ).configurations[0];
  eq(attach.request, "attach", "attach is kept");
  const record = toLaunchArguments(attach);
  eq(requestKindOf(record), "attach", "the existing requestKindOf reads it");
  const args = buildLaunchArguments("cpp", record, { workspacePath: WS, filePath: null });
  ok(!("request" in args), "the request key is not sent as an argument");
  eq(args.processId, 42, "the attach target is preserved");
  const bad = parseLaunchFile(
    `{"configurations":[{"name":"x","type":"cpp-gdb","request":"reload"}]}`,
  );
  eq(bad.configurations.length, 0, "an unknown request is rejected");
  eq(bad.errors, ['Debug configuration "x" is invalid: request must be "launch" or "attach"'], "reported per configuration");
}

console.log("parseLaunchFile: a missing type is reported and only that entry is dropped");
{
  const file = parseLaunchFile(
    `{"configurations":[{"name":"no type","program":"/p/a"},{"name":"ok","type":"cpp-gdb"}]}`,
  );
  eq(file.configurations.length, 1, "the valid sibling survives");
  eq(file.configurations[0].name, "ok", "and it is the one that is kept");
  eq(
    file.errors,
    ['Debug configuration "no type" is invalid: type is required'],
    "the reason names the configuration and the missing field",
  );
  const nameless = parseLaunchFile(`{"configurations":[{"type":5},{"type":"a b"}]}`);
  eq(
    nameless.errors[0],
    'Debug configuration "#1" is invalid: type must be a string',
    "an entry with an unusable name is still identified by its position",
  );
  eq(nameless.configurations.length, 1, "only the broken entry is dropped");
}

console.log("parseLaunchFile: field types are checked, no more than that");
{
  // Each entry is named, so the error quotes the name the user recognizes; the
  // nameless one is covered above, where the position stands in for it.
  const bad: Array<[string, string]> = [
    ['{"name":"t","program":1}', "program must be a string"],
    ['{"name":"t","cwd":[]}', "cwd must be a string"],
    ['{"name":"t","console":{}}', "console must be a string"],
    ['{"name":"t","stopAtEntry":"yes"}', "stopAtEntry must be a boolean"],
    ['{"name":"t","args":"-v"}', "args must be an array of strings"],
    ['{"name":"t","args":[1]}', "args must be an array of strings"],
    ['{"name":"t","env":[]}', "env must be an object of string values"],
    ['{"name":"t","env":{"A":1}}', "env must be an object of string values"],
  ];
  for (const [entry, reason] of bad) {
    const file = parseLaunchFile(`{"configurations":[{"type":"t",${entry.slice(1)}]}`);
    eq(
      file.errors,
      [`Debug configuration "t" is invalid: ${reason}`],
      reason,
    );
    eq(file.configurations.length, 0, "the rejected entry is not returned");
  }
  const namelessName = parseLaunchFile('{"configurations":[{"name":1,"type":"t"}]}');
  eq(
    namelessName.errors,
    ['Debug configuration "#1" is invalid: name must be a string'],
    "name must be a string",
  );
}

console.log("parseLaunchFile: the file itself is validated");
{
  const version = parseLaunchFile('{"version":2,"configurations":[]}');
  eq(version.errors, ['launch.json: "version" must be a string'], "a non-string version is reported");
  eq(version.configurations, [], "and no configuration is invented");
  const list = parseLaunchFile('{"configurations":{}}');
  eq(list.errors, ['launch.json: "configurations" must be an array'], "configurations must be an array");
  const entries = parseLaunchFile('{"configurations":[7]}');
  eq(entries.errors, ["launch.json configurations[0] must be an object"], "a non-object entry is reported");
  eq(parseLaunchFile("[]").errors, ["launch.json must contain a JSON object"], "the root must be an object");
  eq(parseLaunchFile('"text"').errors, ["launch.json must contain a JSON object"], "a string root is rejected too");
  const missing = parseLaunchFile("{}");
  eq([missing.version, missing.configurations, missing.errors], [null, [], []], "an object without configurations is empty, not broken");
}

console.log("parseLaunchFile: unusable files report a readable error");
{
  const broken = parseLaunchFile("{not json");
  ok(broken.errors.length === 1, "one error");
  ok(
    broken.errors[0].startsWith("Failed to parse global launch.json:"),
    `the error names the file — got ${JSON.stringify(broken.errors[0])}`,
  );
  eq(broken.configurations, [], "a broken file yields no configuration");
  const empty = parseLaunchFile("");
  eq([empty.configurations, empty.errors], [[], []], "an empty file is 'not written yet', not an error");
  const blank = parseLaunchFile("   \n\t ");
  eq([blank.configurations, blank.errors], [[], []], "so is a whitespace-only one");
  const absent = parseLaunchFile(null);
  eq([absent.configurations, absent.errors], [[], []], "a missing file behaves the same — the old defaults stay in charge");
}

console.log("launch.json: variables are expanded through the existing path");
{
  const file = parseLaunchFile(
    `{"configurations":[{
      "type":"cpp-gdb",
      "program":"\${workspaceFolder}/bin/\${fileBasenameNoExtension}.exe",
      "cwd":"\${workspaceFolder}",
      "args":["--file=\${file}", "--name=\${fileBasename}", "--dir=\${fileDirname}"]
    }]}`,
  );
  eq(file.errors, [], "no errors");
  const args = buildLaunchArguments("cpp", toLaunchArguments(file.configurations[0]), {
    workspacePath: WS,
    filePath: FILE,
  });
  eq(args.program, "/home/dev/project/bin/main.exe", "program expanded");
  eq(args.cwd, WS, "cwd expanded");
  eq(
    args.args,
    ["--file=/home/dev/project/src/main.cpp", "--name=main.cpp", "--dir=/home/dev/project/src"],
    "every file variable is expanded inside args",
  );
  const noFile = buildLaunchArguments("cpp", toLaunchArguments(file.configurations[0]), {
    workspacePath: WS,
    filePath: null,
  });
  eq(
    noFile.program,
    "/home/dev/project/bin/${fileBasenameNoExtension}.exe",
    "with no active file the unknown value is left visible rather than blanked",
  );
}

console.log("launch.json: a Windows workspace keeps its drive letter, case and backslashes");
{
  const file = parseLaunchFile(LAUNCH_SAMPLE);
  eq(file.errors, [], "the documented sample parses");
  const args = buildLaunchArguments("cpp", toLaunchArguments(file.configurations[0]), {
    workspacePath: "E:\\Code\\CorC++\\Algorithm_Win",
    filePath: "E:\\Code\\CorC++\\Algorithm_Win\\test.cpp",
  });
  eq(
    args.program,
    "E:\\Code\\CorC++\\Algorithm_Win/bin/test.exe",
    "the resolved program is the workspace's build output, case and drive untouched",
  );
  eq(args.cwd, "E:\\Code\\CorC++\\Algorithm_Win", "the resolved cwd is the workspace itself");
  eq(args.env, { FOO: "bar" }, "env is forwarded as the DAP launch argument");
  eq(args.console, "integratedTerminal", "console is forwarded; the built-in cpp default does not override it");
  eq(args.stopAtEntry, false, "stopAtEntry is forwarded under its own name, not translated");
  eq(
    args.stopOnEntry,
    false,
    "the pre-existing DAP default is still applied unchanged",
  );
  // The workspace scan yields extended-length paths on Windows, and the
  // literal `\\?\` must not reach the adapter — the same normalization tasks do.
  const extended = buildLaunchArguments("cpp", { program: "${workspaceFolder}/a.exe" }, {
    workspacePath: "\\\\?\\E:\\Code\\p",
    filePath: null,
  });
  eq(extended.program, "E:\\Code\\p/a.exe", "a \\\\?\\ workspace prefix is stripped");
  eq(extended.cwd, "E:\\Code\\p", "and so is the implied cwd");
  const unc = buildLaunchArguments("cpp", { program: "${workspaceFolder}/a.exe" }, {
    workspacePath: "\\\\?\\UNC\\server\\share\\p",
    filePath: null,
  });
  eq(
    unc.program,
    "\\\\server\\share\\p/a.exe",
    "a \\\\?\\UNC\\ workspace prefix becomes a plain UNC path",
  );
}

console.log("selectLaunchConfiguration: the first entry whose type has an adapter");
{
  const configs = parseLaunchFile(
    `{"configurations":[
      {"name":"lldb","type":"cpp-lldb"},
      {"name":"gdb","type":"cpp-gdb"}
    ]}`,
  ).configurations;
  eq(
    selectLaunchConfiguration(configs, (type) => type === "cpp-gdb")?.name,
    "gdb",
    "the first *usable* entry is chosen, not simply the first",
  );
  eq(
    selectLaunchConfiguration(configs, () => false)?.name,
    "lldb",
    "with no usable entry the first is still returned, so the real error is reported",
  );
  eq(
    selectLaunchConfiguration([], () => true),
    undefined,
    "no configurations at all means the caller falls back to the old path",
  );
}

console.log("resolveAdapterArgv: cpp-gdb finds its adapter, or the legacy cpp entry");
{
  const gdb: Record<string, DebugAdapterConfig> = {
    "cpp-gdb": { command: "gdb", args: ["-i", "dap"] },
  };
  eq(
    resolveAdapterArgv(gdb, "cpp-gdb"),
    ["gdb", "-i", "dap"],
    "the exact `debug.adapters[\"cpp-gdb\"]` entry is used",
  );
  eq(resolveAdapterArgv(gdb, "cpp-lldb"), undefined, "an unconfigured type stays unconfigured");
  eq(resolveAdapterArgv(gdb, "go"), undefined, "no invented default for any other type");

  // The migration that matters: an existing user.json configures the C/C++
  // debugger under `cpp`, and `gdb -i dap` must still come out of it.
  const legacy: Record<string, DebugAdapterConfig> = {
    cpp: { command: "gdb", args: ["-i", "dap"] },
  };
  eq(
    resolveAdapterArgv(legacy, "cpp-gdb"),
    ["gdb", "-i", "dap"],
    "type `cpp-gdb` falls back to debug.adapters.cpp",
  );
  eq(
    resolveAdapterArgv(legacy, "cpp"),
    ["gdb", "-i", "dap"],
    "the legacy language-keyed lookup is unchanged",
  );
  const both: Record<string, DebugAdapterConfig> = {
    "cpp-gdb": { command: "gdb", args: ["-i", "dap"] },
    cpp: { command: "lldb-dap", args: [] },
  };
  eq(
    resolveAdapterArgv(both, "cpp-gdb"),
    ["gdb", "-i", "dap"],
    "with both keys present the exact type wins — the alias is a fallback only",
  );
  eq(
    resolveAdapterArgv(legacy, "CPP-GDB"),
    ["gdb", "-i", "dap"],
    "the lookup is case-insensitive, like the backend's adapter keys",
  );
  eq(
    resolveAdapterArgv({ "cpp-gdb": { command: "", args: [] } }, "cpp-gdb"),
    undefined,
    "a blank command is still 'not configured'",
  );
  eq(resolveAdapterArgv({}, "cpp-gdb"), undefined, "an empty user.json reports the missing key");
}

console.log("launch.json end to end: configuration -> adapter -> DAP launch arguments");
{
  const file = parseLaunchFile(LAUNCH_SAMPLE);
  const config = selectLaunchConfiguration(file.configurations, (type) =>
    resolveAdapterArgv({ cpp: { command: "gdb", args: ["-i", "dap"] } }, type) !==
    undefined,
  );
  eq(config?.type, "cpp-gdb", "the C++ configuration is selected");
  const adapter = resolveAdapterArgv({ cpp: { command: "gdb", args: ["-i", "dap"] } }, config!.type);
  eq(adapter, ["gdb", "-i", "dap"], "gdb is spawned with `-i dap`");
  const request = requestKindOf(toLaunchArguments(config!));
  eq(request, "launch", "the DAP request comes from the configuration");
  const launch = buildLaunchArguments("cpp", toLaunchArguments(config!), {
    workspacePath: "E:\\Code\\CorC++\\Algorithm_Win",
    filePath: "E:\\Code\\CorC++\\Algorithm_Win\\test.cpp",
  });
  eq(launch.program, "E:\\Code\\CorC++\\Algorithm_Win/bin/test.exe", "bin/test.exe is what gets launched");
  eq(launch.cwd, "E:\\Code\\CorC++\\Algorithm_Win", "cwd is the workspace");
  eq(launch.args, [], "args are not dropped");
  eq(launch.env, { FOO: "bar" }, "env survives the merge");
}

console.log("no launch.json: the old per-language behavior is untouched");
{
  const file = parseLaunchFile(null);
  const config = selectLaunchConfiguration(file.configurations, () => true);
  eq(config, undefined, "nothing to select, so the caller keeps using debug.launch.<language>");
  const legacy = buildLaunchArguments("cpp", { program: "${workspaceFolder}/bin/app" }, {
    workspacePath: WS,
    filePath: FILE,
  });
  eq(legacy.program, "/home/dev/project/bin/app", "the user's own launch entry still wins");
  const fallback = buildLaunchArguments("cpp", undefined, {
    workspacePath: WS,
    filePath: FILE,
  });
  eq(fallback.program, "/home/dev/project/build/app", "the built-in C++ program default still applies");
  eq(fallback.console, "integratedTerminal", "the built-in console default still applies");
  eq(
    resolveAdapterArgv({ cpp: { command: "gdb", args: ["-i", "dap"] } }, "cpp"),
    ["gdb", "-i", "dap"],
    "the adapter is looked up by language id exactly as before",
  );
}

if (failures > 0) {
  throw new Error(`${failures} launch-config test(s) FAILED`);
} else {
  console.log("all launch config tests passed");
}
