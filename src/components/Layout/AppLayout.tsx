import FileTree from "../FileTree/FileTree";
import Tabs from "../Editor/Tabs";
import Editor from "../Editor/Editor";
import TerminalPlaceholder from "../Terminal/TerminalPlaceholder";

function AppLayout() {
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