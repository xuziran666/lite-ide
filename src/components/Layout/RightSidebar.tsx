import type { ReactNode } from "react";
import { useSearchStore } from "../../stores/searchStore";
import GlobalSearch from "../Search/GlobalSearch";
import ReferencesPanel from "../References/ReferencesPanel";
import OutlinePanel from "../Outline/OutlinePanel";
import ProblemsPanel from "../Problems/ProblemsPanel";

const TABS = [
  { key: "search", label: "搜索" },
  { key: "references", label: "引用" },
  { key: "outline", label: "大纲" },
  { key: "problems", label: "问题" },
  { key: "terminal", label: "终端" },
] as const;

function RightSidebar({ terminalPane }: { terminalPane: ReactNode }) {
  const open = useSearchStore((s) => s.rightSidebarOpen);
  const tab = useSearchStore((s) => s.rightSidebarTab);
  const select = useSearchStore((s) => s.openRightSidebar);

  if (!open) return null;

  return (
    <div className="right-sidebar-content">
      <div className="right-sidebar-tabs">
        {TABS.map(({ key, label }) => (
          <button
            type="button"
            key={key}
            className={tab === key ? "right-sidebar-tab active" : "right-sidebar-tab"}
            onClick={() => select(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="right-sidebar-panels" data-terminal-surface="right">
        {tab === "search" && <GlobalSearch />}
        {tab === "references" && <ReferencesPanel />}
        {tab === "outline" && <OutlinePanel />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "terminal" && terminalPane}
      </div>
    </div>
  );
}

export default RightSidebar;