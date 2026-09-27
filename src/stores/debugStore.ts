import { create } from "zustand";
import { debugRequest } from "../commands";
import { fileKey } from "../utils/pathIdentity";
import { debugReducer } from "../debug/stateMachine";
import type { DebugEvent } from "../debug/stateMachine";
import {
  breakpointRequest,
  mergeBreakpointVerdicts,
} from "../debug/stateMachine";
import { INITIAL_DEBUG_STATE } from "../debug/types";
import type {
  DebugBreakpoint,
  DebugState,
  FileBreakpoints,
} from "../debug/types";
import type { DapBreakpoint } from "../debug/protocol";
import { useUiStore } from "./uiStore";

/**
 * Debug state, plus the breakpoint maps.
 *
 * Two separate concerns live here on purpose:
 *
 * - `session` is a single `DebugState` produced by the pure reducer. It is
 *   thrown away on every start, because it describes *one* debuggee.
 * - `breakpointsByWorkspace` holds the user's breakpoints **per workspace** and
 *   survives both a session ending and the workspace being switched away from
 *   and back. That is the behavior users expect from an editor: closing the
 *   debug view, or opening another folder and returning, must not silently
 *   delete the breakpoints they set. They are *not* persisted to disk — phase 1
 *   keeps them in memory, so restarting the IDE clears them.
 *
 * The store is intentionally dumb about protocol: it applies `DebugEvent`s and
 * holds data. Talking to the adapter lives in `debug/session.ts`.
 */

interface DebugStore {
  session: DebugState;
  /** Canonicalized file path → that file's breakpoints. */
  breakpointsByFile: Record<string, FileBreakpoints>;
  /** Canonicalized workspace path → its file map, kept across switches. */
  breakpointsByWorkspace: Record<string, Record<string, FileBreakpoints>>;
  /**
   * The active workspace's key. Held here rather than read from the workspace
   * store so this module depends on nothing: the alternative is a store
   * import cycle (workspace switching has to stop a session, and a session has
   * to know which workspace it belongs to).
   */
  workspaceKey: string;

  dispatch: (event: DebugEvent) => void;
  /** The active file's breakpoints, or an empty list. */
  breakpointsFor: (path: string) => DebugBreakpoint[];
  /**
   * Add or remove a breakpoint and, when a session is live, push the new list to
   * the adapter. Resolves the adapter's verdict, which is recorded per line.
   */
  toggleBreakpoint: (path: string, line: number) => Promise<void>;
  /** Push a file's full breakpoint list to the adapter. */
  syncBreakpoints: (path: string) => Promise<void>;
  /**
   * Record an adapter `breakpoint` event (verified/unverified) for one line.
   * Never adds or removes a user breakpoint — only updates its badge state.
   */
  recordBreakpointVerdict: (
    path: string,
    line: number,
    verified: boolean,
    id?: number,
  ) => void;
  /** Push every file that has breakpoints; used after `initialized`. */
  syncAllBreakpoints: (send: (args: unknown) => Promise<unknown>) => Promise<void>;
  /** Called when the workspace changes: swap the visible file map. */
  activateWorkspace: (workspacePath: string | null) => void;
  /** Forget every workspace's breakpoints (used by "remove all"). */
  clearBreakpoints: () => void;
}

const emptyFile = (path: string): FileBreakpoints => ({
  path,
  lines: [],
  ids: {},
  verified: [],
});

/** Store the per-workspace maps and the current file map stay in sync. */
function withFile(
  state: DebugStore,
  workspaceKey: string,
  path: string,
  next: FileBreakpoints | undefined,
): Pick<DebugStore, "breakpointsByWorkspace" | "breakpointsByFile"> {
  const byWorkspace = { ...state.breakpointsByWorkspace };
  const map = { ...(byWorkspace[workspaceKey] ?? {}) };
  if (next && next.lines.length > 0) {
    map[path] = next;
  } else {
    delete map[path];
  }
  byWorkspace[workspaceKey] = map;
  return { breakpointsByWorkspace: byWorkspace, breakpointsByFile: map };
}

export const useDebugStore = create<DebugStore>((set, get) => ({
  session: INITIAL_DEBUG_STATE,
  breakpointsByFile: {},
  breakpointsByWorkspace: {},
  workspaceKey: "",

  dispatch: (event) => {
    set((state) => ({ session: debugReducer(state.session, event) }));
  },

  breakpointsFor: (path) => {
    const file = get().breakpointsByFile[fileKey(path)];
    if (!file) return [];
    return file.lines.map((line) => ({
      line,
      id: file.ids[line],
      verified: file.verified.includes(line),
    }));
  },

  toggleBreakpoint: async (path, line) => {
    const key = fileKey(path);
    const workspaceKey = get().workspaceKey;
    const existing = get().breakpointsByFile[key] ?? emptyFile(path);
    const has = existing.lines.includes(line);
    const lines = has
      ? existing.lines.filter((l) => l !== line)
      : [...existing.lines, line].sort((a, b) => a - b);
    const next: FileBreakpoints = {
      ...existing,
      lines,
      ids: { ...existing.ids },
      verified: existing.verified.filter((l) => l !== line),
    };
    delete next.ids[line];

    set((state) => ({ ...withFile(state, workspaceKey, key, next) }));
    await get().syncBreakpoints(path);
  },

  syncBreakpoints: async (path) => {
    const key = fileKey(path);
    const file = get().breakpointsByFile[key];
    const status = get().session.status;
    if (!file || (status !== "running" && status !== "stopped")) return;

    try {
      // Called straight through the command wrapper rather than through
      // `debug/session`: the store must not depend on the orchestrator that
      // depends on it, and this is the one request the store issues itself.
      //
      // The payload is built from `file.path` (the recorded path, case
      // preserved), never from `key`: that key is case-folded on Windows, and
      // the adapter compares `Source.path` against its own debug information.
      const body = (await debugRequest(
        "setBreakpoints",
        breakpointRequest(file.path, file.lines),
      )) as {
        breakpoints?: DapBreakpoint[];
      };
      const merged = mergeBreakpointVerdicts(
        file.lines.map((line) => ({ line })),
        body?.breakpoints,
      );
      const ids: Record<number, number> = {};
      const verified: number[] = [];
      for (const bp of merged) {
        if (typeof bp.id === "number") ids[bp.line] = bp.id;
        if (bp.verified) verified.push(bp.line);
      }
      set((state) => ({
        ...withFile(state, get().workspaceKey, key, { ...file, ids, verified }),
      }));
    } catch (err) {
      useUiStore
        .getState()
        .showToast(`设置断点失败: ${String(err)}`, "error");
    }
  },

  recordBreakpointVerdict: (path, line, verified, id) => {
    const key = fileKey(path);
    const file = get().breakpointsByFile[key];
    // A `breakpoint` event for a line the user never set is ignored: the user's
    // list is authoritative, and the adapter must not be able to add to it.
    if (!file || !file.lines.includes(line)) return;
    const verifiedLines = new Set(file.verified);
    if (verified) {
      verifiedLines.add(line);
    } else {
      verifiedLines.delete(line);
    }
    const ids = { ...file.ids };
    if (id !== undefined) ids[line] = id;
    const next: FileBreakpoints = {
      ...file,
      ids,
      verified: [...verifiedLines].sort((a, b) => a - b),
    };
    set((state) => ({ ...withFile(state, get().workspaceKey, key, next) }));
  },

  syncAllBreakpoints: async (send) => {
    const files = Object.values(get().breakpointsByFile);
    for (const file of files) {
      const body = (await send(
        breakpointRequest(file.path, file.lines),
      )) as { breakpoints?: DapBreakpoint[] };
      const merged = mergeBreakpointVerdicts(
        file.lines.map((line) => ({ line })),
        body?.breakpoints,
      );
      const ids: Record<number, number> = {};
      const verified: number[] = [];
      for (const bp of merged) {
        if (typeof bp.id === "number") ids[bp.line] = bp.id;
        if (bp.verified) verified.push(bp.line);
      }
      const next = { ...file, ids, verified };
      set((state) => ({
        ...withFile(state, get().workspaceKey, fileKey(file.path), next),
      }));
    }
  },

  activateWorkspace: (workspacePath) => {
    const workspaceKey = fileKey(workspacePath ?? "");
    const map = get().breakpointsByWorkspace[workspaceKey] ?? {};
    set({ workspaceKey, breakpointsByFile: map });
  },

  clearBreakpoints: () => {
    set({ breakpointsByFile: {}, breakpointsByWorkspace: {} });
  },
}));
