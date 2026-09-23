import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import FileTree from "../FileTree/FileTree";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import TerminalPlaceholder from "../Terminal/TerminalPlaceholder";
import { useFileTreeStore } from "../../stores/fileTreeStore";
import { useEditorStore } from "../../stores/editorStore";

function AppLayout() {
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

  return (
    <div className="app-layout">
      <FileTree />
      <div className="main-area">
        <Tabs />
        <Editor />
        <TerminalPlaceholder />
      </div>
    </div>
  );
}

export default AppLayout;