import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchMatch } from "../../commands";
import { searchWorkspace } from "../../commands";
import { useSearchStore } from "../../stores/searchStore";
import { openAndReveal } from "../../utils/reveal";

interface Group {
  path: string;
  matches: SearchMatch[];
}

const DEBOUNCE_MS = 300;

function GlobalSearch() {
  const open = useSearchStore((s) => s.rightSidebarOpen);
  const tab = useSearchStore((s) => s.rightSidebarTab);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seqRef = useRef(0);

  const active = open && tab === "search";

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [active]);

  const runSearch = async (text: string, cs: boolean, rx: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) {
      setMatches(null);
      setError(null);
      setSearched(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    setError(null);
    try {
      const result = await searchWorkspace(trimmed, {
        caseSensitive: cs,
        useRegex: rx,
      });
      if (seq !== seqRef.current) return;
      setMatches(result);
      setSearched(true);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setMatches(null);
      setError(String(e));
      setSearched(true);
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  };

  // Debounced auto-search as the user types.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void runSearch(query, caseSensitive, useRegex), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, useRegex, active]);

  const groups = useMemo<Group[]>(() => {
    if (!matches) return [];
    const map = new Map<string, SearchMatch[]>();
    for (const m of matches) {
      const list = map.get(m.path);
      if (list) list.push(m);
      else map.set(m.path, [m]);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, list]) => ({ path, matches: list }));
  }, [matches]);

  const jump = (path: string, line: number, column: number) => {
    void openAndReveal(path, line, column);
  };

  const total = matches?.length ?? 0;

  return (
    <div className="panel search-panel">
      <div className="search-input-row">
        <input
          ref={inputRef}
          className="search-query-input"
          placeholder="搜索整个工作区…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(query, caseSensitive, useRegex);
          }}
          spellCheck={false}
        />
      </div>
      <div className="search-toolbar">
        <button
          type="button"
          className={caseSensitive ? "search-toggle active" : "search-toggle"}
          title="区分大小写"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          type="button"
          className={useRegex ? "search-toggle active" : "search-toggle"}
          title="使用正则表达式"
          onClick={() => setUseRegex((v) => !v)}
        >
          .*
        </button>
        <span className="search-status">
          {searching
            ? "搜索中…"
            : searched
              ? `${groups.length} 个文件 / ${total} 处匹配`
              : ""}
        </span>
      </div>

      <div className="search-results">
        {error && <p className="search-error">{error}</p>}
        {!error && searched && !searching && matches && matches.length === 0 && (
          <p className="search-empty">没有匹配的内容</p>
        )}
        {!error && !searched && !searching && (
          <p className="search-empty">输入关键词搜索文件名或内容</p>
        )}
        {groups.map((group) => (
          <div className="search-group" key={group.path}>
            <div className="search-group-header">
              <span className="search-group-path">{group.path}</span>
              <span className="search-group-count">{group.matches.length}</span>
            </div>
            {group.matches.map((m, idx) => (
              <button
                type="button"
                className="search-match-row"
                key={`${m.path}:${m.line}:${m.column}:${idx}`}
                onClick={() => jump(m.path, m.line, m.column)}
              >
                <span className="search-match-loc">
                  {m.line}:{m.column}
                </span>
                <span className="search-match-text">{m.text}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default GlobalSearch;