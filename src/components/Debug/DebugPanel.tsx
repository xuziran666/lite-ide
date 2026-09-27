import { useDebugStore } from "../../stores/debugStore";
import BreakpointsPanel from "./BreakpointsPanel";
import CallStackPanel from "./CallStackPanel";
import DebugToolbar from "./DebugToolbar";
import VariablesPanel from "./VariablesPanel";

/**
 * The Run and Debug primary-sidebar view: controls on top, then breakpoints,
 * call stack, variables and the tail of the program output.
 *
 * It is always mounted by `AppLayout` (like the other primary views) so the
 * session keeps receiving events while the panel is collapsed — the editor's
 * breakpoint dots and the Activity Bar badge must not stop working because
 * someone closed the sidebar.
 */
export default function DebugPanel() {
  const output = useDebugStore((s) => s.session.output);

  return (
    <div className="debug-panel">
      <DebugToolbar />

      <div className="debug-panel-body">
        <BreakpointsPanel />
        <CallStackPanel />
        <VariablesPanel />

        {output.length > 0 ? (
          <section className="debug-section" aria-label="输出">
            <header className="debug-section-header">
              <h3>输出</h3>
            </header>
            <pre className="debug-output">
              {output.slice(-12).map((line, index) => (
                <div
                  key={`${index}-${line.text}`}
                  className={`debug-output-line ${line.category}`}
                >
                  {line.text}
                </div>
              ))}
            </pre>
          </section>
        ) : null}
      </div>
    </div>
  );
}
