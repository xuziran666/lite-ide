import { useEffect, useMemo, useState } from "react";
import * as monaco from "monaco-editor";
import { useSearchStore } from "../../stores/searchStore";
import { pathForModel } from "../../editor/modelStore";
import { openAndReveal } from "../../utils/reveal";

interface ProblemItem {
  path: string;
  severity: monaco.MarkerSeverity;
  message: string;
  line: number;
  column: number;
}

function severityLabel(severity: monaco.MarkerSeverity): string {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return "E";
    case monaco.MarkerSeverity.Warning:
      return "W";
    case monaco.MarkerSeverity.Info:
      return "I";
    default:
      return "H";
  }
}

function readMarkers(): ProblemItem[] {
  const markers = monaco.editor.getModelMarkers({});
  const items: ProblemItem[] = [];
  for (const marker of markers) {
    const model = monaco.editor.getModel(marker.resource);
    const path = model ? pathForModel(model) : undefined;
    if (!path) continue;
    items.push({
      path,
      severity: marker.severity,
      message: marker.message,
      line: marker.startLineNumber,
      column: marker.startColumn,
    });
  }
  items.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      b.severity - a.severity,
  );
  return items;
}

function ProblemsPanel() {
  const open = useSearchStore((s) => s.rightSidebarOpen);
  const tab = useSearchStore((s) => s.rightSidebarTab);
  const [items, setItems] = useState<ProblemItem[]>([]);

  const active = open && tab === "problems";

  useEffect(() => {
    if (!active) return;
    const refresh = () => setItems(readMarkers());
    refresh();
    const sub = monaco.editor.onDidChangeMarkers(refresh);
    return () => sub.dispose();
  }, [active]);

  const groups = useMemo(() => {
    const map = new Map<string, ProblemItem[]>();
    for (const item of items) {
      const list = map.get(item.path);
      if (list) list.push(item);
      else map.set(item.path, [item]);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="panel problems-panel">
      {items.length === 0 ? (
        <p className="search-empty">无问题</p>
      ) : (
        groups.map(([path, group]) => (
          <div className="search-group" key={path}>
            <div className="search-group-header">
              <span className="search-group-path">{path}</span>
              <span className="search-group-count">{group.length}</span>
            </div>
            {group.map((item, idx) => (
              <button
                type="button"
                className="search-match-row problem-row"
                key={`${item.path}:${item.line}:${item.column}:${idx}`}
                onClick={() => openAndReveal(item.path, item.line, item.column)}
              >
                <span className="problem-severity">
                  {severityLabel(item.severity)}
                </span>
                <span className="problem-loc">
                  {item.line}:{item.column}
                </span>
                <span className="search-match-text">{item.message}</span>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export default ProblemsPanel;