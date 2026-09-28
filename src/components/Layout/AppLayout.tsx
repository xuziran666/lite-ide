import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "../FileTree/FileTree";
import SourceControlPanel from "../SourceControl/SourceControlPanel";
import TasksPanel from "../Tasks/TasksPanel";
import DebugPanel from "../Debug/DebugPanel";
import DebugFloatToolbar from "../Debug/DebugFloatToolbar";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import DiffView from "../DiffView/DiffView";
import TerminalPane, {
  TerminalSessionLayer,
  type TerminalInstanceRegistry,
  type TerminalPanelBounds,
} from "../Terminal/Terminal";
import TopBar from "./TopBar";
import ActivityBar from "./ActivityBar";
import StatusBar from "./StatusBar";
import CloseConfirmDialog from "./CloseConfirmDialog";
import Splitter from "../Splitter";
import TaskCenter from "../Tasks/TaskCenter";
import SettingsView from "../Settings/SettingsView";
import ToastStack from "../Toast/ToastStack";
import RightSidebar from "./RightSidebar";
import QuickOpen from "../Search/QuickOpen";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  useTerminalStore,
  DEBUG_TERMINAL_ID,
  type TerminalDock,
} from "../../stores/terminalStore";
import { useTaskStore } from "../../stores/taskStore";
import { useSearchStore } from "../../stores/searchStore";
import { useConfigStore } from "../../stores/configStore";
import { useGitStore } from "../../stores/gitStore";
import { useDiffStore } from "../../stores/diffStore";
import {
  editorHasTextFocus,
  findReferencesAtCursor,
  runCodeActionAction,
  runDeleteLineAction,
  runFormatDocumentAction,
  runRenameAction,
  runSignatureHelpAction,
} from "../../lsp/client";
import {
  isDoubleCtrlChord,
  parseChord,
  chordMatches,
  type KeybindingAction,
  type KeybindingMap,
} from "../../config/keybindings";
import {
  startOrContinue,
  stepInto,
  stepOut,
  stepOver,
  stopSession,
} from "../../debug/session";
import { cancelAutoSave } from "../../utils/autoSave";

const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 400;
const MIN_TERMINAL_HEIGHT = 120;
const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 500;
const DEFAULT_TREE_WIDTH = 220;
const DEFAULT_TERMINAL_HEIGHT = 200;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 300;
const TERMINAL_DRAG_MIME = "application/x-lite-ide-terminal";

function isTerminalDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(TERMINAL_DRAG_MIME);
}

function terminalIdFromTransfer(dataTransfer: DataTransfer): number | null {
  const id = Number(dataTransfer.getData(TERMINAL_DRAG_MIME));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Dispatch a debug shortcut, returning true when the event was consumed.
 *
 * These five actions are matched here, ahead of the Ctrl/Meta-gated handler,
 * because their defaults are bare function keys. They never claim the keyboard
 * while a text input has focus, so typing "F5" into a config field is still
 * typing — and a user who rebinds one of them to a chord keeps working exactly
 * the same way, because the user's binding is what is matched.
 */
function runDebugKeybinding(
  e: KeyboardEvent,
  keybindings: KeybindingMap,
): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const match = (action: KeybindingAction) =>
    chordMatches(parseChord(keybindings[action]), e);
  const inTextInput = isTextInputFocused();

  if (match("debugStartContinue")) {
    e.preventDefault();
    void startOrContinue();
    return true;
  }
  if (match("debugStepOver")) {
    e.preventDefault();
    void stepOver();
    return true;
  }
  if (match("debugStepInto")) {
    e.preventDefault();
    void stepInto();
    return true;
  }
  if (match("debugStepOut")) {
    e.preventDefault();
    void stepOut();
    return true;
  }
  if (match("debugStop")) {
    if (inTextInput) return false;
    e.preventDefault();
    void stopSession();
    return true;
  }
  return false;
}

function terminalMaxHeight(): number {
  const windowHeight = window.innerHeight;
  const byRatio = Math.round(windowHeight * 0.7);
  const keepEditor = windowHeight - 160;
  return Math.max(MIN_TERMINAL_HEIGHT, Math.min(byRatio, keepEditor));
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// IDE-level shortcuts must not steal keys while the user types in the terminal
// or in a plain text input. The Monaco editor qualifies as editor input, so a
// textarea inside it (its hidden IME element) does not block shortcuts.
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const node = el as HTMLElement;
  if (node.closest?.(".terminal-host")) return true;
  const tag = el.tagName;
  if (
    (tag === "INPUT" || tag === "TEXTAREA") &&
    !node.closest?.(".monaco-editor")
  ) {
    return true;
  }
  return node.isContentEditable;
}

function AppLayout() {
  const [fileTreeWidth, setFileTreeWidth] = useState(() =>
    clamp(DEFAULT_TREE_WIDTH, MIN_TREE_WIDTH, MAX_TREE_WIDTH),
  );
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clamp(DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, terminalMaxHeight()),
  );
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
  const [activeEditorSurface, setActiveEditorSurface] = useState<"file" | "terminal">(
    "file",
  );
  const [terminalBoundsByDock, setTerminalBoundsByDock] = useState<
    Record<TerminalDock, TerminalPanelBounds | null>
  >({ bottom: null, editor: null, right: null });
  const [draggedTerminalId, setDraggedTerminalId] = useState<number | null>(null);
  const [terminalDropTarget, setTerminalDropTarget] = useState<
    "bottom" | "editor" | "right" | null
  >(null);
  const terminalInstances = useRef<TerminalInstanceRegistry["current"]>(new Map());
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() =>
    clamp(
      DEFAULT_RIGHT_SIDEBAR_WIDTH,
      MIN_RIGHT_SIDEBAR_WIDTH,
      MAX_RIGHT_SIDEBAR_WIDTH,
    ),
  );
  const [closingDirtyNames, setClosingDirtyNames] = useState<string[] | null>(null);
  const [savingAll, setSavingAll] = useState(false);

  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activePath = useEditorStore((s) => s.activePath);
  const terminals = useTerminalStore((s) => s.terminals);
  const activeIdByDock = useTerminalStore((s) => s.activeIdByDock);
  const diffOpen = useDiffStore((s) => s.diff !== null);
  const taskRunSeq = useTaskStore((s) => s.taskRunSeq);
  const taskCenterOpen = useTaskStore((s) => s.taskCenterOpen);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const rightSidebarOpen = useSearchStore((s) => s.rightSidebarOpen);
  const rightSidebarTab = useSearchStore((s) => s.rightSidebarTab);
  const activePrimarySidebar = useSearchStore((s) => s.activePrimarySidebar);

  const editorTerminals = terminals.filter((terminal) => terminal.dock === "editor");
  const bottomTerminalVisible = !terminalCollapsed && !settingsOpen;
  const editorTerminalVisible =
    !settingsOpen && activeEditorSurface === "terminal" && editorTerminals.length > 0;
  const rightTerminalVisible = rightSidebarOpen && rightSidebarTab === "terminal";
  const terminalVisible = bottomTerminalVisible && !settingsOpen;
  const visibleByDock: Record<TerminalDock, boolean> = {
    bottom: bottomTerminalVisible,
    editor: editorTerminalVisible,
    right: rightTerminalVisible,
  };

  useEffect(() => {
    if (activePath) setActiveEditorSurface("file");
  }, [activePath]);

  useEffect(() => {
    if (editorTerminals.length === 0) setActiveEditorSurface("file");
  }, [editorTerminals.length]);

  useLayoutEffect(() => {
    const targets: Record<TerminalDock, HTMLElement | null> = {
      bottom: document.querySelector('[data-terminal-dock="bottom"]'),
      editor: document.querySelector('[data-terminal-dock="editor"]'),
      right: document.querySelector('[data-terminal-dock="right"]'),
    };
    const updateBounds = () => {
      setTerminalBoundsByDock((previous) => {
        const next = { ...previous };
        for (const dock of ["bottom", "editor", "right"] as const) {
          const target = targets[dock];
          if (!target || !visibleByDock[dock]) {
            next[dock] = null;
            continue;
          }
          const rect = target.getBoundingClientRect();
          next[dock] = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        }
        if (
          (Object.keys(next) as TerminalDock[]).every((dock) => {
            const before = previous[dock];
            const after = next[dock];
            return (
              before === after ||
              (before !== null &&
                after !== null &&
                before.left === after.left &&
                before.top === after.top &&
                before.width === after.width &&
                before.height === after.height) ||
              (before === null && after === null)
            );
          })
        ) {
          return previous;
        }
        return next;
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    for (const target of Object.values(targets)) {
      if (target) observer.observe(target);
    }
    window.addEventListener("resize", updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [
    bottomTerminalVisible,
    editorTerminalVisible,
    rightTerminalVisible,
    rightSidebarOpen,
    rightSidebarTab,
    activeEditorSurface,
    terminals,
  ]);

  // File system events drive both the tree refresh and the editor handling of
  // files that changed outside the app.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<string[]>("file-system-changed", (event) => {
      const paths = Array.isArray(event.payload) ? event.payload : [];
      if (paths.length === 0) return;
      void useFileTreeStore.getState().onFileSystemChanged(paths);
      void useEditorStore.getState().onExternalChange(paths);
      useGitStore.getState().scheduleRefresh();
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Ask before a window close that would drop unsaved edits, unless the user
  // turned "Confirm Before Close" off in Settings.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // A pending Auto Save timer must not fire while the close flow runs.
        cancelAutoSave();
        if (!useConfigStore.getState().general.confirmBeforeClose) return;
        const dirty = useEditorStore
          .getState()
          .openFiles.filter((tab) => tab.dirty);
        if (dirty.length === 0) return;
        event.preventDefault();
        setClosingDirtyNames(dirty.map((tab) => tab.name));
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!workspacePath) return;
    void getCurrentWindow()
      .setTitle(`${workspaceName(workspacePath)} - lite-ide`)
      .catch(() => undefined);
  }, [workspacePath]);

  // The terminal starts collapsed for every workspace; expanding it the first
  // time creates Terminal 1 (no pty is ever spawned while the panel is hidden).
  useEffect(() => {
    const store = useTerminalStore.getState();
    if (!terminalCollapsed && store.terminals.length === 0) {
      store.create();
    }
  }, [terminalCollapsed]);

  // Entering a workspace folds the panel again. The backend kills every pty on
  // `set_workspace` and the store was already reset, so nothing leaks.
  useEffect(() => {
    if (!workspacePath) return;
    setTerminalCollapsed(true);
  }, [workspacePath]);

  // Tasks are global: reset only the task run-time state on a workspace change
  // (the task terminal is killed when switching), keep the task list as-is.
  useEffect(() => {
    useTaskStore.getState().reset();
  }, [workspacePath]);

  // Load the global task list once at startup.
  useEffect(() => {
    void useTaskStore.getState().refresh();
  }, []);

  // A task run always reveals the terminal panel and focuses the task terminal.
  useEffect(() => {
    if (taskRunSeq === 0) return;
    const { taskTerminalId } = useTaskStore.getState();
    if (taskTerminalId == null) return;
    const terminal = useTerminalStore
      .getState()
      .terminals.find((item) => item.id === taskTerminalId);
    if (!terminal) return;
    useTerminalStore.getState().select(taskTerminalId);
    if (terminal.dock === "bottom") setTerminalCollapsed(false);
    if (terminal.dock === "editor") setActiveEditorSurface("terminal");
    if (terminal.dock === "right") {
      useSearchStore.getState().openRightSidebar("terminal");
    }
  }, [taskRunSeq]);

  // Starting a debug session reveals the terminal panel and focuses the Debug
  // Terminal, exactly like a task run.
  const debugTerminalRevealSeq = useTerminalStore((s) => s.revealSeq);
  useEffect(() => {
    if (debugTerminalRevealSeq === 0) return;
    const terminal = useTerminalStore
      .getState()
      .terminals.find((item) => item.id === DEBUG_TERMINAL_ID);
    if (!terminal) return;
    useTerminalStore.getState().select(DEBUG_TERMINAL_ID);
    if (terminal.dock === "bottom") setTerminalCollapsed(false);
    if (terminal.dock === "editor") setActiveEditorSurface("terminal");
    if (terminal.dock === "right") {
      useSearchStore.getState().openRightSidebar("terminal");
    }
  }, [debugTerminalRevealSeq]);

  // Keep the tree in sync with the file that owns the active tab.
  useEffect(() => {
    if (!activePath) return;
    void useFileTreeStore.getState().revealPath(activePath);
  }, [activePath]);

  useEffect(() => {
    const onResize = () => {
      setFileTreeWidth((w) => clamp(w, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
      setTerminalHeight((h) => clamp(h, MIN_TERMINAL_HEIGHT, terminalMaxHeight()));
      setRightSidebarWidth((w) =>
        clamp(w, MIN_RIGHT_SIDEBAR_WIDTH, MAX_RIGHT_SIDEBAR_WIDTH),
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let lastCtrlPress = 0;
    const DOUBLE_CTRL_WINDOW = 300;

    const switchTabBy = (step: number, e: KeyboardEvent) => {
      const store = useEditorStore.getState();
      const { openFiles } = store;
      if (openFiles.length < 2) return;
      e.preventDefault();
      const index = openFiles.findIndex((t) => t.path === store.activePath);
      const next = openFiles[(index + step + openFiles.length) % openFiles.length];
      if (next) store.setActive(next.path);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // The Settings page owns the keyboard while it is open (recorder, focus).
      if (useConfigStore.getState().settingsOpen) return;
      if (useTaskStore.getState().taskCenterOpen) return;

      const keybindings = useConfigStore.getState().keybindings;

      // Debug shortcuts are checked before the Ctrl/Meta guard below, because
      // they are allowed to be bare function keys (F5, F10, F11, …). They are
      // the only actions that bypass the modifier requirement — see
      // BARE_FUNCTION_KEY_ACTIONS in config/keybindings.ts.
      if (runDebugKeybinding(e, keybindings)) return;

      const taskChord = keybindings.openTaskCenter;

      // The default Task Center chord is the special double-Ctrl: two quick
      // Ctrl presses. It is guarded so plain inputs never pop the picker.
      if (isDoubleCtrlChord(taskChord)) {
        if (e.key === "Control") {
          if (e.repeat) return;
          if (isTextInputFocused()) return;
          const now = performance.now();
          if (now - lastCtrlPress <= DOUBLE_CTRL_WINDOW) {
            lastCtrlPress = 0;
            useTaskStore.getState().toggleTaskCenter();
          } else {
            lastCtrlPress = now;
          }
          return;
        }
        // Anything else invalidates a pending single Ctrl.
        lastCtrlPress = 0;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;

      const match = (action: KeybindingAction) =>
        chordMatches(parseChord(keybindings[action]), e);

      if (match("toggleExplorer")) {
        e.preventDefault();
        // Toggle the primary sidebar; the Activity Bar stays visible.
        useSearchStore.getState().selectPrimarySidebar("explorer");
        return;
      }
      if (match("toggleTerminal")) {
        e.preventDefault();
        setTerminalCollapsed((value) => !value);
        return;
      }
      if (match("newTerminal")) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        setTerminalCollapsed(false);
        useTerminalStore.getState().create();
        return;
      }
      if (match("closeEditorTab")) {
        const store = useEditorStore.getState();
        if (!store.activePath) return;
        e.preventDefault();
        store.requestCloseTab(store.activePath);
        return;
      }
      if (match("restoreClosedTab")) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        void useEditorStore.getState().restoreClosedTab();
        return;
      }
      if (match("openTaskCenter")) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        useTaskStore.getState().toggleTaskCenter();
        return;
      }
      if (match("nextEditorTab")) {
        switchTabBy(1, e);
        return;
      }
      if (match("previousEditorTab")) {
        switchTabBy(-1, e);
        return;
      }
      if (match("quickOpen")) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        useSearchStore.getState().openQuickOpen();
        return;
      }
      if (match("globalSearch")) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        useSearchStore.getState().openRightSidebar("search");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Editor-scoped LSP shortcuts (Rename / Find References / Code Actions /
  // Format). Monaco already binds some of these keys itself, so intercept them
  // in the capture phase *before* Monaco sees them and route through the user's
  // configured chord (see config/keybindings.ts), only while the editor is
  // focused.
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (useConfigStore.getState().settingsOpen) return;
      if (useTaskStore.getState().taskCenterOpen) return;
      if (!editorHasTextFocus()) return;

      const keybindings = useConfigStore.getState().keybindings;
      const match = (action: KeybindingAction) =>
        chordMatches(parseChord(keybindings[action]), e);

      if (match("renameSymbol")) {
        e.preventDefault();
        e.stopPropagation();
        runRenameAction();
        return;
      }
      if (match("findReferences")) {
        e.preventDefault();
        e.stopPropagation();
        void findReferencesAtCursor();
        return;
      }
      if (match("codeActions")) {
        e.preventDefault();
        e.stopPropagation();
        runCodeActionAction();
        return;
      }
      if (match("formatDocument")) {
        e.preventDefault();
        e.stopPropagation();
        runFormatDocumentAction();
        return;
      }
      if (match("signatureHelp")) {
        e.preventDefault();
        e.stopPropagation();
        runSignatureHelpAction();
        return;
      }
      if (match("deleteLine")) {
        e.preventDefault();
        e.stopPropagation();
        runDeleteLineAction();
      }
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () =>
      window.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);

  const handleFileTreeDrag = useCallback((delta: number) => {
    setFileTreeWidth((w) => clamp(w + delta, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
  }, []);

  const handleTerminalDrag = useCallback((delta: number) => {
    setTerminalHeight((h) =>
      clamp(h - delta, MIN_TERMINAL_HEIGHT, terminalMaxHeight()),
    );
  }, []);

  // The splitter sits between the center area and the right sidebar; dragging
  // it right narrows the sidebar, so the delta is subtracted.
  const handleRightSidebarDrag = useCallback((delta: number) => {
    setRightSidebarWidth((w) =>
      clamp(w - delta, MIN_RIGHT_SIDEBAR_WIDTH, MAX_RIGHT_SIDEBAR_WIDTH),
    );
  }, []);

  const collapseExplorer = useCallback(() => {
    useSearchStore.getState().selectPrimarySidebar("explorer");
  }, []);
  const expandExplorer = useCallback(() => {
    useSearchStore.getState().selectPrimarySidebar("explorer");
  }, []);
  const collapseTerminal = useCallback(() => setTerminalCollapsed(true), []);
  const expandTerminal = useCallback(() => setTerminalCollapsed(false), []);
  const selectTerminal = useCallback((id: number) => {
    const terminal = useTerminalStore
      .getState()
      .terminals.find((item) => item.id === id);
    if (!terminal) return;
    useTerminalStore.getState().select(id);
    if (terminal.dock === "bottom") setTerminalCollapsed(false);
    if (terminal.dock === "editor") setActiveEditorSurface("terminal");
    if (terminal.dock === "right") {
      useSearchStore.getState().openRightSidebar("terminal");
    }
  }, []);
  const createTerminal = useCallback((dock: TerminalDock) => {
    useTerminalStore.getState().create("normal", dock);
    if (dock === "bottom") setTerminalCollapsed(false);
    if (dock === "editor") setActiveEditorSurface("terminal");
    if (dock === "right") {
      useSearchStore.getState().openRightSidebar("terminal");
    }
  }, []);
  const handleTerminalDragStart = useCallback((id: number) => {
    setDraggedTerminalId(id);
  }, []);
  const handleTerminalDragEnd = useCallback(() => {
    setDraggedTerminalId(null);
    setTerminalDropTarget(null);
  }, []);
  const handleTerminalDrop = useCallback(
    (id: number, dock: TerminalDock) => {
      const source = useTerminalStore
        .getState()
        .terminals.find((terminal) => terminal.id === id)?.dock;
      if (!source) return;
      useTerminalStore.getState().move(id, dock);
      if (dock === "bottom") setTerminalCollapsed(false);
      if (dock === "editor") setActiveEditorSurface("terminal");
      if (dock === "right") {
        useSearchStore.getState().openRightSidebar("terminal");
      }
      if (
        source === "bottom" &&
        dock !== "bottom" &&
        !useTerminalStore
          .getState()
          .terminals.some((terminal) => terminal.dock === "bottom")
      ) {
        setTerminalCollapsed(true);
      }
      setDraggedTerminalId(null);
      setTerminalDropTarget(null);
    },
    [],
  );
  const toggleTerminal = useCallback(
    () => setTerminalCollapsed((collapsed) => !collapsed),
    [],
  );
  const togglePrimarySidebar = useCallback(
    () => useSearchStore.getState().togglePrimarySidebar(),
    [],
  );
  const toggleRightSidebar = useCallback(
    () => useSearchStore.getState().toggleRightSidebar(),
    [],
  );

  const saveAllAndClose = useCallback(async () => {
    setSavingAll(true);
    const ok = await useEditorStore.getState().saveAll();
    setSavingAll(false);
    if (!ok) return;
    await getCurrentWindow().destroy();
  }, []);

  const discardAndClose = useCallback(() => {
    void getCurrentWindow().destroy();
  }, []);

  return (
    <div className="app-layout">
      <TopBar
          primarySidebarVisible={activePrimarySidebar !== null}
          onTogglePrimarySidebar={togglePrimarySidebar}
          terminalVisible={terminalVisible}
          onToggleTerminal={toggleTerminal}
          secondarySidebarVisible={rightSidebarOpen}
          onToggleSecondarySidebar={toggleRightSidebar}
        />
      <div className="app-body">
          <ActivityBar />
          <div
            className={settingsOpen ? "app-center settings-mode" : "app-center"}
          >
            <div className="workbench">
              {activePrimarySidebar !== null && (
                <>
                  <div className="file-tree-wrap" style={{ width: fileTreeWidth }}>
                    <div
                      className={
                        activePrimarySidebar === "explorer"
                          ? "primary-sidebar-view"
                          : "primary-sidebar-view hidden"
                      }
                    >
                      <FileTree onCollapse={collapseExplorer} />
                    </div>
                    <div
                      className={
                        activePrimarySidebar === "sourceControl"
                          ? "primary-sidebar-view"
                          : "primary-sidebar-view hidden"
                      }
                    >
                      <SourceControlPanel />
                    </div>
                    <div
                      className={
                        activePrimarySidebar === "tasks"
                          ? "primary-sidebar-view"
                          : "primary-sidebar-view hidden"
                      }
                    >
                      <TasksPanel />
                    </div>
                    <div
                      className={
                        activePrimarySidebar === "debug"
                          ? "primary-sidebar-view"
                          : "primary-sidebar-view hidden"
                      }
                    >
                      <DebugPanel />
                    </div>
                  </div>
                  <Splitter orientation="vertical" onDrag={handleFileTreeDrag} />
                </>
              )}
              <div
                className={
                  [
                    "main-area",
                    activePrimarySidebar === null ? "file-tree-collapsed" : "",
                    draggedTerminalId !== null && terminalDropTarget === "editor"
                      ? "terminal-drop-hover"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                }
                onDragOver={(event) => {
                  if (!isTerminalDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setTerminalDropTarget("editor");
                }}
                onDragLeave={() =>
                  setTerminalDropTarget((target) =>
                    target === "editor" ? null : target,
                  )
                }
                onDrop={(event) => {
                  if (!isTerminalDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  const id = terminalIdFromTransfer(event.dataTransfer);
                  if (id !== null) handleTerminalDrop(id, "editor");
                }}
              >
                {activePrimarySidebar === null && (
                  <button
                    type="button"
                    className="rail-expand-btn floating"
                    title="展开资源管理器"
                    onClick={expandExplorer}
                  >
                    »
                  </button>
                )}
                <Tabs
                  terminals={editorTerminals}
                  activeTerminalId={activeIdByDock.editor}
                  onSelectTerminal={selectTerminal}
                  onCloseTerminal={(id) => useTerminalStore.getState().close(id)}
                  onCreateTerminal={() => createTerminal("editor")}
                  onTerminalDragStart={handleTerminalDragStart}
                  onTerminalDragEnd={handleTerminalDragEnd}
                  onSelectFile={() => setActiveEditorSurface("file")}
                />
                <div
                  className="editor-stack"
                >
                  <Editor />
                  {diffOpen && <DiffView />}
                  {/* Absolute overlay: does not take part in the editor's layout. */}
                  <DebugFloatToolbar />
                  {activeEditorSurface === "terminal" && editorTerminals.length > 0 && (
                    <div className="editor-terminal-surface">
                      <TerminalPane
                        dock="editor"
                        instances={terminalInstances}
                        showTabs={false}
                        onDragStart={handleTerminalDragStart}
                        onDragEnd={handleTerminalDragEnd}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
            {/* Settings overlays the editor while the workbench stays mounted
                so Monaco models, tabs and the file tree keep their state. */}
            {settingsOpen && <SettingsView />}
            {!terminalCollapsed ? (
              <>
                <Splitter orientation="horizontal" onDrag={handleTerminalDrag} />
                <div
                  className="terminal-wrap"
                  style={{ height: terminalHeight }}
                >
                  <TerminalPane
                    dock="bottom"
                    instances={terminalInstances}
                    onCollapse={collapseTerminal}
                    onDragStart={handleTerminalDragStart}
                    onDragEnd={handleTerminalDragEnd}
                  />
                </div>
              </>
            ) : (
              <button
                type="button"
                className="terminal-reopen-bar"
                onClick={expandTerminal}
              >
                ▲ 展开终端
              </button>
            )}
            {draggedTerminalId !== null && (
              <div
                className={
                  terminalDropTarget === "bottom"
                    ? "terminal-drop-target terminal-drop-bottom active"
                    : "terminal-drop-target terminal-drop-bottom"
                }
                onDragOver={(event) => {
                  if (!isTerminalDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setTerminalDropTarget("bottom");
                }}
                onDragLeave={() =>
                  setTerminalDropTarget((target) =>
                    target === "bottom" ? null : target,
                  )
                }
                onDrop={(event) => {
                  if (!isTerminalDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  const id = terminalIdFromTransfer(event.dataTransfer);
                  if (id !== null) handleTerminalDrop(id, "bottom");
                }}
              >
                底部
              </div>
            )}
          </div>
        {rightSidebarOpen && (
          <>
            <Splitter orientation="vertical" onDrag={handleRightSidebarDrag} />
            <div
              className={
                draggedTerminalId !== null && terminalDropTarget === "right"
                  ? "right-sidebar-wrap terminal-drop-hover"
                  : "right-sidebar-wrap"
              }
              style={{ width: rightSidebarWidth }}
              onDragOver={(event) => {
                if (!isTerminalDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setTerminalDropTarget("right");
              }}
              onDragLeave={() =>
                setTerminalDropTarget((target) =>
                  target === "right" ? null : target,
                )
              }
              onDrop={(event) => {
                if (!isTerminalDrag(event.dataTransfer)) return;
                event.preventDefault();
                const id = terminalIdFromTransfer(event.dataTransfer);
                if (id !== null) handleTerminalDrop(id, "right");
              }}
            >
              <div className="right-sidebar">
                <RightSidebar
                  terminalPane={
                    <TerminalPane
                      dock="right"
                      instances={terminalInstances}
                      onDragStart={handleTerminalDragStart}
                      onDragEnd={handleTerminalDragEnd}
                    />
                  }
                />
              </div>
            </div>
          </>
        )}
        {draggedTerminalId !== null && !rightSidebarOpen && (
          <div
            className={
              terminalDropTarget === "right"
                ? "terminal-drop-target terminal-drop-right active"
                : "terminal-drop-target terminal-drop-right"
            }
            onDragOver={(event) => {
              if (!isTerminalDrag(event.dataTransfer)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setTerminalDropTarget("right");
            }}
            onDragLeave={() =>
              setTerminalDropTarget((target) =>
                target === "right" ? null : target,
              )
            }
            onDrop={(event) => {
              if (!isTerminalDrag(event.dataTransfer)) return;
              event.preventDefault();
              const id = terminalIdFromTransfer(event.dataTransfer);
              if (id !== null) handleTerminalDrop(id, "right");
            }}
          >
            右侧
          </div>
        )}
      </div>
      <TerminalSessionLayer
        boundsByDock={terminalBoundsByDock}
        visibleByDock={visibleByDock}
        instances={terminalInstances}
        dragging={draggedTerminalId !== null}
      />
      <StatusBar />

      {taskCenterOpen && <TaskCenter />}
      <QuickOpen />
      <ToastStack />

      {closingDirtyNames && (
        <CloseConfirmDialog
          dirtyFiles={closingDirtyNames}
          saving={savingAll}
          onSaveAll={() => void saveAllAndClose()}
          onDiscard={discardAndClose}
          onCancel={() => setClosingDirtyNames(null)}
        />
      )}
    </div>
  );
}

export default AppLayout;