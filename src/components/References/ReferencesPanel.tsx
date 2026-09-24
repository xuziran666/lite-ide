import { useMemo } from "react";
import { useSearchStore } from "../../stores/searchStore";
import { openAndReveal } from "../../utils/reveal";

/**
 * Find References results shown in the secondary sidebar. Grouped by file,
 * each row jumps to the location via `openAndReveal`. The data comes from
 * `textDocument/references` (see `lsp/client.ts`).
 */
function ReferencesPanel() {
  const open = useSearchStore((s) => s.rightSidebarOpen);
  const tab = useSearchStore((s) => s.rightSidebarTab);
  const loading = useSearchStore((s) => s.referencesLoading);
  const symbol = useSearchStore((s) => s.referencesSymbol);
  const references = useSearchStore((s) => s.references);

  const active = open && tab === "references";

  const groups = useMemo(() => {
    if (!references) return [];
    const map = new Map<string, typeof references>();
    for (const item of references) {
      const list = map.get(item.path);
      if (list) list.push(item);
      else map.set(item.path, [item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [references]);

  if (!active) return null;

  let body: React.ReactNode;
  if (loading) {
    body = <p className="search-empty">查找引用中…</p>;
  } else if (references === null) {
    body = (
      <p className="search-empty">
        将光标置于符号上并按 Shift+F12 查找引用
      </p>
    );
  } else if (references.length === 0) {
    body = <p className="search-empty">No references available</p>;
  } else {
    body = groups.map(([path, items]) => (
      <div className="search-group" key={path}>
        <div className="search-group-header">
          <span className="search-group-path">{path}</span>
          <span className="search-group-count">{items.length}</span>
        </div>
        {items.map((item, idx) => (
          <button
            type="button"
            className="search-match-row"
            key={`${item.path}:${item.line}:${item.column}:${idx}`}
            onClick={() => openAndReveal(item.path, item.line, item.column)}
          >
            <span className="search-match-loc">
              {item.line}:{item.column}
            </span>
            <span className="search-match-text">
              {item.preview || "(引用)"}
            </span>
          </button>
        ))}
      </div>
    ));
  }

  return (
    <div className="panel references-panel">
      {symbol && (
        <div className="references-symbol" title={symbol}>
          “{symbol}” 的引用
        </div>
      )}
      <div className="search-results">{body}</div>
    </div>
  );
}

export default ReferencesPanel;
