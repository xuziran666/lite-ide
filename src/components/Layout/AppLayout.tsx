import FileTree from "../FileTree/FileTree";
import EditorPlaceholder from "../Editor/EditorPlaceholder";
import TerminalPlaceholder from "../Terminal/TerminalPlaceholder";

function AppLayout() {
  return (
    <div className="app-layout">
      <FileTree />
      <div className="main-area">
        <EditorPlaceholder />
        <TerminalPlaceholder />
      </div>
    </div>
  );
}

export default AppLayout;