import { useEffect } from "react";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useConfigStore } from "./stores/configStore";
import AppLayout from "./components/Layout/AppLayout";
import WorkspacePicker from "./components/Layout/WorkspacePicker";
import "./App.css";

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

// ---- Phase 13.1 — apply design-theme at runtime (dark/light/system) ---------
// Writes the resolved theme onto <html data-theme> so the App.css token layer
// (Phase 13.1 tokens) and the unified thin scrollbar follow it.  Monaco and
// xterm keep their own internal themes/scrollbars and are NOT touched here.
function resolveTheme(pref: string): "dark" | "light" {
  if (pref === "system") return systemDark.matches ? "dark" : "light";
  return pref === "light" ? "light" : "dark";
}

function applyTheme() {
  const pref = useConfigStore.getState().general.theme;
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = pref;
  void (`data-theme=${resolved}`);
}

function App() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const init = useWorkspaceStore((s) => s.init);
  const loadConfig = useConfigStore((s) => s.load);

  useEffect(() => {
    applyTheme();
    const onChange = () => {
      if (useConfigStore.getState().general.theme === "system") applyTheme();
    };
    systemDark.addEventListener("change", onChange);
    // Only a `general.theme` change re-resolves the UI theme: unrelated config
    // edits (font size, keybindings, shells) must not touch <html data-theme>.
    const unsubscribe = useConfigStore.subscribe((state, prev) => {
      if (state.general.theme !== prev.general.theme) applyTheme();
    });
    return () => {
      systemDark.removeEventListener("change", onChange);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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