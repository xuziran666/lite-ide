import { useCallback, useEffect, useRef, useState } from "react";
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
import { useTerminalStore } from "../../stores/terminalStore";

function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) {
    return Uint8Array.from(message.map(Number).filter(Number.isInteger));
  }
  return new Uint8Array();
}

interface TerminalInstanceApi {
  clear: () => void;
  restart: () => void;
}

/** Live registry of every mounted instance, keyed by terminal id, so the pane
 * toolbar can drive the active terminal without remounting anything. */
interface InstanceRegistry {
  current: Map<number, TerminalInstanceApi>;
}

interface TerminalInstanceProps {
  id: number;
  active: boolean;
  instances: InstanceRegistry;
}

function TerminalInstance({ id, active, instances }: TerminalInstanceProps) {
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

  const restart = useCallback(() => {
    useTerminalStore.getState().markRunning(id);
    setRunStamp((r) => r + 1);
  }, [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Drop any leftover DOM from a previous render of this instance, so a
    // restart starts with a clean xterm surface.
    host.textContent = "";

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
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
    const onResize = () => {
      requestAnimationFrame(() => {
        const term = termRef.current;
        if (!term) return;
        if (!activeRef.current) return;
        const host = hostRef.current;
        if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fit.fit();
          if (term.cols > 0 && term.rows > 0) {
            void terminalResize(id, term.cols, term.rows).catch(() => undefined);
          }
        } catch {
          // container not sized yet; the observer will fire again
        }
      });
    };

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);
    if (activeRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
      onResize();
      term.focus();
    }

    chainRef.current = chainRef.current
      .then(() => terminalKill(id).catch(() => undefined))
      .then(() => terminalSpawn(id, channel));
    void chainRef.current;

    return () => {
      versionRef.current += 1;
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
      style={{ display: active ? undefined : "none" }}
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
  onCollapse: () => void;
}

function TerminalPane({ onCollapse }: TerminalPaneProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const create = useTerminalStore((s) => s.create);
  const close = useTerminalStore((s) => s.close);
  const select = useTerminalStore((s) => s.select);
  const instances = useRef(new Map<number, TerminalInstanceApi>());

  const clearActive = () => {
    if (activeId == null) return;
    instances.current.get(activeId)?.clear();
  };

  const restartActive = () => {
    if (activeId == null) return;
    instances.current.get(activeId)?.restart();
  };

  const closeActive = () => {
    if (activeId == null) return;
    close(activeId);
  };

  return (
    <section className="terminal-pane">
      <div className="terminal-toolbar">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <button
              key={t.id}
              type="button"
              className={
                t.id === activeId ? "terminal-tab active" : "terminal-tab"
              }
              onClick={() => select(t.id)}
            >
              {t.name}
              {t.exited ? " (已退出)" : ""}
            </button>
          ))}
          <button
            type="button"
            className="terminal-tab-add"
            title="新建终端"
            onClick={create}
          >
            +
          </button>
        </div>
        <span className="terminal-toolbar-spacer" />
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
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={closeActive}
          disabled={activeId == null}
        >
          ×
        </button>
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={onCollapse}
        >
          折叠
        </button>
      </div>
      <div className="terminal-host-area">
        {terminals.map((t) => (
          <TerminalInstance
            key={t.id}
            id={t.id}
            active={t.id === activeId}
            instances={instances}
          />
        ))}
      </div>
    </section>
  );
}

export default TerminalPane;