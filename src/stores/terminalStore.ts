import { create } from "zustand";
import { DebugOutputBuffer } from "../debug/debugTerminalOutput.ts";

/** A single terminal session in a dock. The backend keys the live PTY by
 * `id`, so the same id survives restarts but is never reused after a close. */
export interface TerminalRecord {
  id: number;
  name: string;
  exited: boolean;
  dock: TerminalDock;
  /** "task" terminals are pinned/reused by the Tasks feature; "debug" is the
   *  debuggee's own terminal (DAP `runInTerminal`). */
  kind?: "normal" | "task" | "debug";
}

export type TerminalDock = "bottom" | "editor" | "right";

export type TerminalDockSelection = Record<TerminalDock, number | null>;

/**
 * The id of the debuggee's terminal. A fixed, high id shared with the Rust side
 * (`terminal::DEBUG_TERMINAL_ID`) so the Debug Terminal is one reusable tab and
 * the normal `terminal_write` / `terminal_resize` / `terminal_kill` commands
 * address it. Normal terminals hand out small sequential ids, so no collision.
 */
export const DEBUG_TERMINAL_ID = 1_000_000;

interface TerminalStore {
  terminals: TerminalRecord[];
  activeIdByDock: TerminalDockSelection;
  /** Next id to hand out; ids are counters, not reused after closing. */
  nextId: number;
  /** Bumped whenever the debug terminal should be revealed, so a layout effect
   *  can expand the panel and focus it without the store owning UI state. */
  revealSeq: number;
  debugSessionId: number | null;
  debugOutputRevision: number;
  debugOutput: DebugOutputBuffer;
  create: (kind?: "normal" | "task", dock?: TerminalDock) => number;
  close: (id: number) => void;
  select: (id: number) => void;
  move: (id: number, dock: TerminalDock) => void;
  markExited: (id: number) => void;
  markRunning: (id: number) => void;
  setDebugSessionId: (sessionId: number | null) => void;
  appendDebugOutput: (sessionId: number, data: Uint8Array) => void;
  consumeDebugOutput: (sessionId: number) => Uint8Array;
  clearDebugOutput: (sessionId: number) => void;
  /** Create the single Debug Terminal (or reset it for a new run) and select it. */
  ensureDebugTerminal: () => void;
  reset: () => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  activeIdByDock: { bottom: null, editor: null, right: null },
  nextId: 1,
  revealSeq: 0,
  debugSessionId: null,
  debugOutputRevision: 0,
  debugOutput: new DebugOutputBuffer(),

  create: (kind = "normal", dock = "bottom") => {
    const id = get().nextId;
    set((s) => ({
      terminals: [
        ...s.terminals,
        {
          id,
          name: kind === "task" ? "任务" : `终端 ${id}`,
          exited: false,
          dock,
          kind,
        },
      ],
      activeIdByDock: { ...s.activeIdByDock, [dock]: id },
      nextId: s.nextId + 1,
    }));
    return id;
  },

  close: (id: number) => {
    const { terminals, activeIdByDock } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const closing = terminals[idx];
    const remaining = terminals.filter((t) => t.id !== id);
    const activeIds = { ...activeIdByDock };
    if (activeIds[closing.dock] === id) {
      // Prefer the left neighbour, then the right neighbour, then leave empty.
      const sameDock = remaining.filter((t) => t.dock === closing.dock);
      const previous = terminals
        .slice(0, idx)
        .reverse()
        .find((t) => t.dock === closing.dock);
      const next = terminals.slice(idx + 1).find((t) => t.dock === closing.dock);
      activeIds[closing.dock] = previous?.id ?? next?.id ?? sameDock[0]?.id ?? null;
    }
    set({ terminals: remaining, activeIdByDock: activeIds });
  },

  select: (id: number) => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal) return;
    set((s) => ({
      activeIdByDock: { ...s.activeIdByDock, [terminal.dock]: id },
    }));
  },

  move: (id, dock) => {
    const { terminals, activeIdByDock } = get();
    const terminal = terminals.find((t) => t.id === id);
    if (!terminal) return;
    if (terminal.dock === dock) {
      set((s) => ({
        activeIdByDock: { ...s.activeIdByDock, [dock]: id },
      }));
      return;
    }

    const sourceTerminals = terminals.filter(
      (item) => item.dock === terminal.dock && item.id !== id,
    );
    const sourceIndex = terminals
      .filter((item) => item.dock === terminal.dock)
      .findIndex((item) => item.id === id);
    const sourceActive = activeIdByDock[terminal.dock] === id;
    const sourceFallback = sourceActive
      ? sourceTerminals[Math.min(sourceIndex, sourceTerminals.length - 1)]?.id ?? null
      : activeIdByDock[terminal.dock];

    set({
      terminals: terminals.map((item) =>
        item.id === id ? { ...item, dock } : item,
      ),
      activeIdByDock: {
        ...activeIdByDock,
        [terminal.dock]: sourceFallback,
        [dock]: id,
      },
    });
  },

  markExited: (id: number) => {
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, exited: true } : t,
      ),
    }));
  },

  markRunning: (id: number) => {
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === id ? { ...t, exited: false } : t,
      ),
    }));
  },

  setDebugSessionId: (debugSessionId) => set({ debugSessionId }),

  appendDebugOutput: (sessionId, data) => {
    set((state) => {
      state.debugOutput.append(sessionId, data);
      return { debugOutputRevision: state.debugOutputRevision + 1 };
    });
  },

  consumeDebugOutput: (sessionId) => {
    return get().debugOutput.consume(sessionId);
  },

  clearDebugOutput: (sessionId) => {
    set((state) => {
      state.debugOutput.clear(sessionId);
      return { debugOutputRevision: state.debugOutputRevision + 1 };
    });
  },

  ensureDebugTerminal: () => {
    set((s) => {
      const existing = s.terminals.find((t) => t.kind === "debug");
      const terminals = existing
        ? s.terminals.map((t) =>
            t.kind === "debug" ? { ...t, exited: false } : t,
          )
        : [
            ...s.terminals,
            {
              id: DEBUG_TERMINAL_ID,
              name: "Debug",
              exited: false,
              dock: "bottom" as const,
              kind: "debug" as const,
            },
          ];
      const debugTerminal = terminals.find((t) => t.kind === "debug")!;
      return {
        terminals,
        activeIdByDock: {
          ...s.activeIdByDock,
          [debugTerminal.dock]: DEBUG_TERMINAL_ID,
        },
        revealSeq: s.revealSeq + 1,
      };
    });
  },

  reset: () => {
    set({
      terminals: [],
      activeIdByDock: { bottom: null, editor: null, right: null },
      nextId: 1,
      revealSeq: 0,
      debugSessionId: null,
      debugOutputRevision: 0,
      debugOutput: new DebugOutputBuffer(),
    });
  },
}));
