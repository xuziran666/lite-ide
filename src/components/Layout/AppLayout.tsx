import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileTree from "../FileTree/FileTree";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import TerminalPane from "../Terminal/Terminal";
import StatusBar from "./StatusBar";
import CloseConfirmDialog from "./CloseConfirmDialog";
import Splitter from "../Splitter";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 500;
const MIN_TERMINAL_HEIGHT = 120;
const DEFAULT_TREE_WIDTH = 240;
const DEFAULT_TERMINAL_HEIGHT = 200;

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

function AppLayout() {
  const [fileTreeWidth, setFileTreeWidth] = useState(() =>
    clamp(DEFAULT_TREE_WIDTH, MIN_TREE_WIDTH, MAX_TREE_WIDTH),
  );
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clamp(DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, terminalMaxHeight()),
  );
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
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

  // Keep the tree in sync with the file that owns the active tab.
  useEffect(() => {
    if (!activePath) return;
    void useFileTreeStore.getState().revealPath(activePath);
  }, [activePath]);

  useEffect(() => {
    const onResize = () => {
      setFileTreeWidth((w) => clamp(w, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
      setTerminalHeight((h) => clamp(h, MIN_TERMINAL_HEIGHT, terminalMaxHeight()));
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
        setFileTreeCollapsed((value) => !value);
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

  const collapseFileTree = useCallback(() => setFileTreeCollapsed(true), []);
  const expandFileTree = useCallback(() => setFileTreeCollapsed(false), []);
  const collapseTerminal = useCallback(() => setTerminalCollapsed(true), []);
  const expandTerminal = useCallback(() => setTerminalCollapsed(false), []);

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
      {!fileTreeCollapsed && (
        <>
          <div className="file-tree-wrap" style={{ width: fileTreeWidth }}>
            <FileTree onCollapse={collapseFileTree} />
          </div>
          <Splitter orientation="vertical" onDrag={handleFileTreeDrag} />
        </>
      )}
      <div
        className={fileTreeCollapsed ? "main-area file-tree-collapsed" : "main-area"}
      >
        {fileTreeCollapsed && (
          <button
            type="button"
            className="rail-expand-btn floating"
            title="展开文件树"
            onClick={expandFileTree}
          >
            »
          </button>
        )}
        <Tabs />
        <Editor />
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
        <StatusBar />
      </div>

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