import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "../FileTree/FileTree";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import TerminalPane from "../Terminal/Terminal";
import TopBar from "./TopBar";
import ActivityBar from "./ActivityBar";
import StatusBar from "./StatusBar";
import CloseConfirmDialog from "./CloseConfirmDialog";
import Splitter from "../Splitter";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";

const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 500;
const MIN_TERMINAL_HEIGHT = 120;
const MIN_RIGHT_SIDEBAR_WIDTH = 200;
const MAX_RIGHT_SIDEBAR_WIDTH = 500;
const DEFAULT_TREE_WIDTH = 240;
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
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(true);
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

  // Never let a window close silently discard unsaved edits.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
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
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();

      if (!e.shiftKey && key === "b") {
        e.preventDefault();
        // Toggle the Explorer panel only; the Activity Bar stays visible.
        setExplorerCollapsed((value) => !value);
        return;
      }
      if (e.code === "Backquote" && e.shiftKey) {
        if (isTextInputFocused()) return;
        e.preventDefault();
        setTerminalCollapsed(false);
        useTerminalStore.getState().create();
        return;
      }
      if (!e.shiftKey && e.code === "Backquote") {
        e.preventDefault();
        setTerminalCollapsed((value) => !value);
        return;
      }
      if (!e.shiftKey && key === "w") {
        const store = useEditorStore.getState();
        if (!store.activePath) return;
        e.preventDefault();
        store.requestCloseTab(store.activePath);
        return;
      }
      if (e.shiftKey && key === "t") {
        if (isTextInputFocused()) return;
        e.preventDefault();
        void useEditorStore.getState().restoreClosedTab();
        return;
      }
      if (e.key === "Tab") {
        const store = useEditorStore.getState();
        const { openFiles } = store;
        if (openFiles.length < 2) return;
        e.preventDefault();
        const index = openFiles.findIndex((t) => t.path === store.activePath);
        const step = e.shiftKey ? -1 : 1;
        const next =
          openFiles[(index + step + openFiles.length) % openFiles.length];
        if (next) store.setActive(next.path);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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

  const collapseExplorer = useCallback(() => setExplorerCollapsed(true), []);
  const expandExplorer = useCallback(() => setExplorerCollapsed(false), []);
  const toggleExplorer = useCallback(
    () => setExplorerCollapsed((value) => !value),
    [],
  );
  const collapseTerminal = useCallback(() => setTerminalCollapsed(true), []);
  const expandTerminal = useCallback(() => setTerminalCollapsed(false), []);
  const toggleRightSidebar = useCallback(
    () => setRightSidebarCollapsed((value) => !value),
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
        secondarySidebarVisible={!rightSidebarCollapsed}
        onToggleSecondarySidebar={toggleRightSidebar}
      />
      <div className="app-body">
        <ActivityBar
          explorerVisible={!explorerCollapsed}
          onToggleExplorer={toggleExplorer}
        />
        <div className="app-center">
          <div className="workbench">
            {!explorerCollapsed && (
              <>
                <div className="file-tree-wrap" style={{ width: fileTreeWidth }}>
                  <FileTree onCollapse={collapseExplorer} />
                </div>
                <Splitter orientation="vertical" onDrag={handleFileTreeDrag} />
              </>
            )}
            <div
              className={
                explorerCollapsed ? "main-area file-tree-collapsed" : "main-area"
              }
            >
              {explorerCollapsed && (
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
              <Editor />
            </div>
          </div>
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
        {!rightSidebarCollapsed && (
          <>
            <Splitter orientation="vertical" onDrag={handleRightSidebarDrag} />
            <div className="right-sidebar-wrap" style={{ width: rightSidebarWidth }}>
              <div className="right-sidebar" />
            </div>
          </>
        )}
      </div>
      <StatusBar />

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