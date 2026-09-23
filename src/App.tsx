import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useConfigStore } from "./stores/configStore";
import AppLayout from "./components/Layout/AppLayout";
import WorkspacePicker from "./components/Layout/WorkspacePicker";
import "./App.css";

function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const init = useWorkspaceStore((s) => s.init);
  const loadConfig = useConfigStore((s) => s.load);

  useEffect(() => {
    const boot = async () => {
      // Config must be loaded before the workspace decision: "Restore Last
      // Workspace" is read from user.json. Runs once on startup.
      await loadConfig();
      if (!useConfigStore.getState().general.restoreLastWorkspace) return;
      void init();
    };
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return workspacePath ? <AppLayout /> : <WorkspacePicker />;
}

export default App;