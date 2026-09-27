/**
 * Minimal Debug Adapter Protocol wire types.
 *
 * DAP is **not** JSON-RPC, and this file exists to make that impossible to
 * forget: the three message shapes, the `arguments`/`body` split and the
 * `request_seq` correlation all differ from JSON-RPC. Rust already frames and
 * classifies the messages (`src-tauri/src/debug/transport.rs`); what arrives in
 * the frontend is the DAP event name and its body, already validated.
 *
 * Line numbers here are **1-based**, exactly as DAP defines them and exactly as
 * Monaco numbers its lines. That is why `initialize` asks for
 * `linesStartAt1`/`columnsStartAt1` and why no +/-1 conversion exists anywhere
 * in the debug feature. Contrast `src/lsp/protocol.ts`, where every converter
 * exists precisely because LSP is 0-based.
 *
 * Nothing in this file (or the rest of `src/debug/`) knows a language id: an
 * adapter is whatever `debug.adapters.<languageId>` in `user.json` names.
 */

/** A DAP source reference. We request `pathFormat: "path"`, so `path` is set. */
export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

/** A resolved breakpoint as reported by the adapter. */
export interface DapBreakpoint {
  id?: number;
  verified?: boolean;
  line?: number;
  column?: number;
  source?: DapSource;
  message?: string;
}

/** `setBreakpoints` response body. */
export interface DapSetBreakpointsResponse {
  breakpoints?: DapBreakpoint[];
}

/** `threads` response body. */
export interface DapThreadsResponse {
  threads?: DapThread[];
}

export interface DapThread {
  id: number;
  name?: string;
}

/** One frame of a `stackTrace` response. */
export interface DapStackFrame {
  id: number;
  name: string;
  line?: number;
  column?: number;
  source?: DapSource;
}

/** `stackTrace` response body. */
export interface DapStackTraceResponse {
  stackFrames?: DapStackFrame[];
  totalFrames?: number;
}

/** `scopes` response body. */
export interface DapScopesResponse {
  scopes?: DapScope[];
}

export interface DapScope {
  name?: string;
  variablesReference: number;
  expensive?: boolean;
}

/** `variables` response body. */
export interface DapVariablesResponse {
  variables?: DapVariable[];
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
  evaluateName?: string;
}

/** `initialize` response capabilities, read only for optional features. */
export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsTerminateRequest?: boolean;
  supportsRestartRequest?: boolean;
  supportsStepBack?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsClipboardContext?: boolean;
  exceptionBreakpointFilters?: { filter: string; label?: string }[];
  [key: string]: unknown;
}

/** The `initialize` response `body`. */
export interface DapInitializeResponse {
  capabilities?: DapCapabilities;
}

/** Bodies this client sends, all verbatim to the adapter. */
export interface DapLaunchArguments {
  program?: string;
  args?: string[];
  cwd?: string;
  stopOnEntry?: boolean;
  [key: string]: unknown;
}

export interface DapSetBreakpointsArguments {
  source: { path?: string; name?: string };
  breakpoints: { line: number }[];
  sourceModified?: boolean;
  lines?: number[];
}

/** The `stopped` event body: the reason we care about most. */
export interface DapStoppedBody {
  reason?: string;
  description?: string;
  text?: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
}

/** The `thread` event body, which can report a new thread. */
export interface DapThreadEventBody {
  reason?: string;
  threadId?: number;
}

/** The `exited` event body. */
export interface DapExitedBody {
  exitCode?: number;
}

/** The `process` event body. */
export interface DapProcessBody {
  name?: string;
  systemProcessId?: number;
  isLocalProcess?: boolean;
  startMethod?: string;
}

/** The `output` event body. */
export interface DapOutputBody {
  category?: string;
  output?: string;
  source?: DapSource;
  line?: number;
}

/** The `breakpoint` event body. */
export interface DapBreakpointEventBody {
  reason?: string;
  breakpoint?: DapBreakpoint;
}

/**
 * A DAP event forwarded from the backend: `{ event, body }`.
 *
 * The backend forwards names and bodies verbatim, which is what lets a new
 * adapter event reach the log without a backend change. Only the fields this
 * client actually reads are typed.
 */
export interface DapEventMessage {
  event: string;
  body?: Record<string, unknown>;
}

/** The payload of the backend's `debug-exited` event. */
export interface DebugExitedMessage {
  message?: string;
}

/** What `debug_start` resolves with. */
export interface DebugStartResult {
  adapter: string;
  capabilities: DapCapabilities;
}

/** Narrowing helpers — DAP bodies are untyped JSON until read. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a `source` and return its path.
 *
 * Typed as `unknown` because it is always called on a value that came out of
 * `asRecord` and may simply be missing — a frame with no source is normal
 * (native frames, synthetic frames), and must not throw.
 */
export function sourcePath(source: unknown): string | undefined {
  return asString(asRecord(source)?.path);
}
