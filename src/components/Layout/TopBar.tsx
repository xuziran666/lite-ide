import { useWorkspaceStore } from "../../stores/workspaceStore";

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function TopBar() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  return (
    <header className="top-bar">
      <span className="top-bar-brand">lite-ide</span>
      {workspacePath && (
        <span className="top-bar-workspace" title={workspacePath}>
          {workspaceName(workspacePath)}
        </span>
      )}
      <span className="top-bar-spacer" />
      {/* Reserved slot for the Task Center; not implemented yet. */}
      <span className="top-bar-task-center" />
    </header>
  );
}

export default TopBar;