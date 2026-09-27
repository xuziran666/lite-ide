import { create } from "zustand";

/** A single terminal session in the panel. The backend keys the live PTY by
 * `id`, so the same id survives restarts but is never reused after a close. */
export interface TerminalRecord {
  id: number;
  name: string;
  exited: boolean;
  /** "task" terminals are pinned/reused by the Tasks feature; "debug" is the
   *  debuggee's own terminal (DAP `runInTerminal`). */
  kind?: "normal" | "task" | "debug";
}

/**
 * The id of the debuggee's terminal. A fixed, high id shared with the Rust side
 * (`terminal::DEBUG_TERMINAL_ID`) so the Debug Terminal is one reusable tab and
 * the normal `terminal_write` / `terminal_resize` / `terminal_kill` commands
 * address it. Normal terminals hand out small sequential ids, so no collision.
 */
export const DEBUG_TERMINAL_ID = 1_000_000;

interface TerminalStore {
  terminals: TerminalRecord[];
  activeId: number | null;
  /** Next id to hand out; ids are counters, not reused after closing. */
  nextId: number;
  /** Bumped whenever the debug terminal should be revealed, so a layout effect
   *  can expand the panel and focus it without the store owning UI state. */
  revealSeq: number;
  create: (kind?: "normal" | "task") => number;
  close: (id: number) => void;
  select: (id: number) => void;
  markExited: (id: number) => void;
  markRunning: (id: number) => void;
  /** Create the single Debug Terminal (or reset it for a new run) and select it. */
  ensureDebugTerminal: () => void;
  reset: () => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  activeId: null,
  nextId: 1,
  revealSeq: 0,

  create: (kind = "normal") => {
    const id = get().nextId;
    set((s) => ({
      terminals: [
        ...s.terminals,
        {
          id,
          name: kind === "task" ? "任务" : `终端 ${id}`,
          exited: false,
          kind,
        },
      ],
      activeId: id,
      nextId: s.nextId + 1,
    }));
    return id;
  },

  close: (id: number) => {
    const { terminals, activeId } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const remaining = terminals.filter((t) => t.id !== id);
    let active = activeId;
    if (active === id) {
      // Prefer the left neighbour, then the right neighbour, then leave empty.
      active = remaining[idx - 1]?.id ?? remaining[idx]?.id ?? null;
    }
    set({ terminals: remaining, activeId: active });
  },

  select: (id: number) => {
    set({ activeId: id });
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
              kind: "debug" as const,
            },
          ];
      return {
        terminals,
        activeId: DEBUG_TERMINAL_ID,
        revealSeq: s.revealSeq + 1,
      };
    });
  },

  reset: () => {
    set({ terminals: [], activeId: null, nextId: 1, revealSeq: 0 });
  },
}));
