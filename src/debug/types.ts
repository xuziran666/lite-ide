import type { DapCapabilities } from "./protocol";

/**
 * Language-agnostic debug domain types and the state machine's vocabulary.
 *
 * The one rule that shapes this file: **no language ids.** `language` appears
 * only as an opaque string that came from the editor and is used to look up
 * `debug.adapters.<language>`; nothing branches on its value. A C++ session, a
 * Rust session and a Go session are the same state with different adapters, so
 * adding one is a `user.json` edit.
 */

/** What a debug session is doing right now. */
export type DebugStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopped"
  | "terminated"
  | "disconnected";

/** Statuses in which a session exists and the adapter is expected to be alive. */
export const ACTIVE_STATUSES: readonly DebugStatus[] = [
  "starting",
  "running",
  "stopped",
  "terminated",
];

/** A breakpoint as the user set it, before/without the adapter's verdict. */
export interface DebugBreakpoint {
  /** 1-based line. */
  line: number;
  /** The adapter's `id`, once `setBreakpoints` reported one. */
  id?: number;
  /** The adapter's `verified` flag: false means "not resolved yet". */
  verified?: boolean;
  /** Verbatim adapter message, e.g. why a line could not be bound. */
  message?: string;
}

/** Breakpoints for one source file. */
export interface FileBreakpoints {
  /** Absolute path, canonicalized by `pathIdentity`. */
  path: string;
  /** Sorted ascending, unique. */
  lines: number[];
  /** Adapter-assigned ids, keyed by 1-based line. */
  ids: Record<number, number>;
  /** Lines the adapter has confirmed it bound. */
  verified: number[];
}

/** One entry of the call stack. */
export interface StackFrame {
  /** The adapter's `id`, needed by `scopes`. */
  id: number;
  name: string;
  /** Absolute source path, when the adapter sent one. */
  path?: string;
  /** 1-based line. */
  line?: number;
  column?: number;
}

/** A scope's variables, already flattened for display. */
export interface VariableEntry {
  name: string;
  value: string;
  type?: string;
  /** Non-zero when the value has children; phase 1 does not expand them. */
  reference?: number;
}

/** A scope returned by `scopes`, holding its resolved variables. */
export interface ScopeEntry {
  name: string;
  variablesReference: number;
  variables: VariableEntry[];
}

/** The most recent program output, kept for the toolbar/status line. */
export interface OutputLine {
  category: string;
  text: string;
}

/** The thread the session is currently focused on. */
export interface ThreadEntry {
  id: number;
  name?: string;
}

/** Everything the UI renders. Owned by `debugStore`. */
export interface DebugState {
  status: DebugStatus;
  /** The language id this session was started for (opaque). */
  language?: string;
  /** The adapter executable name, for the toolbar tooltip. */
  adapter?: string;
  /** Capabilities from `initialize`, used to disable unsupported buttons. */
  capabilities?: DapCapabilities;
  /** Why the session stopped, from the `stopped` event. */
  stopReason?: string;
  /** The thread that stopped, and therefore the one to act on. */
  threadId?: number;
  /** Frames of the focused thread, topmost first. */
  frames: StackFrame[];
  /** Index into `frames` of the frame the user selected. */
  selectedFrame: number;
  /** Scopes of the selected frame. */
  scopes: ScopeEntry[];
  threads: ThreadEntry[];
  /** The debuggee's process id, once known. */
  processId?: number;
  /** Where the program is stopped, for the editor highlight. */
  currentLocation?: { path: string; line: number };
  /** Tail of the adapter's `output` events. */
  output: OutputLine[];
  /** The last error worth showing the user. */
  error: string | null;
}

/** The status a fresh store starts in. */
export const INITIAL_DEBUG_STATE: DebugState = {
  status: "idle",
  frames: [],
  selectedFrame: 0,
  scopes: [],
  threads: [],
  output: [],
  error: null,
};
