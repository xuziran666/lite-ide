import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { debugRequest, debugStart, debugStop } from "../commands";
import { debugAdapterForType, debugLaunchFor, useConfigStore } from "../stores/configStore";
import { useDebugStore } from "../stores/debugStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useEditorStore } from "../stores/editorStore";
import { asNumber, asRecord, asString, sourcePath } from "./protocol";
import type { DapScope } from "./protocol";
import {
  buildLaunchArguments,
  requestKindOf,
  selectLaunchConfiguration,
  toLaunchArguments,
} from "./launchConfig";
import type { DebugRequestKind } from "./launchConfig";
import { useTerminalStore } from "../stores/terminalStore";
import type {
  DebugState,
  ScopeEntry,
  StackFrame,
  ThreadEntry,
  VariableEntry,
} from "./types";
import { breakpointRequest } from "./stateMachine";
import type { DebugEvent } from "./stateMachine";
import { fileKey } from "../utils/pathIdentity";
import { toUint8Array } from "./debugTerminalOutput";

/**
 * Driving one debug session: sending requests, and turning the adapter's event
 * stream into store dispatches.
 *
 * The sequencing here is the part that is easy to get wrong, so it is worth
 * stating plainly. `initialize` → `launch` happen in the backend, and the
 * backend returns *immediately* after `launch` is written. Everything that
 * depends on the adapter being ready is driven from the `initialized` event:
 *
 *   initialize → setExceptionBreakpoints → launch  (backend)
 *                                        ↓
 *                            initialized (event, adapter)
 *                                        ↓
 *                            setBreakpoints (per file)
 *                                        ↓
 *                            configurationDone
 *                                        ↓
 *                            process / stopped (events)
 *
 * Two protocol facts force this shape. A real `lldb-dap` withholds the `launch`
 * *response* until the debuggee first stops, so anything that awaits that
 * response before continuing would deadlock; and breakpoints sent before
 * `initialized` are not reliably bindable, because the adapter has not loaded
 * target symbols yet. Waiting for the event instead of the response is the only
 * ordering that works for every adapter.
 */

let unlistenEvent: UnlistenFn | null = null;
let unlistenExited: UnlistenFn | null = null;
let unlistenTerminal: UnlistenFn | null = null;
let unlistenDebugOutput: UnlistenFn | null = null;
let unlistenDebugExit: UnlistenFn | null = null;
let subscriptionsReady: Promise<void> | null = null;
let activeSessionId: number | null = null;
const staleSessionIds = new Set<number>();
let queuedEvents: Array<{ sessionId: number; event: string; body: unknown }> = [];

const dispatch = (event: DebugEvent): void =>
  useDebugStore.getState().dispatch(event);
let unlistenError: UnlistenFn | null = null;

const session = () => useDebugStore.getState().session;

/** Send a request, turning a backend/adapter failure into a reported error. */
async function request(
  command: string,
  args?: unknown,
): Promise<unknown> {
  try {
    return await debugRequest(command, args);
  } catch (err) {
    useUiStore.getState().showToast(`${command} 失败: ${String(err)}`, "error");
    throw err;
  }
}

/** Subscribe to the backend's DAP event stream. Idempotent. */
export function ensureDebugSubscriptions(): Promise<void> {
  if (!subscriptionsReady) {
    subscriptionsReady = (async () => {
      unlistenEvent = await listen<{ event: string; body: unknown }>(
        "debug-event",
        ({ payload }) => {
          const event = payload as typeof payload & { sessionId: number };
          if (activeSessionId === null) {
            if (session().status === "starting") queuedEvents.push(event);
            return;
          }
          if (event.sessionId !== activeSessionId) return;
          void handleEvent(event.event, event.body, event.sessionId);
        },
      );
      unlistenError = await listen<{ sessionId: number; message: string }>(
        "debug-error",
        ({ payload }) => {
          if (payload.sessionId !== activeSessionId) return;
          dispatch({ kind: "error", message: payload.message });
          useUiStore.getState().showToast(payload.message, "error");
        },
      );
      unlistenDebugOutput = await listen<{
        id: number;
        sessionId: number;
        data: unknown;
      }>("debug-terminal-output", ({ payload }) => {
        if (staleSessionIds.has(payload.sessionId)) return;
        useTerminalStore
          .getState()
          .appendDebugOutput(payload.sessionId, toUint8Array(payload.data));
      });
      unlistenDebugExit = await listen<{
        id: number;
        sessionId: number;
      }>("debug-terminal-exit", ({ payload }) => {
        // Keep already-buffered bytes until xterm consumes them. The PTY
        // flusher sends the final empty chunk after its pending bytes, but
        // Tauri event delivery can still let the exit event reach this
        // listener before React mounts the terminal.
        staleSessionIds.add(payload.sessionId);
        useTerminalStore
          .getState()
          .markDebugTerminalExited(payload.sessionId, payload.id);
      });
      unlistenExited = await listen<{ message: string }>(
        "debug-exited",
        ({ payload }) => {
          const event = payload as typeof payload & { sessionId: number };
          if (event.sessionId !== activeSessionId) return;
          dispatch({ kind: "adapterExited", message: payload.message });
        },
      );
      // The adapter asked us to run the debuggee in a terminal. The tab is
      // created on F5 already; this makes it idempotent for any other path.
      unlistenTerminal = await listen<{ id: number; sessionId: number }>(
        "debug-terminal-opened",
        ({ payload }) => {
          if (staleSessionIds.has(payload.sessionId)) return;
          useTerminalStore.getState().ensureDebugTerminal();
        },
      );
    })();
  }
  return subscriptionsReady;
}

export function disposeDebugSubscriptions(): void {
  unlistenEvent?.();
  unlistenExited?.();
  unlistenError?.();
  unlistenDebugOutput?.();
  unlistenDebugExit?.();
  unlistenTerminal?.();
  unlistenEvent = null;
  unlistenExited = null;
  unlistenError = null;
  unlistenDebugOutput = null;
  unlistenDebugExit = null;
  unlistenTerminal = null;
  subscriptionsReady = null;
  activeSessionId = null;
  staleSessionIds.clear();
  queuedEvents = [];
}

/** Route one DAP event. Unknown events are ignored by design. */
async function handleEvent(
  event: string,
  raw: unknown,
  sessionId: number,
): Promise<void> {
  if (sessionId !== activeSessionId) return;
  const body = asRecord(raw) ?? {};
  switch (event) {
    case "initialized":
      await onInitialized(sessionId);
      return;

    case "stopped": {
      dispatch({ kind: "stopped", body: body as never });
      await refreshThreadAndFrames();
      return;
    }

    case "continued":
      dispatch({ kind: "continued", threadId: asNumber(body.threadId) });
      return;

    case "process":
      dispatch({ kind: "process", body: body as never });
      return;

    case "thread": {
      const threadId = asNumber(body.threadId);
      if (threadId !== undefined) {
        dispatch({ kind: "thread", threadId, name: asString(body.name) });
      }
      return;
    }

    case "terminated":
      dispatch({ kind: "terminated" });
      return;

    case "exited":
      dispatch({ kind: "exited", body: body as never });
      return;

    case "output":
      dispatch({ kind: "output", body: body as never });
      return;

    case "breakpoint": {
      // The adapter's own view of one breakpoint (verified, changed, removed).
      // The user's list is authoritative, so this only records the verdict for a
      // line they already set; it must not re-send `setBreakpoints`, which would
      // let an adapter that emits this event on every change drive a request loop.
      const bp = asRecord(body.breakpoint);
      const line = asNumber(bp?.line);
      const path = sourcePath(bp?.source);
      if (line !== undefined && path) {
        useDebugStore
          .getState()
          .recordBreakpointVerdict(path, line, bp?.verified === true, asNumber(bp?.id));
      }
      return;
    }

    default:
      // `module`, `loadedSource`, `process` extras, and anything a future
      // adapter invents: nothing in the UI depends on them.
      return;
  }
}

/**
 * The adapter is ready: push every breakpoint the user has set, then tell it we
 * are configured. Only after this does the program actually start, so a
 * breakpoint on line 5 is already in place when `main` runs.
 */
async function onInitialized(sessionId: number): Promise<void> {
  if (sessionId !== activeSessionId) return;
  const debug = useDebugStore.getState();
  try {
    await debug.syncAllBreakpoints((args) =>
      debugRequest("setBreakpoints", args),
    );
    if (sessionId !== activeSessionId) return;
    await debugRequest("configurationDone", {});
  } catch (err) {
    useUiStore
      .getState()
      .showToast(`初始化断点失败: ${String(err)}`, "error");
  }
}

/** The current file's breakpoints, for the editor's gutter. */
export function breakpointsForFile(path: string): number[] {
  const file = useDebugStore.getState().breakpointsByFile[fileKey(path)];
  return file ? [...file.lines] : [];
}

/** Turn a `stackTrace` body into UI frames. */
export function toFrames(raw: unknown): StackFrame[] {
  const list = Array.isArray(raw) ? raw : [];
  const frames: StackFrame[] = [];
  for (const item of list) {
    const frame = asRecord(item);
    if (!frame) continue;
    const id = asNumber(frame.id);
    if (id === undefined) continue;
    frames.push({
      id,
      name: asString(frame.name) ?? `#${id}`,
      path: sourcePath(frame.source),
      line: asNumber(frame.line),
      column: asNumber(frame.column),
    });
  }
  return frames;
}

/** Flatten a `scopes` body, resolving each scope's `variables`. */
async function resolveScopes(
  scopes: DapScope[],
  frame: DebugState,
): Promise<ScopeEntry[]> {
  const entries: ScopeEntry[] = [];
  for (const scope of scopes) {
    const variablesReference = asNumber(scope.variablesReference) ?? 0;
    const entry: ScopeEntry = {
      name: asString(scope.name) ?? "Locals",
      variablesReference,
      variables: [],
    };
    // A reference of 0 means "no variables", per the spec. Asking anyway is
    // harmless on some adapters but an error on others, so it is skipped.
    if (variablesReference > 0 && frame.threadId !== undefined) {
      try {
        const body = asRecord(
          await debugRequest("variables", { variablesReference }),
        );
        entry.variables = toVariables(body?.variables);
      } catch {
        entry.variables = [];
      }
    }
    entries.push(entry);
  }
  return entries;
}

/** Phase 1 renders values flat: children are not expanded. */
function toVariables(raw: unknown): VariableEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: VariableEntry[] = [];
  for (const item of list) {
    const variable = asRecord(item);
    if (!variable) continue;
    const name = asString(variable.name);
    if (name === undefined) continue;
    const value = asString(variable.value);
    const type = asString(variable.type);
    const reference = asNumber(variable.variablesReference);
    out.push({
      name,
      value: value ?? (reference ? "…" : ""),
      type,
      reference,
    });
  }
  return out;
}

/** After a stop: refresh the thread list, then the stack of the active thread. */
async function refreshThreadAndFrames(): Promise<void> {
  let threadId = session().threadId;

  // The thread list feeds the selector and is also the only way to learn which
  // thread stopped when the `stopped` event omitted one (all threads stopped).
  try {
    const body = asRecord(await debugRequest("threads", {}));
    const threads = toThreads(body?.threads);
    if (threads.length > 0) {
      dispatch({ kind: "threads", threads });
      if (threadId === undefined) threadId = threads[0].id;
    }
  } catch {
    // No thread list: fall through with whatever thread id we already have.
  }
  if (threadId === undefined) return;
  await loadStackForThread(threadId);
}

/** Switch the active thread: clear the previous stack, then load the new one. */
export async function selectThread(threadId: number): Promise<void> {
  if (session().threadId === threadId) return;
  dispatch({ kind: "threadSelected", threadId });
  await loadStackForThread(threadId);
}

/** Frame 0 of one thread, then its scopes. */
async function loadStackForThread(threadId: number): Promise<void> {
  try {
    const body = asRecord(
      await debugRequest("stackTrace", { threadId, startFrame: 0, levels: 100 }),
    );
    const frames = toFrames(body?.stackFrames);
    if (frames.length === 0) return;
    dispatch({ kind: "frames", frames });
    // `stackTrace` does not carry scopes; they come from a separate `scopes`
    // request keyed by the frame. Frame 0 is the one the user cares about, so its
    // variables load immediately instead of waiting for a click on an empty list.
    const topFrame = frames[0];
    if (topFrame) {
      await loadScopesForFrame(topFrame.id, threadId);
    }
  } catch (err) {
    dispatch({ kind: "error", message: String(err) });
  }
}

/** Turn a DAP `threads` body into UI threads. */
function toThreads(raw: unknown): ThreadEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const threads: ThreadEntry[] = [];
  for (const item of list) {
    const thread = asRecord(item);
    const id = asNumber(thread?.id);
    if (id === undefined) continue;
    threads.push({ id, name: asString(thread?.name) });
  }
  return threads;
}

/** Fetch one variables reference's children, for the tree expansion. */
export async function fetchVariables(
  variablesReference: number,
): Promise<VariableEntry[]> {
  try {
    const body = asRecord(
      await debugRequest("variables", { variablesReference }),
    );
    return toVariables(body?.variables);
  } catch {
    // An expansion that fails stays collapsed rather than erroring the session.
    return [];
  }
}

/** Fetch and dispatch the scopes of one frame. */
async function loadScopesForFrame(
  frameId: number,
  threadId: number,
): Promise<void> {
  try {
    const body = asRecord(await debugRequest("scopes", { frameId }));
    const scopes = Array.isArray(body?.scopes) ? (body.scopes as DapScope[]) : [];
    if (scopes.length > 0) {
      dispatch({
        kind: "scopes",
        scopes: await resolveScopes(scopes, { ...session(), threadId }),
      });
    }
  } catch (err) {
    dispatch({ kind: "error", message: String(err) });
  }
}

/** Clicking a frame: show where it is, and load its variables. */
export async function selectFrame(index: number): Promise<void> {
  const state = session();
  const frame = state.frames[index];
  if (!frame) return;
  dispatch({ kind: "frameSelected", index });
  if (state.threadId === undefined) return;
  await loadScopesForFrame(frame.id, state.threadId);
}

/** The active tab, which carries both the path and its language id. */
function activeTab() {
  const { openFiles, activePath } = useEditorStore.getState();
  if (!activePath) return undefined;
  return openFiles.find((tab) => tab.path === activePath);
}

/** The language id of the active file: the fallback adapter key, and the
 * `program` default key when there is no `launch.json` configuration. */
function activeLanguage(): string | undefined {
  return activeTab()?.language;
}

/**
 * Start debugging the active file's language.
 *
 * The launch configuration comes from the global `launch.json` when it has one
 * (its `type` then names the adapter, and its fields become the DAP `launch`
 * arguments); otherwise from `user.json`'s `debug.launch.<language>`, with the
 * built-in `program` default for languages that have one. Which of `launch` /
 * `attach` is sent comes from the configuration's `request` field
 * (VS Code-style), unless `override` forces one. A missing adapter is reported
 * with the exact config key to add, because that is the one failure every user
 * hits first and the least guessable from the message alone.
 */
export async function startDebugging(
  language: string | undefined = activeLanguage(),
  override?: DebugRequestKind,
): Promise<void> {
  const debug = useDebugStore.getState();
  if (language === undefined) {
    useUiStore.getState().showToast("没有可调试的文件", "error");
    return;
  }
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  if (!workspacePath) {
    useUiStore.getState().showToast("请先打开工作区", "error");
    return;
  }
  if (debug.session.status !== "idle" && debug.session.status !== "terminated" && debug.session.status !== "disconnected") {
    return;
  }

  // The global `launch.json` wins when it has a usable configuration; with none
  // (no file, or every entry rejected) the language-keyed path below runs
  // exactly as it did before, so an old project keeps debugging.
  const { launch: launchConfigurations, launchError } = useConfigStore.getState();
  const config = selectLaunchConfiguration(launchConfigurations, (type) =>
    debugAdapterForType(type) !== undefined,
  );
  if (launchError) {
    // Only claim a fallback when there really is one: a file with one bad entry
    // and one good one still runs the good one.
    useUiStore
      .getState()
      .showToast(
        config ? launchError : `${launchError}（已改用默认调试配置）`,
        "error",
      );
  }
  // The adapter id: the configuration's `type`, or the language id of the
  // legacy path. It selects `debug.adapters.<id>` and is announced to the
  // adapter as `initialize.arguments.adapterID`.
  const type = config?.type ?? language;
  const configured = config ? toLaunchArguments(config) : debugLaunchFor(language);
  const request: DebugRequestKind = override ?? requestKindOf(configured);
  dispatch({ kind: "startRequested", language });
  if (activeSessionId !== null) {
    staleSessionIds.add(activeSessionId);
  }
  activeSessionId = null;
  useTerminalStore.getState().beginDebugSession();
  queuedEvents = [];
  await ensureDebugSubscriptions();

  const adapter = debugAdapterForType(type);
  if (!adapter) {
    dispatch({
      kind: "startFailed",
      error: `未配置调试器，请在 user.json 中添加 debug.adapters.${type}`,
    });
    useUiStore
      .getState()
      .showToast(`未配置 ${type} 的调试适配器`, "error");
    return;
  }

  // Create/reveal the Debug Terminal before launch so its xterm is mounted (and
  // listening) by the time the adapter's `runInTerminal` fills it with output.
  useTerminalStore.getState().ensureDebugTerminal();

  const launch = buildLaunchArguments(language, configured, {
    workspacePath,
    filePath: activeTab()?.path ?? null,
  });

  try {
    const result = await debugStart(type, adapter, launch, request);
    activeSessionId = result.sessionId;
    staleSessionIds.delete(result.sessionId);
    useTerminalStore.getState().setDebugSessionId(result.sessionId);
    dispatch({
      kind: "started",
      adapter: result.adapter,
      capabilities: result.capabilities,
    });
    const pending = queuedEvents;
    queuedEvents = [];
    for (const event of pending) {
      if (event.sessionId === activeSessionId) {
        void handleEvent(event.event, event.body, event.sessionId);
      }
    }
  } catch (err) {
    const message = String(err);
    dispatch({ kind: "startFailed", error: message });
    useUiStore.getState().showToast(`启动调试失败: ${message}`, "error");
  }
}

/** F5: continue when a session exists, start a new one otherwise. */
export async function startOrContinue(): Promise<void> {
  const { status } = session();
  if (status === "stopped") {
    await continueSession();
    return;
  }
  if (status === "running") return;
  await startDebugging();
}

/**
 * Resume the stopped thread.
 *
 * The current-line marker is cleared **immediately**, before the request is even
 * sent: a real adapter may defer the `continue` response until the debuggee next
 * stops (lldb-dap does), so clearing on the response would leave the old
 * highlight on screen for the whole time the program is running. The `continued`
 * event, when an adapter also sends it, is idempotent here.
 */
export async function continueSession(): Promise<void> {
  const { threadId } = session();
  dispatch({ kind: "continued", threadId });
  try {
    await request("continue", {
      threadId,
      singleThread: threadId !== undefined,
    });
  } catch {
    // `request` already surfaced the failure.
  }
}

export async function pauseSession(): Promise<void> {
  const { threadId } = session();
  // Drop any stale stop marker while the pause is in flight; the `stopped` event
  // that follows places a fresh one at the paused location.
  dispatch({ kind: "continued", threadId });
  try {
    await request("pause", { threadId });
  } catch {
    // Reported by `request`.
  }
}

/**
 * One step request, shared by the three step buttons.
 *
 * As with continue, the marker is cleared up front rather than on the response:
 * stepping is a running period, and it must not show the line the program has
 * already left. The next `stopped` repositions it.
 */
async function step(command: "next" | "stepIn" | "stepOut"): Promise<void> {
  const state = session();
  if (state.threadId === undefined) return;
  dispatch({ kind: "continued", threadId: state.threadId });
  try {
    await request(command, { threadId: state.threadId });
  } catch {
    // Reported by `request`.
  }
}

export const stepOver = (): Promise<void> => step("next");
export const stepInto = (): Promise<void> => step("stepIn");
export const stepOut = (): Promise<void> => step("stepOut");

/** Stop: disconnect and terminate the debuggee, then reset the view. */
export async function stopSession(): Promise<void> {
  try {
    await debugStop();
  } catch (err) {
    useUiStore.getState().showToast(`停止调试失败: ${String(err)}`, "error");
  }
  if (activeSessionId !== null) {
    staleSessionIds.add(activeSessionId);
  }
  activeSessionId = null;
  queuedEvents = [];
  dispatch({ kind: "reset" });
}

/**
 * Restart the current session: stop it, then start a fresh one for the same
 * language.
 *
 * This is orchestration over the existing start/stop commands, not a new DAP
 * request — there is no `restart` in the phase-1 protocol. `debugStop` resolves
 * only after the backend has taken the session slot and shut the adapter down,
 * so the following `startDebugging` cannot hit the "already running" guard.
 */
export async function restartSession(): Promise<void> {
  const language = session().language;
  if (!language) return;
  await stopSession();
  await startDebugging(language);
}

/** Toggle a breakpoint on a 1-based line and push it to a live session. */
export async function toggleBreakpoint(
  path: string,
  line: number,
): Promise<void> {
  if (line < 1) return;
  await useDebugStore.getState().toggleBreakpoint(path, line);
}

/** Push the whole breakpoint list of a file; used after the model changes. */
export async function syncBreakpointsForFile(path: string): Promise<void> {
  await useDebugStore.getState().syncBreakpoints(path);
}

export { breakpointRequest };
