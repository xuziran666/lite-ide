import { useEffect, useRef, useState } from "react";
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
import { useWorkspaceStore } from "../../stores/workspaceStore";

function toUint8Array(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (Array.isArray(message)) {
    return Uint8Array.from(message.map(Number).filter(Number.isInteger));
  }
  return new Uint8Array();
}

interface TerminalPaneProps {
  onCollapse: () => void;
}

function TerminalPane({ onCollapse }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const versionRef = useRef(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [exited, setExited] = useState(false);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    setExited(false);

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
        setExited(true);
      }
    };

    term.onData((data) => {
      void terminalWrite(data).catch(() => undefined);
    });

    const onResize = () => {
      requestAnimationFrame(() => {
        const term = termRef.current;
        if (!term) return;
        try {
          fit.fit();
          if (term.cols > 0 && term.rows > 0) {
            void terminalResize(term.cols, term.rows).catch(() => undefined);
          }
        } catch {
          // container not sized yet; the observer will fire again
        }
      });
    };

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);
    onResize();
    term.focus();

    chainRef.current = chainRef.current
      .then(() => terminalKill().catch(() => undefined))
      .then(() => terminalSpawn(channel));
    void chainRef.current;

    return () => {
      versionRef.current += 1;
      chainRef.current = chainRef.current.then(() =>
        terminalKill().catch(() => undefined),
      );
      resizeObserver.disconnect();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [workspacePath, runId]);

  const restart = () => {
    setExited(false);
    setRunId((r) => r + 1);
  };

  const clear = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };

  return (
    <section className="terminal-pane">
      <div className="terminal-toolbar">
        <span className="terminal-toolbar-title">终端</span>
        <span className="terminal-toolbar-spacer" />
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={clear}
        >
          清屏
        </button>
        <button
          type="button"
          className="terminal-toolbar-button"
          onClick={onCollapse}
        >
          折叠
        </button>
      </div>
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="terminal-exited-bar">
          <span>进程已退出</span>
          <button type="button" className="terminal-restart" onClick={restart}>
            重启
          </button>
        </div>
      )}
    </section>
  );
}

export default TerminalPane;