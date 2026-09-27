import { debugReducer, breakpointRequest, mergeBreakpointVerdicts, hasSession, isContinueAction, isStartAction, isStopped } from "./stateMachine.ts";
import type { DebugEvent } from "./stateMachine.ts";
import { INITIAL_DEBUG_STATE } from "./types.ts";
import type { DebugState, StackFrame } from "./types.ts";

/**
 * Pure unit tests for the debug state machine. Run with:
 *
 *     node src/debug/stateMachine.test.ts
 *
 * (Node >= 22 type-strips `.ts` directly; no framework needed.)
 *
 * The reducer is the piece that decides what the toolbar shows, so the invariant
 * worth pinning is that **the status only ever changes because of a DAP
 * response or event**. Nothing here sets `running` or `stopped` directly, and the
 * tests below deliberately assert that stale stack data is dropped on a stop so
 * the UI can never show variables from one location against another.
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

const reduce = (state: DebugState, ...events: DebugEvent[]): DebugState =>
  events.reduce(debugReducer, state);

const frame = (id: number, line = 1, path = "/ws/main.cpp"): StackFrame => ({
  id,
  name: `frame${id}`,
  path,
  line,
});

console.log("start: requested → started");
{
  const started = reduce(INITIAL_DEBUG_STATE, { kind: "startRequested", language: "cpp" });
  eq(started.status, "starting", "status becomes starting");
  eq(started.language, "cpp", "language recorded");
  eq(started.error, null, "no error yet");
  const running = debugReducer(started, { kind: "started", adapter: "lldb-dap" });
  eq(running.status, "running", "status becomes running after the handshake");
  eq(running.adapter, "lldb-dap", "adapter name kept for the tooltip");
}

console.log("start failure returns to idle and keeps the reason");
{
  const failed = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "startFailed", error: "adapter not found: lldb-dap" },
  );
  eq(failed.status, "idle", "no session left behind");
  eq(failed.error, "adapter not found: lldb-dap", "error surfaced");
  eq(failed.frames, [], "frames cleared");
}

console.log("stopped: status, reason and thread come from the event");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 7 } },
  );
  eq(state.status, "stopped", "status becomes stopped");
  eq(state.stopReason, "breakpoint", "reason kept for the toolbar");
  eq(state.threadId, 7, "thread id kept for continue/step");
}

console.log("stopped without a reason or thread still stops the session");
{
  const state = reduce(INITIAL_DEBUG_STATE, {
    kind: "stopped",
    body: { allThreadsStopped: false },
  });
  eq(state.status, "stopped", "a partial pause is still a stop");
  eq(state.threadId, undefined, "thread unknown rather than invented");
  eq(state.stopReason, "stopped", "reason falls back");
}

console.log("stopped drops the previous stop's stack");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "entry", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
    { kind: "scopes", scopes: [{ name: "Locals", variablesReference: 1, variables: [{ name: "i", value: "0" }] }] },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
  );
  eq(state.frames, [], "old frames cleared, so stale variables cannot be shown");
  eq(state.scopes, [], "old scopes cleared");
  eq(state.currentLocation, undefined, "old highlight location cleared");
  eq(state.status, "stopped", "still stopped");
}

console.log("continued clears inspection state and returns to running");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
    { kind: "continued", threadId: 1 },
  );
  eq(state.status, "running", "status becomes running");
  eq(state.frames, [], "stack is not inspectable while running");
  eq(state.scopes, [], "variables are not inspectable while running");
  eq(state.currentLocation, undefined, "no highlight while running");
}

console.log("frames: the top frame drives the editor location");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "frames", frames: [frame(1, 10), frame(2, 42, "/ws/lib.cpp")] },
  );
  eq(state.currentLocation, { path: "/ws/main.cpp", line: 10 }, "frame 0 highlighted");
  eq(state.frames.length, 2, "both frames kept");
}

console.log("frameSelected moves the highlight and invalidates scopes");
{
  const withFrames = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "frames", frames: [frame(1, 10), frame(2, 42, "/ws/lib.cpp")] },
    { kind: "scopes", scopes: [{ name: "Locals", variablesReference: 1, variables: [] }] },
  );
  const selected = debugReducer(withFrames, { kind: "frameSelected", index: 1 });
  eq(selected.selectedFrame, 1, "selection moved");
  eq(selected.currentLocation, { path: "/ws/lib.cpp", line: 42 }, "highlight follows the selected frame");
  eq(selected.scopes, [], "scopes of the previous frame are dropped");
}

console.log("frameSelected ignores an out-of-range index");
{
  const withFrames = reduce(INITIAL_DEBUG_STATE, { kind: "frames", frames: [frame(1, 10)] });
  eq(debugReducer(withFrames, { kind: "frameSelected", index: 9 }).selectedFrame, 0, "no change");
  eq(debugReducer(withFrames, { kind: "frameSelected", index: -1 }).selectedFrame, 0, "no change");
}

console.log("frames without a source produce no highlight");
{
  const state = reduce(INITIAL_DEBUG_STATE, {
    kind: "frames",
    frames: [{ id: 3, name: "libc_start_main" }],
  });
  eq(state.frames.length, 1, "native frame is still listed");
  eq(state.currentLocation, undefined, "nothing to highlight in the editor");
}

console.log("process records the debuggee pid");
{
  const state = reduce(INITIAL_DEBUG_STATE, {
    kind: "process",
    body: { name: "app", systemProcessId: 4321 },
  });
  eq(state.processId, 4321, "pid recorded");
}

console.log("thread events accumulate without duplicates");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "thread", threadId: 1, name: "main" },
    { kind: "thread", threadId: 1, name: "main" },
    { kind: "thread", threadId: 2, name: "worker" },
  );
  eq(state.threads, [{ id: 1, name: "main" }, { id: 2, name: "worker" }], "each thread once");
}

console.log("threads event replaces the whole list");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "thread", threadId: 1, name: "stale" },
    { kind: "threads", threads: [{ id: 3, name: "main" }, { id: 4, name: "worker" }] },
  );
  eq(state.threads, [{ id: 3, name: "main" }, { id: 4, name: "worker" }], "exited threads removed");
}

console.log("threadSelected clears the previous thread's stack");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
    { kind: "scopes", scopes: [{ name: "Locals", variablesReference: 1, variables: [] }] },
    { kind: "threadSelected", threadId: 2 },
  );
  eq(state.threadId, 2, "active thread switched");
  eq(state.frames, [], "previous thread's frames dropped");
  eq(state.scopes, [], "previous thread's variables dropped");
  eq(state.currentLocation, undefined, "previous location dropped");
}

console.log("terminated and exited end the session and clear the marker");
{
  const live = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
  );
  const terminated = debugReducer(live, { kind: "terminated" });
  eq(terminated.status, "terminated", "terminated event");
  eq(terminated.currentLocation, undefined, "current-line marker cleared on terminate");
  eq(terminated.frames, [], "stack cleared on terminate");

  const exited = debugReducer(live, { kind: "exited", body: { exitCode: 0 } });
  eq(exited.status, "terminated", "exited event ends the session too");
  eq(exited.currentLocation, undefined, "current-line marker cleared on exit");
  ok(
    exited.output.some((line) => line.text.includes("exited with code 0")),
    "exit code reported in the output tail",
  );
}

console.log("continued clears the marker so a new stop can reposition it");
{
  const state = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
    { kind: "continued", threadId: 1 },
    { kind: "stopped", body: { reason: "step", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 11)] },
  );
  eq(state.currentLocation, { path: "/ws/main.cpp", line: 11 }, "marker follows the new stop");
}

console.log("adapterExited reports a disconnection with its message");
{
  const live = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
    { kind: "frames", frames: [frame(1, 10)] },
    { kind: "adapterExited", message: "lldb-dap exited with code 1" },
  );
  eq(live.status, "disconnected", "status is disconnected, not terminated");
  eq(live.error, "lldb-dap exited with code 1", "reason kept");
  eq(live.frames, [], "frames of a dead session are dropped");
}

console.log("output: multi-line chunks are split and the tail is bounded");
{
  let state = INITIAL_DEBUG_STATE;
  for (let i = 0; i < 150; i += 1) {
    state = debugReducer(state, { kind: "output", body: { category: "stdout", output: `line ${i}\nline ${i}b` } });
  }
  ok(state.output.length <= 200, `tail is bounded (${state.output.length} lines)`);
  eq(state.output[state.output.length - 1].text, "line 149b", "newest output kept");
  eq(state.output[0].text.startsWith("line 5"), true, "oldest output dropped from the front");
}

console.log("output without text is a no-op");
{
  const state = reduce(INITIAL_DEBUG_STATE, { kind: "output", body: { category: "stdout" } });
  eq(state.output, [], "nothing recorded for an empty chunk");
}

console.log("reset returns a fresh idle state");
{
  const live = reduce(
    INITIAL_DEBUG_STATE,
    { kind: "startRequested", language: "cpp" },
    { kind: "started", adapter: "lldb-dap" },
    { kind: "stopped", body: { reason: "breakpoint", threadId: 1 } },
  );
  eq(debugReducer(live, { kind: "reset" }), INITIAL_DEBUG_STATE, "identical to a fresh store");
}

console.log("toolbar predicates: what each status means for the buttons");
{
  ok(isStartAction("idle"), "idle offers Start");
  ok(isStartAction("disconnected"), "disconnected offers Start again");
  ok(!isStartAction("running"), "running does not offer Start");
  ok(isContinueAction("stopped"), "F5 on a stopped session continues");
  ok(!isContinueAction("idle"), "F5 on idle starts instead");
  ok(isStopped("stopped"), "stepping only while stopped");
  ok(!isStopped("running"), "no stepping while running");
  ok(hasSession("starting"), "starting still has a session to stop");
  ok(!hasSession("idle"), "idle has nothing to stop");
}

console.log("breakpointRequest sorts, de-duplicates nothing and sets sourceModified");
{
  eq(
    breakpointRequest("/ws/main.cpp", [12, 3]),
    {
      source: { path: "/ws/main.cpp" },
      breakpoints: [{ line: 3 }, { line: 12 }],
      sourceModified: false,
    },
    "payload is the DAP setBreakpoints shape",
  );
  eq(breakpointRequest("/ws/a.cpp", []).breakpoints.length, 0, "clearing a file sends an empty list, not null");
}

console.log("mergeBreakpointVerdicts keeps user lines the adapter did not confirm");
{
  const merged = mergeBreakpointVerdicts(
    [{ line: 5 }, { line: 9 }],
    [{ id: 1, verified: true, line: 5 }],
  );
  eq(merged[0], { line: 5, id: 1, verified: true, message: undefined }, "verified line recorded");
  eq(merged[1], { line: 9, id: undefined, verified: false, message: undefined }, "missing line stays, marked unverified");
}

console.log("mergeBreakpointVerdicts surfaces the adapter's message");
{
  const merged = mergeBreakpointVerdicts(
    [{ line: 5 }],
    [{ verified: false, line: 5, message: "No executable code" }],
  );
  eq(merged[0].verified, false, "unverified");
  eq(merged[0].message, "No executable code", "message kept for the gutter badge");
}

console.log("mergeBreakpointVerdicts with no response marks everything unverified");
{
  const merged = mergeBreakpointVerdicts([{ line: 5, id: 3, verified: true }], undefined);
  eq(merged, [{ line: 5, id: undefined, verified: false, message: undefined }], "stale ids dropped");
}

if (failures > 0) {
  throw new Error(`${failures} debug state-machine test(s) FAILED`);
} else {
  console.log("all state machine tests passed");
}
