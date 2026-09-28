import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import {
  terminalSpawn,
  terminalWrite,
  terminalResize,
  terminalKill,
} from "../../commands";
import {
  useTerminalStore,
  DEBUG_TERMINAL_ID,
  type TerminalDock,
  type TerminalRecord,
} from "../../stores/terminalStore";
import { useTaskStore } from "../../stores/taskStore";
import { useConfigStore } from "../../stores/configStore";
import { toUint8Array } from "../../debug/debugTerminalOutput";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** How long to wait after Ctrl+C before starting the next task. */
const INTERRUPT_WAIT_MS = 350;

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--vo-color-1e1e1e", "#1e1e1e"),
    foreground: token("--vo-color-d4d4d4", "#d4d4d4"),
    cursor: token("--vo-color-d4d4d4", "#d4d4d4"),
    selectionBackground: "#264f78",
  };
}

export interface TerminalInstanceApi {
  clear: () => void;
  restart: () => void;
}

/** Live registry of every mounted instance, keyed by terminal id, so the pane
 * toolbar can drive the active terminal without remounting anything. */
export interface TerminalInstanceRegistry {
  current: Map<number, TerminalInstanceApi>;
}

/**
 * Shared pty lifecycle for a terminal instance: xterm + fit + WebGL, the
 * spawn/resize/write channel and the exit marker.
 *
 * Extra handles for the task terminal:
 * - `spawnedOnceRef` becomes true after the first spawn of the instance;
 * - `runAfterSpawn(fn)` registers a callback that runs once after the next
 *   (re)spawn finishes, so a command can be written the moment the shell is
 *   ready.
 */
function usePtySession(id: number, active: boolean) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const versionRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(active);
  activeRef.current = active;
  const [runStamp, setRunStamp] = useState(0);
  const exited = useTerminalStore(
    (s) => s.terminals.find((t) => t.id === id)?.exited ?? false,
  );
  const spawnedOnceRef = useRef(false);
  const afterSpawnRef = useRef<(() => void) | null>(null);

  const restart = useCallback(() => {
    useTerminalStore.getState().markRunning(id);
    setRunStamp((r) => r + 1);
  }, [id]);

  const runAfterSpawn = useCallback((fn: () => void) => {
    afterSpawnRef.current = fn;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Drop any leftover DOM from a previous render of this instance, so a
    // restart starts with a clean xterm surface.
    host.textContent = "";

    const initial = useConfigStore.getState();
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: initial.terminal.fontFamily,
      fontSize: initial.terminal.fontSize,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      console.warn("WebGL addon unavailable, falling back to canvas renderer");
    }
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // JetBrains-style Ctrl+C: with a selection copy it and swallow the event
    // (nothing reaches the PTY); without a selection fall through to xterm's
    // default handling, which sends \x03 to interrupt the current command.
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "c" &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        if (term.hasSelection()) {
          const selection = term.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => undefined);
          }
          return false;
        }
      }
      return true;
    });

    const version = ++versionRef.current;

    const channel = new Channel<Uint8Array>();
    channel.onmessage = (message) => {
      if (version !== versionRef.current) return;
      const bytes = toUint8Array(message);
      term.write(bytes);
      if (bytes.length === 0) {
        // Empty chunk = the shell exited (backend exit marker).
        useTerminalStore.getState().markExited(id);
      }
    };

    term.onData((data) => {
      void terminalWrite(id, data).catch(() => undefined);
    });

    // Only the visible, active terminal is fit and reports its size. The
    // hidden instances skip resizing (their container has zero width), and a
    // collapsed panel reports nothing at all.
    const fitAndReport = () => {
      requestAnimationFrame(() => {
        const current = termRef.current;
        if (!current) return;
        if (!activeRef.current) return;
        const container = hostRef.current;
        if (!container || container.clientWidth === 0 || container.clientHeight === 0)
          return;
        try {
          fit.fit();
          if (current.cols > 0 && current.rows > 0) {
            void terminalResize(id, current.cols, current.rows).catch(
              () => undefined,
            );
          }
        } catch {
          // container not sized yet; the observer will fire again
        }
      });
    };
    const onResize = fitAndReport;

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);
    if (activeRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
      onResize();
      term.focus();
    }

    // Hot-apply terminal font changes to this existing xterm without touching
    // the PTY or the buffer. A font-size change alters the cell dimensions, so
    // every update re-fits and re-reports the size through the same path used
    // by the ResizeObserver above; hidden instances skip that via activeRef.
    const unsubFont = useConfigStore.subscribe((state, prev) => {
      if (
        state.terminal.fontFamily === prev.terminal.fontFamily &&
        state.terminal.fontSize === prev.terminal.fontSize
      ) {
        return;
      }
      term.options.fontFamily = state.terminal.fontFamily;
      term.options.fontSize = state.terminal.fontSize;
      fitAndReport();
    });

    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    chainRef.current = chainRef.current
      .then(() => terminalKill(id).catch(() => undefined))
      .then(() => terminalSpawn(id, channel))
      .then(() => {
        if (version !== versionRef.current) return;
        spawnedOnceRef.current = true;
        const fn = afterSpawnRef.current;
        afterSpawnRef.current = null;
        fn?.();
      });
    void chainRef.current;

    return () => {
      versionRef.current += 1;
      unsubFont();
      themeObserver.disconnect();
      chainRef.current = chainRef.current.then(() =>
        terminalKill(id).catch(() => undefined),
      );
      resizeObserver.disconnect();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id, runStamp]);

  // Refocus the xterm whenever this terminal becomes the active tab.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (!activeRef.current) return;
      termRef.current?.focus();
    });
  }, [active]);

  // Ctrl/Cmd + wheel zoom: mirrors the editor's Ctrl+wheel behavior, gated by
  // the single `editor.mouseWheelZoom` switch. Adjusts `terminal.fontSize`
  // (8..40) and persists it; the config subscription above hot-applies the new
  // size to every terminal, then re-fits and re-reports the size. Plain wheels
  // are left untouched so xterm still scrolls normally.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Swallow the event so xterm neither scrolls nor the webview zooms.
      e.preventDefault();
      e.stopPropagation();
      const store = useConfigStore.getState();
      if (!store.editor.mouseWheelZoom) return;
      const step = e.deltaY > 0 ? -1 : 1;
      const next = Math.min(40, Math.max(8, store.terminal.fontSize + step));
      if (next !== store.terminal.fontSize) {
        void store.updateTerminal({ fontSize: next });
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () =>
      host.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  return { hostRef, termRef, restart, exited, spawnedOnceRef, runAfterSpawn };
}

interface TerminalInstanceProps {
  id: number;
  active: boolean;
  instances: TerminalInstanceRegistry;
  frameStyle: CSSProperties;
}

function TerminalInstance({
  id,
  active,
  instances,
  frameStyle,
}: TerminalInstanceProps) {
  const { hostRef, termRef, restart, exited } = usePtySession(id, active);

  // Publish the instance actions so the pane toolbar can target the active one.
  useEffect(() => {
    instances.current.set(id, {
      clear: () => {
        termRef.current?.clear();
        termRef.current?.focus();
      },
      restart,
    });
    return () => {
      instances.current.delete(id);
    };
  }, [id, instances, restart]);

  return (
    <div
      className={active ? "terminal-instance active" : "terminal-instance"}
      style={{ ...frameStyle, display: active ? "flex" : "none" }}
    >
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="terminal-exited-bar">
          <span>进程已退出</span>
          <button type="button" className="terminal-restart" onClick={restart}>
            重启
          </button>
        </div>
      )}
    </div>
  );
}

interface TaskTerminalInstanceProps {
  id: number;
  active: boolean;
  instances: TerminalInstanceRegistry;
  frameStyle: CSSProperties;
}

/**
 * The single dedicated task terminal. It is a normal shell that additionally
 * consumes `taskStore.pendingTask`: it interrupts a running task with Ctrl+C,
 * then writes the resolved command to the shell. If the shell already exited it
 * respawns first, and a command issued before the very first spawn is queued
 * behind it.
 */
function TaskTerminalInstance({
  id,
  active,
  instances,
  frameStyle,
}: TaskTerminalInstanceProps) {
  const { hostRef, termRef, restart, exited, spawnedOnceRef, runAfterSpawn } =
    usePtySession(id, active);
  const pending = useTaskStore((s) => s.pendingTask);
  const taskStatus = useTaskStore((s) => s.taskStatus);

  const statusRef = useRef(taskStatus);
  statusRef.current = taskStatus;
  const exitedRef = useRef(exited);
  exitedRef.current = exited;

  // A dead shell means the task itself is exited until it is restarted.
  useEffect(() => {
    if (exited) useTaskStore.getState().markExited();
  }, [exited]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const writeCommand = () =>
      void terminalWrite(id, `${pending.command}\r`).catch(() => undefined);

    void (async () => {
      if (statusRef.current === "running") {
        await terminalWrite(id, "\u0003").catch(() => undefined);
        await sleep(INTERRUPT_WAIT_MS);
      }
      if (cancelled) return;

      if (exitedRef.current) {
        // Respawn the shell, writing the command once it is back.
        runAfterSpawn(writeCommand);
        restart();
      } else if (spawnedOnceRef.current) {
        writeCommand();
      } else {
        // First run on a freshly created session while the spawn is in flight.
        runAfterSpawn(writeCommand);
      }
      useTaskStore.getState().markRunning(pending.name);
    })();

    return () => {
      cancelled = true;
    };
  }, [id, pending, restart, runAfterSpawn]);

  // Publish so the pane toolbar can target the task terminal as well.
  useEffect(() => {
    instances.current.set(id, {
      clear: () => {
        termRef.current?.clear();
        termRef.current?.focus();
      },
      restart,
    });
    return () => {
      instances.current.delete(id);
    };
  }, [id, instances, restart]);

  return (
    <div
      className={active ? "terminal-instance active" : "terminal-instance"}
      style={{ ...frameStyle, display: active ? "flex" : "none" }}
    >
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="terminal-exited-bar">
          <span>进程已退出</span>
          <button type="button" className="terminal-restart" onClick={restart}>
            重启
          </button>
        </div>
      )}
    </div>
  );
}

interface TerminalPaneProps {
  dock: TerminalDock;
  instances: TerminalInstanceRegistry;
  showTabs?: boolean;
  onCollapse?: () => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
}

/**
 * The debuggee's own terminal.
 *
 * Unlike the normal and task terminals, it does not spawn a shell: its pty is
 * the debuggee itself. The backend starts the program here when a session
 * launches (and then attaches the debug adapter to that process), or when an
 * adapter asks for a `runInTerminal` launch, so the program's
 * stdin/stdout/stderr are this xterm. Output arrives as backend events; input is
 * forwarded with the ordinary `terminal_write`.
 *
 * Keeping the program here rather than on the adapter's stdio is what makes
 * interactive input work, and it also means the adapter's own output (the GDB
 * banner, `[New Thread …]`, `attached to process …`) can never appear mixed in
 * with the program's — that stays on the DAP output channel.
 *
 * The instance only exists once the Debug tab does (created on F5), and it stays
 * mounted while the panel is collapsed, so output is never dropped.
 */
function DebugTerminalInstance({
  active,
  instances,
  frameStyle,
}: {
  active: boolean;
  instances: TerminalInstanceRegistry;
  frameStyle: CSSProperties;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const exited = useTerminalStore(
    (s) => s.terminals.find((t) => t.kind === "debug")?.exited ?? false,
  );
  const debugSessionId = useTerminalStore((s) => s.debugSessionId);
  const debugTerminalClearSeq = useTerminalStore((s) => s.debugTerminalClearSeq);
  const debugOutputRevision = useTerminalStore((s) => s.debugOutputRevision);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.textContent = "";

    const initial = useConfigStore.getState();
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: initial.terminal.fontFamily,
      fontSize: initial.terminal.fontSize,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {
      // canvas renderer fallback
    }
    term.open(host);
    termRef.current = term;

    term.onData((data) => {
      void terminalWrite(DEBUG_TERMINAL_ID, data).catch(() => undefined);
    });

    const fitAndReport = () => {
      requestAnimationFrame(() => {
        if (!activeRef.current) return;
        const container = hostRef.current;
        if (
          !container ||
          container.clientWidth === 0 ||
          container.clientHeight === 0
        ) {
          return;
        }
        try {
          fit.fit();
          if (term.cols > 0 && term.rows > 0) {
            void terminalResize(DEBUG_TERMINAL_ID, term.cols, term.rows).catch(
              () => undefined,
            );
          }
        } catch {
          // container not sized yet
        }
      });
    };
    const resizeObserver = new ResizeObserver(fitAndReport);
    resizeObserver.observe(host);
    if (activeRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
      fitAndReport();
    }

    const unsubFont = useConfigStore.subscribe((state, prev) => {
      if (
        state.terminal.fontFamily === prev.terminal.fontFamily &&
        state.terminal.fontSize === prev.terminal.fontSize
      ) {
        return;
      }
      term.options.fontFamily = state.terminal.fontFamily;
      term.options.fontSize = state.terminal.fontSize;
      fitAndReport();
    });

    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      unsubFont();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (debugTerminalClearSeq === 0) return;
    termRef.current?.reset();
  }, [debugTerminalClearSeq]);

  useEffect(() => {
    if (debugSessionId === null || !termRef.current) return;
    const output = useTerminalStore
      .getState()
      .consumeDebugOutput(debugSessionId);
    if (output.length > 0) termRef.current.write(output);
  }, [debugSessionId, debugOutputRevision]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (activeRef.current) termRef.current?.focus();
    });
  }, [active]);

  useEffect(() => {
    instances.current.set(DEBUG_TERMINAL_ID, {
      clear: () => termRef.current?.clear(),
      restart: () => undefined,
    });
    return () => {
      instances.current.delete(DEBUG_TERMINAL_ID);
    };
  }, [instances]);

  return (
    <div
      className={active ? "terminal-instance active" : "terminal-instance"}
      style={{ ...frameStyle, display: active ? "flex" : "none" }}
    >
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="terminal-exited-bar">
          <span>程序已退出</span>
        </div>
      )}
    </div>
  );
}

function TerminalPane({
  dock,
  instances,
  showTabs = true,
  onCollapse,
  onDragStart,
  onDragEnd,
}: TerminalPaneProps) {
  const allTerminals = useTerminalStore((s) => s.terminals);
  const terminals = allTerminals.filter((terminal) => terminal.dock === dock);
  const activeId = useTerminalStore((s) => s.activeIdByDock[dock]);
  const activeTerminal = terminals.find((terminal) => terminal.id === activeId);
  const create = useTerminalStore((s) => s.create);
  const close = useTerminalStore((s) => s.close);
  const select = useTerminalStore((s) => s.select);
  const taskTerminalId = useTaskStore((s) => s.taskTerminalId);
  const taskRunning = useTaskStore((s) => s.taskStatus === "running");

  const taskTab =
    terminals.find((t) => t.id === taskTerminalId) ?? null;
  const debugTab = terminals.find((t) => t.kind === "debug") ?? null;
  const normalTerminals = terminals.filter(
    (t) => t.kind !== "task" && t.kind !== "debug",
  );

  const clearActive = () => {
    if (activeId == null) return;
    instances.current.get(activeId)?.clear();
  };

  const restartActive = () => {
    if (activeId == null) return;
    instances.current.get(activeId)?.restart();
  };

  const renderTab = (terminal: TerminalRecord, label: string, className = "") => (
    <div
      key={terminal.id}
      className={
        terminal.id === activeId
          ? `terminal-tab-group active ${className}`
          : `terminal-tab-group ${className}`
      }
      draggable
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest(".terminal-tab-close")) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "application/x-lite-ide-terminal",
          String(terminal.id),
        );
        onDragStart(terminal.id);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className={
          terminal.id === activeId
            ? `terminal-tab active ${className}`
            : `terminal-tab ${className}`
        }
        title={terminal.name}
        onClick={() => select(terminal.id)}
      >
        {label}
      </button>
      <button
        type="button"
        className="terminal-tab-close"
        title={`关闭 ${terminal.name}`}
        onClick={(event) => {
          event.stopPropagation();
          close(terminal.id);
        }}
      >
        ×
      </button>
    </div>
  );

  return (
    <section className="terminal-pane">
      <div className="terminal-toolbar">
        {showTabs ? (
          <div className="terminal-tabs">
            {taskTab && renderTab(taskTab, `任务${taskRunning ? " ●" : ""}`, "task")}
            {debugTab &&
              renderTab(
                debugTab,
                `${debugTab.name}${debugTab.exited ? " (已退出)" : ""}`,
                "debug",
              )}
            {normalTerminals.map((terminal) =>
              renderTab(
                terminal,
                `${terminal.name}${terminal.exited ? " (已退出)" : ""}`,
              ),
            )}
            <button
              type="button"
              className="terminal-tab-add"
              title="新建终端"
              onClick={() => create("normal", dock)}
            >
              +
            </button>
          </div>
        ) : (
          <span className="terminal-toolbar-title">
            {activeTerminal?.name ?? "终端"}
          </span>
        )}
        <span className="terminal-toolbar-spacer" />
        {!showTabs && (
          <button
            type="button"
            className="terminal-toolbar-button"
            title="新建终端"
            onClick={() => create("normal", dock)}
          >
            +
          </button>
        )}
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={clearActive}
          disabled={activeId == null}
        >
          清屏
        </button>
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={restartActive}
          disabled={activeId == null}
        >
          重启
        </button>
        {activeId != null && (
          <button
            type="button"
            className="terminal-toolbar-button"
            title={`关闭 ${activeTerminal?.name ?? "终端"}`}
            onClick={() => close(activeId)}
          >
            ×
          </button>
        )}
        {onCollapse && (
          <button
            type="button"
            className="terminal-toolbar-button"
            onClick={onCollapse}
          >
            折叠
          </button>
        )}
      </div>
      <div className="terminal-host-area" data-terminal-dock={dock} />
    </section>
  );
}

export interface TerminalPanelBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function TerminalSessionLayer({
  boundsByDock,
  visibleByDock,
  instances,
  dragging,
}: {
  boundsByDock: Record<TerminalDock, TerminalPanelBounds | null>;
  visibleByDock: Record<TerminalDock, boolean>;
  instances: TerminalInstanceRegistry;
  dragging: boolean;
}) {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeIdByDock = useTerminalStore((s) => s.activeIdByDock);

  return (
    <>
      {terminals.map((terminal) => {
        const bounds = boundsByDock[terminal.dock];
        const active =
          bounds !== null &&
          visibleByDock[terminal.dock] &&
          activeIdByDock[terminal.dock] === terminal.id;
        const frameStyle: CSSProperties = bounds
          ? {
              position: "fixed",
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
              zIndex: 20,
              pointerEvents: active && !dragging ? "auto" : "none",
            }
          : {
              position: "fixed",
              left: 0,
              top: 0,
              width: 0,
              height: 0,
              zIndex: 20,
              pointerEvents: "none",
            };

        if (terminal.kind === "task") {
          return (
            <TaskTerminalInstance
              key={terminal.id}
              id={terminal.id}
              active={active}
              instances={instances}
              frameStyle={frameStyle}
            />
          );
        }
        if (terminal.kind === "debug") {
          return (
            <DebugTerminalInstance
              key={terminal.id}
              active={active}
              instances={instances}
              frameStyle={frameStyle}
            />
          );
        }
        return (
          <TerminalInstance
            key={terminal.id}
            id={terminal.id}
            active={active}
            instances={instances}
            frameStyle={frameStyle}
          />
        );
      })}
    </>
  );
}

export default TerminalPane;