import { useCallback, useEffect, useState } from "react";
import { useDebugStore } from "../../stores/debugStore";
import { fetchVariables } from "../../debug/session";
import type { VariableEntry } from "../../debug/types";

/**
 * Variables of the selected frame, one group per scope.
 *
 * Values with children are expanded on demand: the adapter hands back a
 * `variablesReference` for them, and clicking a row issues the standard
 * `variables` request for that reference. Children are cached per panel, not in
 * the session, because expansion is pure view state — the session's job is only
 * the frame's top-level scopes.
 *
 * The cache is keyed by `variablesReference`, which the adapter only guarantees
 * to be unique *within a stop*. It is therefore cleared whenever the scope list
 * changes (a new stop, a different frame, a different thread), so a stale
 * reference can never show another frame's fields.
 */

interface VariableRowProps {
  variable: VariableEntry;
  depth: number;
  expanded: Set<number>;
  children: Record<number, VariableEntry[]>;
  onToggle: (reference: number) => void;
}

function VariableRow({
  variable,
  depth,
  expanded,
  children,
  onToggle,
}: VariableRowProps) {
  const reference = variable.reference ?? 0;
  const hasChildren = reference > 0;
  const isOpen = hasChildren && expanded.has(reference);

  return (
    <>
      <div
        className={
          hasChildren
            ? "debug-variable-row expandable"
            : "debug-variable-row"
        }
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={hasChildren ? () => onToggle(reference) : undefined}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={
          hasChildren
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(reference);
                }
              }
            : undefined
        }
        title={variable.value}
      >
        <span className="debug-variable-arrow">
          {hasChildren ? (isOpen ? "▾" : "▸") : ""}
        </span>
        <span className="debug-variable-name">{variable.name}</span>
        <span className="debug-variable-value">{variable.value}</span>
        <span className="debug-variable-type">{variable.type ?? ""}</span>
      </div>
      {isOpen
        ? (children[reference] ?? []).map((child, index) => (
            <VariableRow
              key={`${child.name}-${index}`}
              variable={child}
              depth={depth + 1}
              expanded={expanded}
              children={children}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  );
}

export default function VariablesPanel() {
  const status = useDebugStore((s) => s.session.status);
  const scopes = useDebugStore((s) => s.session.scopes);
  const selectedFrame = useDebugStore((s) => s.session.selectedFrame);
  const frames = useDebugStore((s) => s.session.frames);
  const frame = frames[selectedFrame];
  const stopped = status === "stopped";

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [children, setChildren] = useState<Record<number, VariableEntry[]>>({});

  // A new stop / frame / thread gives references a new meaning, so both caches
  // are dropped rather than risk showing one frame's fields under another's.
  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
  }, [scopes]);

  const onToggle = useCallback(
    (reference: number) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(reference)) {
          next.delete(reference);
        } else {
          next.add(reference);
          // Fetch once; a reopened node reuses the cache.
          if (!children[reference]) {
            void fetchVariables(reference).then((variables) => {
              setChildren((cache) => ({ ...cache, [reference]: variables }));
            });
          }
        }
        return next;
      });
    },
    [children],
  );

  return (
    <section className="debug-section" aria-label="变量">
      <header className="debug-section-header">
        <h3>变量</h3>
        {stopped && frame ? (
          <span className="debug-count" title={frame.name}>
            {frame.name}
          </span>
        ) : null}
      </header>

      {!stopped ? (
        <p className="debug-empty">程序未暂停，暂停后可查看变量。</p>
      ) : scopes.length === 0 ? (
        <p className="debug-empty">该栈帧没有可显示的变量。</p>
      ) : (
        scopes.map((scope) => (
          <div key={scope.variablesReference} className="debug-scope">
            <h4 className="debug-scope-name">{scope.name}</h4>
            {scope.variables.length === 0 ? (
              <p className="debug-empty small">（空）</p>
            ) : (
              <div className="debug-variables">
                {scope.variables.map((variable, index) => (
                  <VariableRow
                    key={`${variable.name}-${index}`}
                    variable={variable}
                    depth={0}
                    expanded={expanded}
                    children={children}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}
