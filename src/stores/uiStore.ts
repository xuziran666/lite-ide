import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

interface UiStore {
  toasts: Toast[];
  showToast: (message: string, kind?: "info" | "error") => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUiStore = create<UiStore>((set) => ({
  toasts: [],

  showToast: (message, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    window.setTimeout(() => {
      useUiStore.getState().dismissToast(id);
    }, 4000);
  },

  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));