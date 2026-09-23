import { create } from "zustand";

/** A single terminal session in the panel. The backend keys the live PTY by
 * `id`, so the same id survives restarts but is never reused after a close. */
export interface TerminalRecord {
  id: number;
  name: string;
  exited: boolean;
}

interface TerminalStore {
  terminals: TerminalRecord[];
  activeId: number | null;
  /** Next id to hand out; ids are counters, not reused after closing. */
  nextId: number;
  create: () => number;
  close: (id: number) => void;
  select: (id: number) => void;
  markExited: (id: number) => void;
  markRunning: (id: number) => void;
  reset: () => void;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: [],
  activeId: null,
  nextId: 1,

  create: () => {
    const id = get().nextId;
    set((s) => ({
      terminals: [...s.terminals, { id, name: `终端 ${id}`, exited: false }],
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

  reset: () => {
    set({ terminals: [], activeId: null, nextId: 1 });
  },
}));