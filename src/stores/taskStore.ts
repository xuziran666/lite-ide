import { create } from "zustand";
import { loadWorkspaceTasks } from "../commands";
import type { TaskSpec } from "../commands";
import { needsActiveFile, resolveTaskCommand } from "../utils/taskVariables";
import { useEditorStore } from "./editorStore";
import { useTerminalStore } from "./terminalStore";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/** The life cycle of the single dedicated task terminal. */
export type TaskStatus = "idle" | "running" | "exited";

/** A task queued for the dedicated task terminal, command already resolved. */
export interface PendingTask {
  name: string;
  command: string;
}

interface TaskStore {
  tasks: TaskSpec[];
  tasksError: string | null;
  loading: boolean;
  taskCenterOpen: boolean;
  /** Id of the dedicated task terminal; recreated on demand after a close. */
  taskTerminalId: number | null;
  taskStatus: TaskStatus;
  activeTaskName: string | null;
  /** A run waiting for the task terminal to pick it up and write it. */
  pendingTask: PendingTask | null;
  /** Bumped on every run request so the layout can reveal + focus the panel. */
  taskRunSeq: number;
  refresh: () => Promise<void>;
  reset: () => void;
  openTaskCenter: () => void;
  closeTaskCenter: () => void;
  toggleTaskCenter: () => void;
  runTask: (name: string) => Promise<void>;
  markRunning: (name: string) => void;
  markExited: () => void;
}

/** Create the dedicated task terminal when it is not open anymore. */
function ensureTaskTerminal(): number {
  const { taskTerminalId } = useTaskStore.getState();
  const store = useTerminalStore.getState();
  const exists =
    taskTerminalId != null && store.terminals.some((t) => t.id === taskTerminalId);
  if (exists) return taskTerminalId!;
  const id = store.create("task");
  useTaskStore.setState({ taskTerminalId: id });
  return id;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  tasksError: null,
  loading: false,
  taskCenterOpen: false,
  taskTerminalId: null,
  taskStatus: "idle",
  activeTaskName: null,
  pendingTask: null,
  taskRunSeq: 0,

  refresh: async () => {
    set({ loading: true });
    try {
      const tasks = await loadWorkspaceTasks();
      set({ tasks: tasks ?? [], tasksError: null, loading: false });
    } catch (e) {
      set({ tasks: [], tasksError: String(e), loading: false });
    }
  },

  reset: () => {
    set({
      tasks: [],
      tasksError: null,
      loading: false,
      taskCenterOpen: false,
      taskTerminalId: null,
      taskStatus: "idle",
      activeTaskName: null,
      pendingTask: null,
    });
  },

  openTaskCenter: () => {
    set({ taskCenterOpen: true });
    void get().refresh();
  },

  closeTaskCenter: () => set({ taskCenterOpen: false }),

  toggleTaskCenter: () => {
    if (get().taskCenterOpen) {
      set({ taskCenterOpen: false });
    } else {
      get().openTaskCenter();
    }
  },

  runTask: async (name: string) => {
    const current = get();
    const task = current.tasks.find((t) => t.name === name);
    if (!task) return;
    set({ taskCenterOpen: false });

    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath) {
      useUiStore.getState().showToast("当前没有打开的工作区", "error");
      return;
    }
    const filePath = useEditorStore.getState().activePath;
    if (needsActiveFile(task.command) && !filePath) {
      useUiStore.getState().showToast("当前任务需要打开文件", "error");
      return;
    }
    const command = resolveTaskCommand(task.command, workspacePath, filePath);

    ensureTaskTerminal();
    set((s) => ({
      pendingTask: { name, command },
      taskRunSeq: s.taskRunSeq + 1,
    }));
  },

  markRunning: (name: string) => {
    set({ taskStatus: "running", activeTaskName: name, pendingTask: null });
  },

  markExited: () => {
    set({ taskStatus: "exited" });
  },
}));