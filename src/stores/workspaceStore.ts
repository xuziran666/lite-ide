import { create } from "zustand";
import {
  debugStop,
  getLastWorkspace,
  setWorkspace as setWorkspaceCommand,
} from "../commands";
import { useDebugStore } from "./debugStore";
import { useEditorStore } from "./editorStore";
import { useFileTreeStore } from "./fileTreeStore";
import { useTerminalStore } from "./terminalStore";
import { hasSession } from "../debug/stateMachine";

interface WorkspaceStore {
  workspacePath: string | null;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspacePath: null,
  loading: false,
  error: null,

  init: async () => {
    try {
      const path = await getLastWorkspace();
      if (path) {
        await get().openWorkspace(path);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openWorkspace: async (path: string) => {
    set({ loading: true, error: null });
    try {
      // Stop debugging the *outgoing* workspace before anything else is torn
      // down: the adapter is a child process bound to that workspace's program,
      // and the backend also stops the session on a workspace change. The
      // breakpoints stay in memory under the old workspace's key, so switching
      // back restores them.
      const debug = useDebugStore.getState();
      if (hasSession(debug.session.status)) {
        try {
          await debugStop();
        } finally {
          debug.dispatch({ kind: "reset" });
        }
      }
      const resolved = await setWorkspaceCommand(path);
      useEditorStore.getState().reset();
      useFileTreeStore.getState().reset();
      useTerminalStore.getState().reset();
      set({ workspacePath: resolved, loading: false, error: null });
      // After the path is committed, so the debug store's workspace key and the
      // workspace store's path can never disagree.
      useDebugStore.getState().activateWorkspace(resolved);
      await useFileTreeStore.getState().loadRoot(resolved);
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
}));
