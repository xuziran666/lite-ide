import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "../FileTree/FileTree";
import SourceControlPanel from "../SourceControl/SourceControlPanel";
import TasksPanel from "../Tasks/TasksPanel";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import DiffView from "../DiffView/DiffView";
import TerminalPane from "../Terminal/Terminal";
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
import { useTerminalStore } from "../../stores/terminalStore";
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
} from "../../config/keybindings";
import { cancelAutoSave } from "../../utils/autoSave";

const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 400;
const MIN_TERMINAL_HEIGHT = 120;
const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 500;
const DEFAULT_TREE_WIDTH = 220;
const DEFAULT_TERMINAL_HEIGHT = 200;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 300;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
  const diffOpen = useDiffStore((s) => s.diff !== null);
  const taskRunSeq = useTaskStore((s) => s.taskRunSeq);
  const taskCenterOpen = useTaskStore((s) => s.taskCenterOpen);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const rightSidebarOpen = useSearchStore((s) => s.rightSidebarOpen);
  const activePrimarySidebar = useSearchStore((s) => s.activePrimarySidebar);

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
    setTerminalCollapsed(false);
    const { taskTerminalId } = useTaskStore.getState();
    if (taskTerminalId != null) useTerminalStore.getState().select(taskTerminalId);
  }, [taskRunSeq]);

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
    setTerminalHeight((h) => clamp(h - delta, MIN_TERMINAL_HEIGHT, terminalMaxHeight()));
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
                  </div>
                  <Splitter orientation="vertical" onDrag={handleFileTreeDrag} />
                </>
              )}
              <div
                className={
                  activePrimarySidebar === null
                    ? "main-area file-tree-collapsed"
                    : "main-area"
                }
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
                <Tabs />
                <div className="editor-stack">
                  <Editor />
                  {diffOpen && <DiffView />}
                </div>
              </div>
            </div>
            {/* Settings overlays the editor while the workbench stays mounted
                so Monaco models, tabs and the file tree keep their state. */}
            {settingsOpen && <SettingsView />}
          {!terminalCollapsed && (
            <Splitter orientation="horizontal" onDrag={handleTerminalDrag} />
          )}
          <div
            className={terminalCollapsed ? "terminal-wrap collapsed" : "terminal-wrap"}
            style={{ height: terminalCollapsed ? 0 : terminalHeight }}
          >
            <TerminalPane onCollapse={collapseTerminal} />
          </div>
          {terminalCollapsed && (
            <button
              type="button"
              className="terminal-reopen-bar"
              onClick={expandTerminal}
            >
              ▲ 展开终端
            </button>
          )}
        </div>
        {rightSidebarOpen && (
          <>
            <Splitter orientation="vertical" onDrag={handleRightSidebarDrag} />
            <div className="right-sidebar-wrap" style={{ width: rightSidebarWidth }}>
              <div className="right-sidebar">
                <RightSidebar />
              </div>
            </div>
          </>
        )}
      </div>
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