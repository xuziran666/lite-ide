import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import FileTree from "../FileTree/FileTree";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import TerminalPane from "../Terminal/Terminal";
import Splitter from "../Splitter";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";

const MIN_TREE_WIDTH = 180;
const MAX_TREE_WIDTH = 500;
const MIN_TERMINAL_HEIGHT = 120;
const FILE_TREE_RAIL_WIDTH = 36;
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

function AppLayout() {
  const [fileTreeWidth, setFileTreeWidth] = useState(() =>
    clamp(DEFAULT_TREE_WIDTH, MIN_TREE_WIDTH, MAX_TREE_WIDTH),
  );
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clamp(DEFAULT_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, terminalMaxHeight()),
  );
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);

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

  useEffect(() => {
    const onResize = () => {
      setFileTreeWidth((w) => clamp(w, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
      setTerminalHeight((h) => clamp(h, MIN_TERMINAL_HEIGHT, terminalMaxHeight()));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleFileTreeDrag = useCallback((delta: number) => {
    setFileTreeWidth((w) => clamp(w + delta, MIN_TREE_WIDTH, MAX_TREE_WIDTH));
  }, []);

  const handleTerminalDrag = useCallback((delta: number) => {
    setTerminalHeight((h) => clamp(h + delta, MIN_TERMINAL_HEIGHT, terminalMaxHeight()));
  }, []);

  const collapseFileTree = useCallback(() => setFileTreeCollapsed(true), []);
  const expandFileTree = useCallback(() => setFileTreeCollapsed(false), []);
  const collapseTerminal = useCallback(() => setTerminalCollapsed(true), []);
  const expandTerminal = useCallback(() => setTerminalCollapsed(false), []);

  return (
    <div className="app-layout">
      <div
        className={fileTreeCollapsed ? "file-tree-rail" : "file-tree-wrap"}
        style={{
          width: fileTreeCollapsed ? FILE_TREE_RAIL_WIDTH : fileTreeWidth,
        }}
      >
        {fileTreeCollapsed ? (
          <button
            type="button"
            className="rail-expand-btn"
            title="展开文件树"
            onClick={expandFileTree}
          >
            »
          </button>
        ) : (
          <FileTree onCollapse={collapseFileTree} />
        )}
      </div>
      {!fileTreeCollapsed && (
        <Splitter orientation="vertical" onDrag={handleFileTreeDrag} />
      )}
      <div className="main-area">
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
      </div>
    </div>
  );
}

export default AppLayout;