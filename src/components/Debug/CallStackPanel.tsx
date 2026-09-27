import { useDebugStore } from "../../stores/debugStore";
import { selectFrame, selectThread } from "../../debug/session";
import { openAndReveal } from "../../utils/reveal";
import { basename } from "../../utils/language";

/**
 * The call stack of the stopped thread.
 *
 * Clicking a frame both selects it (which loads its variables and moves the
 * editor's current-line highlight) and reveals its source. Selection and
 * navigation are separate concerns on purpose: selecting a frame in a file that
 * is not open must not fail, and revealing must not be needed to inspect
 * variables.
 *
 * The list is only meaningful while stopped; while running there is no stack to
 * show, and the state machine already cleared it, so this says so plainly
 * instead of rendering an empty list that looks broken.
 */
export default function CallStackPanel() {
  const status = useDebugStore((s) => s.session.status);
  const frames = useDebugStore((s) => s.session.frames);
  const selectedFrame = useDebugStore((s) => s.session.selectedFrame);
  const stopReason = useDebugStore((s) => s.session.stopReason);
  const threads = useDebugStore((s) => s.session.threads);
  const threadId = useDebugStore((s) => s.session.threadId);

  const stopped = status === "stopped";

  return (
    <section className="debug-section" aria-label="调用堆栈">
      <header className="debug-section-header">
        <h3>调用堆栈</h3>
        {/* A selector only earns its space when there is more than one thread to
            choose from; a single thread is already shown by the frames. */}
        {stopped && threads.length > 1 ? (
          <select
            className="debug-thread-select"
            value={threadId ?? threads[0]?.id}
            title="切换线程"
            onChange={(e) => void selectThread(Number(e.target.value))}
          >
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.name ?? `Thread ${thread.id}`}
              </option>
            ))}
          </select>
        ) : stopped && stopReason ? (
          <span className="debug-count">{stopReason}</span>
        ) : null}
      </header>

      {!stopped ? (
        <p className="debug-empty">程序未暂停，暂停后可查看调用堆栈。</p>
      ) : frames.length === 0 ? (
        <p className="debug-empty">没有可显示的栈帧。</p>
      ) : (
        <ul className="debug-list">
          {frames.map((frame, index) => (
            <li key={frame.id}>
              <button
                type="button"
                className={
                  index === selectedFrame
                    ? "debug-frame-row selected"
                    : "debug-frame-row"
                }
                onClick={() => {
                  void selectFrame(index);
                  // A frame with no source (a native or synthetic frame) has
                  // nothing to open, so navigation is skipped for it.
                  if (frame.path) {
                    void openAndReveal(frame.path, frame.line, frame.column);
                  }
                }}
                title={frame.path ? `${frame.path}:${frame.line ?? 1}` : frame.name}
              >
                <span className="debug-frame-name">{frame.name}</span>
                {frame.path ? (
                  <span className="debug-frame-location">
                    {basename(frame.path)}
                    {frame.line ? `:${frame.line}` : ""}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
