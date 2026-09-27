import { useDebugStore } from "../../stores/debugStore";
import { toggleBreakpoint } from "../../debug/session";
import { openAndReveal } from "../../utils/reveal";
import { basename } from "../../utils/language";

/**
 * The breakpoint list, grouped by file.
 *
 * It reads the same per-workspace map the editor's glyph margin renders, so the
 * gutter and this list can never disagree: there is one source of truth for
 * "where are the user's breakpoints", and the adapter's verification verdict is
 * a badge on it rather than a second list.
 *
 * Clicking a row is *navigation*, not removal — the primary thing a user wants
 * from this list is to jump to the breakpoint. Removing is the explicit trailing
 * button, so the two actions cannot be confused.
 */
export default function BreakpointsPanel() {
  const files = useDebugStore((s) => s.breakpointsByFile);
  const status = useDebugStore((s) => s.session.status);
  const entries = Object.values(files).sort((a, b) => a.path.localeCompare(b.path));
  const total = entries.reduce((sum, file) => sum + file.lines.length, 0);

  return (
    <section className="debug-section" aria-label="断点">
      <header className="debug-section-header">
        <h3>断点</h3>
        <span className="debug-count">{total}</span>
      </header>

      {entries.length === 0 ? (
        <p className="debug-empty">
          尚未设置断点。点击编辑器行号左侧的装订线即可添加。
        </p>
      ) : (
        <ul className="debug-list">
          {entries.map((file) => {
            const unverified = file.lines.filter((line) => !file.verified.includes(line));
            return (
              <li key={file.path} className="debug-file">
                <div className="debug-file-name" title={file.path}>
                  {basename(file.path)}
                </div>
                <ul className="debug-breakpoint-lines">
                  {file.lines.map((line) => (
                    <li key={line} className="debug-breakpoint-item">
                      <button
                        type="button"
                        className="debug-breakpoint-row"
                        onClick={() => void openAndReveal(file.path, line)}
                        title={
                          file.verified.includes(line)
                            ? `${file.path}:${line} · 已绑定`
                            : `${file.path}:${line} · 未绑定（调试器尚未解析该行）`
                        }
                      >
                        <span
                          className={
                            file.verified.includes(line)
                              ? "debug-dot verified"
                              : "debug-dot unverified"
                          }
                        />
                        <span className="debug-line-number">{line}</span>
                      </button>
                      <button
                        type="button"
                        className="debug-breakpoint-remove"
                        aria-label={`移除断点 ${file.path}:${line}`}
                        title="移除断点"
                        onClick={() => void toggleBreakpoint(file.path, line)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                {status === "idle" && unverified.length > 0 ? (
                  <p className="debug-note">
                    未验证的断点会在启动调试后由适配器重新解析。
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
