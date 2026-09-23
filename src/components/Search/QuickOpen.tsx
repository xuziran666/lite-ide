import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchStore } from "../../stores/searchStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { openAndReveal } from "../../utils/reveal";

const MAX_RESULTS = 50;

/**
 * Subsequence fuzzy score. Returns -1 when `query` is not a subsequence of
 * `text` (case-insensitive). Higher is better: consecutive hits, word starts
 * and early positions are rewarded.
 */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let qi = 0;
  let streak = 0;
  let wordBoundary = true;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    const ch = t[ti];
    if (ch === q[qi]) {
      qi++;
      if (streak > 0 || wordBoundary) {
        score += 4 + streak;
      }
      streak++;
      score += Math.max(0, 8 - ti * 0.2);
      wordBoundary = false;
    } else {
      streak = 0;
    }
    wordBoundary = ch === "/" || ch === "." || ch === "-" || ch === "_" || ch === " ";
  }
  return qi === q.length ? score : -1;
}

function QuickOpen() {
  const quickOpenOpen = useSearchStore((s) => s.quickOpenOpen);
  const closeQuickOpen = useSearchStore((s) => s.closeQuickOpen);
  const files = useSearchStore((s) => s.files);
  const filesLoaded = useSearchStore((s) => s.filesLoaded);
  const filesError = useSearchStore((s) => s.filesError);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (quickOpenOpen) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [quickOpenOpen]);

  // Close on Escape no matter where focus currently is.
  useEffect(() => {
    if (!quickOpenOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeQuickOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [quickOpenOpen, closeQuickOpen]);

  const results = useMemo(() => {
    const q = query.trim();
    const rows = files.map((path) => {
      const slash = path.lastIndexOf("/");
      const name = slash >= 0 ? path.slice(slash + 1) : path;
      const dir = slash >= 0 ? path.slice(0, slash) : "";
      return { path, name, dir };
    });
    if (q.length === 0) {
      return rows.slice(0, MAX_RESULTS);
    }
    return rows
      .map((row) => {
        const nameScore = fuzzyScore(q, row.name);
        const pathScore = fuzzyScore(q, `${row.dir}/${row.name}`);
        const score = Math.max(nameScore * 3, pathScore);
        return { row, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.row);
  }, [files, query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!quickOpenOpen) return null;

  const open = (path: string) => {
    closeQuickOpen();
    void openAndReveal(path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      const target = results[activeIndex];
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        open(target.path);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeQuickOpen();
    }
  };

  let body: React.ReactNode;
  if (!workspacePath) {
    body = <p className="quick-open-hint">请先打开一个工作区</p>;
  } else if (filesError) {
    body = <p className="quick-open-hint quick-open-error">{filesError}</p>;
  } else if (!filesLoaded) {
    body = <p className="quick-open-hint">加载中…</p>;
  } else if (results.length === 0) {
    body = <p className="quick-open-hint">没有匹配的文件</p>;
  } else {
    body = (
      <div className="quick-open-list" ref={listRef}>
        {results.map((row, index) => (
          <button
            type="button"
            key={row.path}
            data-index={index}
            className={index === activeIndex ? "quick-open-row active" : "quick-open-row"}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => open(row.path)}
          >
            <span className="quick-open-name">{row.name}</span>
            <span className="quick-open-dir">
              {row.dir ? `…/${row.dir}` : "工作区根目录"}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="quick-open-overlay" onMouseDown={(e) => e.stopPropagation()}>
      <div className="quick-open-box">
        <input
          ref={inputRef}
          className="quick-open-input"
          placeholder="输入文件名以快速打开"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="quick-open-results">{body}</div>
      </div>
    </div>
  );
}

export default QuickOpen;