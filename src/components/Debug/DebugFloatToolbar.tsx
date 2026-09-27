import { useDebugStore } from "../../stores/debugStore";
import {
  continueSession,
  pauseSession,
  restartSession,
  stepInto,
  stepOut,
  stepOver,
  stopSession,
} from "../../debug/session";

/**
 * The VS Code-style floating session toolbar.
 *
 * It is an absolute overlay inside the editor area (`.editor-stack`), NOT part
 * of the editor's layout flow: Monaco keeps its full size and scroll area, and a
 * collapsed/absent session simply renders nothing. It appears only while a
 * session is running or stopped; idle/terminated keep it hidden.
 *
 * Controls are icon-only. Every action calls the same `debug/session` functions
 * the keybindings use, so the two can never diverge. `title`/`aria-label` carry
 * the English action names for tooltips.
 */
export default function DebugFloatToolbar() {
  const status = useDebugStore((s) => s.session.status);
  const capabilities = useDebugStore((s) => s.session.capabilities);

  const running = status === "running";
  const stopped = status === "stopped";
  if (!running && !stopped) return null;

  /** A capability disables a button only when the adapter explicitly says false. */
  const supported = (field: string) => capabilities?.[field] !== false;

  return (
    <div className="debug-float-toolbar" role="toolbar" aria-label="Debug toolbar">
      {/* Drag affordance: visual only in this phase. */}
      <span className="debug-float-handle" aria-hidden="true" title="Drag">
        <svg width="10" height="14" viewBox="0 0 10 14" focusable="false">
          <g fill="currentColor">
            <circle cx="2.5" cy="3" r="1.2" />
            <circle cx="7.5" cy="3" r="1.2" />
            <circle cx="2.5" cy="7" r="1.2" />
            <circle cx="7.5" cy="7" r="1.2" />
            <circle cx="2.5" cy="11" r="1.2" />
            <circle cx="7.5" cy="11" r="1.2" />
          </g>
        </svg>
      </span>

      {running ? (
        <button
          type="button"
          className="debug-float-button"
          title="Pause"
          aria-label="Pause"
          disabled={!supported("supportsPauseRequest")}
          onClick={() => void pauseSession()}
        >
          ⏸
        </button>
      ) : null}

      {stopped ? (
        <>
          <button
            type="button"
            className="debug-float-button"
            title="Continue"
            aria-label="Continue"
            onClick={() => void continueSession()}
          >
            ▶
          </button>
          <button
            type="button"
            className="debug-float-button"
            title="Step Over"
            aria-label="Step Over"
            onClick={() => void stepOver()}
          >
            ↻
          </button>
          <button
            type="button"
            className="debug-float-button"
            title="Step Into"
            aria-label="Step Into"
            disabled={!supported("supportsStepIn")}
            onClick={() => void stepInto()}
          >
            ↓
          </button>
          <button
            type="button"
            className="debug-float-button"
            title="Step Out"
            aria-label="Step Out"
            disabled={!supported("supportsStepOut")}
            onClick={() => void stepOut()}
          >
            ↑
          </button>
        </>
      ) : null}

      <button
        type="button"
        className="debug-float-button"
        title="Restart"
        aria-label="Restart"
        onClick={() => void restartSession()}
      >
        ↶
      </button>
      <button
        type="button"
        className="debug-float-button stop"
        title="Stop"
        aria-label="Stop"
        onClick={() => void stopSession()}
      >
        ■
      </button>

      <span className="debug-float-sep" aria-hidden="true" />
      <button
        type="button"
        className="debug-float-button more"
        title="More debug actions"
        aria-label="More debug actions"
      >
        ▾
      </button>
    </div>
  );
}
