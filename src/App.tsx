import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspaceStore";
import AppLayout from "./components/Layout/AppLayout";
import WorkspacePicker from "./components/Layout/WorkspacePicker";
import "./App.css";

function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const init = useWorkspaceStore((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return workspacePath ? <AppLayout /> : <WorkspacePicker />;
}

export default App;