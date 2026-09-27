// The `.ts` extension is what lets this module run under `node` for
// `stateMachine.test.ts`; it matches `utils/gitStatusMapping.ts`.
import { INITIAL_DEBUG_STATE } from "./types.ts";
import type {
  DebugBreakpoint,
  DebugState,
  DebugStatus,
  OutputLine,
  ScopeEntry,
  StackFrame,
  ThreadEntry,
} from "./types.ts";
import type {
  DapBreakpoint,
  DapCapabilities,
  DapExitedBody,
  DapOutputBody,
  DapProcessBody,
  DapStoppedBody,
} from "./protocol.ts";

/**
 * The debug state machine: a **pure** function of (state, event) → state.
 *
 * The rule this file exists to enforce: the status is decided *only* by DAP
 * responses and events. A button click never sets `running` or `stopped`; it
 * only ever sends a request and waits. Otherwise the UI would claim a state the
 * debugger is not in — showing "running" while the process is still loading, or
 * enabling Continue on a session that already died.
 *
 * Because it is pure, `debug/stateMachine.test.ts` can pin every transition
 * without a Tauri mock, a Monaco model or an adapter.
 */

/** Everything that can change the session. */
export type DebugEvent =
  | { kind: "startRequested"; language: string }
  | { kind: "startFailed"; error: string }
  | { kind: "started"; adapter: string; capabilities?: DapCapabilities }
  | { kind: "stopped"; body: DapStoppedBody }
  | { kind: "continued"; threadId?: number }
  | { kind: "process"; body: DapProcessBody }
  | { kind: "thread"; threadId: number; name?: string }
  | { kind: "threads"; threads: ThreadEntry[] }
  | { kind: "threadSelected"; threadId: number }
  | { kind: "terminated" }
  | { kind: "exited"; body: DapExitedBody }
  | { kind: "output"; body: DapOutputBody }
  | { kind: "adapterExited"; message: string }
  | { kind: "frames"; frames: StackFrame[] }
  | { kind: "frameSelected"; index: number }
  | { kind: "scopes"; scopes: ScopeEntry[] }
  | { kind: "error"; message: string }
  | { kind: "reset" };

/** How many `output` lines to keep. Older ones are dropped from the front. */
const MAX_OUTPUT_LINES = 200;

/** How many frames to keep for the call stack view. */
const MAX_FRAMES = 100;

export function debugReducer(
  state: DebugState,
  event: DebugEvent,
): DebugState {
  switch (event.kind) {
    case "startRequested":
      // A fresh attempt discards the previous run's views, but the caller keeps
      // the per-workspace breakpoint maps, so nothing the user set is lost.
      return {
        ...INITIAL_DEBUG_STATE,
        status: "starting",
        language: event.language,
      };

    case "started":
      // The adapter's capabilities come from the `initialize` response, which
      // the backend already completed; recording them here is what lets the
      // toolbar grey out a request this adapter does not implement.
      return {
        ...state,
        status: "running",
        adapter: event.adapter,
        capabilities: event.capabilities,
        error: null,
      };

    case "startFailed":
      return {
        ...INITIAL_DEBUG_STATE,
        status: "idle",
        error: event.error,
      };

    case "stopped":
      return applyStopped(state, event.body);

    case "continued":
      return {
        ...state,
        status: "running",
        stopReason: undefined,
        // A continued thread is no longer inspectable, so the stale stack and
        // variables are dropped instead of being shown as if they were live.
        frames: [],
        scopes: [],
        selectedFrame: 0,
        currentLocation: undefined,
        threadId: event.threadId ?? state.threadId,
      };

    case "process":
      return { ...state, processId: event.body.systemProcessId };

    case "thread": {
      const existing = state.threads.find((thread) => thread.id === event.threadId);
      if (existing) return state;
      const threads: ThreadEntry[] = [
        ...state.threads,
        { id: event.threadId, name: event.name },
      ];
      return { ...state, threads };
    }

    case "threads":
      // The `threads` request returns the full list, so it replaces rather than
      // appends: a thread that exited must disappear from the selector.
      return { ...state, threads: event.threads };

    case "threadSelected":
      // Switching threads invalidates the stack and variables shown for the
      // previous one; the caller refetches them for the new thread.
      return {
        ...state,
        threadId: event.threadId,
        frames: [],
        scopes: [],
        selectedFrame: 0,
        currentLocation: undefined,
      };

    case "terminated":
      // The program is gone, so the "you are here" marker must be too; leaving
      // it would show a current line on a session that no longer exists.
      return {
        ...state,
        status: "terminated",
        stopReason: undefined,
        threadId: undefined,
        frames: [],
        scopes: [],
        selectedFrame: 0,
        currentLocation: undefined,
      };

    case "exited":
      return {
        ...state,
        status: "terminated",
        stopReason: undefined,
        threadId: undefined,
        frames: [],
        scopes: [],
        selectedFrame: 0,
        currentLocation: undefined,
        // The exit code is the only thing the user learns about how the program
        // finished, so keep it where the status line can show it.
        output: appendOutput(state.output, {
          category: "console",
          text: `Program exited with code ${event.body.exitCode ?? "unknown"}`,
        }),
      };

    case "output":
      return applyOutput(state, event.body);

    case "adapterExited":
      return {
        ...state,
        status: "disconnected",
        error: event.message,
        threadId: undefined,
        frames: [],
        scopes: [],
        selectedFrame: 0,
        currentLocation: undefined,
      };

    case "frames": {
      const frames = event.frames.slice(0, MAX_FRAMES);
      const selectedFrame = clampSelection(state.selectedFrame, frames.length);
      return {
        ...state,
        frames,
        selectedFrame,
        currentLocation: locationOf(frames, selectedFrame),
      };
    }

    case "frameSelected": {
      if (event.index < 0 || event.index >= state.frames.length) return state;
      // Selecting a frame invalidates the scopes shown for the previous one and
      // moves the editor's current-line highlight.
      return {
        ...state,
        selectedFrame: event.index,
        scopes: [],
        currentLocation: locationOf(state.frames, event.index),
      };
    }

    case "scopes":
      return { ...state, scopes: event.scopes };

    case "error":
      return { ...state, error: event.message };

    case "reset":
      return { ...INITIAL_DEBUG_STATE };

    default:
      return state;
  }
}

/**
 * The `stopped` event is the single source of truth for "we are at a
 * breakpoint".
 */
function applyStopped(state: DebugState, body: DapStoppedBody): DebugState {
  // `allThreadsStopped: false` with no threadId (as on a `pause` of one thread)
  // still means something is stopped, so the status changes either way; only the
  // thread we act on is left unknown.
  const threadId = body.threadId ?? state.threadId;
  return {
    ...state,
    status: "stopped",
    stopReason: body.reason ?? "stopped",
    threadId,
    // Stale inspection data from a previous stop must not be shown against a new
    // location; the caller refetches frames and scopes.
    frames: [],
    scopes: [],
    selectedFrame: 0,
    currentLocation: undefined,
  };
}

function applyOutput(state: DebugState, body: DapOutputBody): DebugState {
  const text = body.output;
  if (!text) return state;
  return {
    ...state,
    output: appendOutput(state.output, {
      category: body.category ?? "console",
      text,
    }),
  };
}

function appendOutput(output: OutputLine[], line: OutputLine): OutputLine[] {
  // The adapter may send one line or a chunk containing many; splitting keeps
  // the tail bounded no matter how the adapter batches it.
  const parts = line.text.split(/\r?\n/).filter((part) => part.length > 0);
  if (parts.length === 0) return output;
  const next = [
    ...output,
    ...parts.map((part) => ({ category: line.category, text: part })),
  ];
  return next.length > MAX_OUTPUT_LINES
    ? next.slice(next.length - MAX_OUTPUT_LINES)
    : next;
}

function clampSelection(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/**
 * Where the editor should point for a given frame selection.
 *
 * Only the highlighted line comes from the adapter's `line` (1-based, as
 * requested through `linesStartAt1`); the highlight is meaningless without a
 * file, so a frame without a resolvable path yields `undefined` rather than
 * guessing.
 */
function locationOf(
  frames: StackFrame[],
  selected: number,
): DebugState["currentLocation"] {
  const frame = frames[selected];
  if (!frame?.path || !frame.line || frame.line < 1) return undefined;
  return { path: frame.path, line: frame.line };
}

/** Statuses in which a request is worth sending at all. */
export function canSend(status: DebugStatus, ...allowed: DebugStatus[]): boolean {
  return allowed.includes(status);
}

/** `true` when the Start button should be shown as "Start debugging". */
export function isStartAction(status: DebugStatus): boolean {
  return status === "idle" || status === "terminated" || status === "disconnected";
}

/** `true` when F5 means "continue" rather than "start". */
export function isContinueAction(status: DebugStatus): boolean {
  return status === "stopped" || status === "running";
}

/** `true` when stepping and stack inspection make sense. */
export function isStopped(status: DebugStatus): boolean {
  return status === "stopped";
}

/** `true` when the session exists and should be stopped explicitly. */
export function hasSession(status: DebugStatus): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "stopped" ||
    status === "terminated"
  );
}

/**
 * Merge an adapter's `setBreakpoints` verdict into our own breakpoint list.
 *
 * The adapter answers with the breakpoints *it* has, which is not always the
 * list we sent: a line it could not resolve comes back unverified, and a line it
 * silently dropped may be missing entirely. The user's intent is authoritative
 * (we keep showing their line), so a requested line that the adapter did not
 * mention is recorded as unverified rather than deleted.
 */
export function mergeBreakpointVerdicts(
  current: DebugBreakpoint[],
  response: DapBreakpoint[] | undefined,
): DebugBreakpoint[] {
  const byLine = new Map<number, DapBreakpoint>();
  for (const bp of response ?? []) {
    if (typeof bp.line === "number") byLine.set(bp.line, bp);
  }
  return current.map((bp) => {
    const verdict = byLine.get(bp.line);
    if (!verdict) {
      return { ...bp, verified: false, id: undefined, message: undefined };
    }
    return {
      line: bp.line,
      id: verdict.id,
      verified: verdict.verified === true,
      message: verdict.message,
    };
  });
}

/** Turn a file's breakpoint lines into the `setBreakpoints` payload. */
export function breakpointRequest(
  path: string,
  lines: number[],
): { source: { path: string }; breakpoints: { line: number }[]; sourceModified: boolean } {
  return {
    source: { path },
    breakpoints: [...lines].sort((a, b) => a - b).map((line) => ({ line })),
    sourceModified: false,
  };
}
