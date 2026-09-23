import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import { OutlineModel } from "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { CancellationToken } from "monaco-editor/base/common/cancellation.js";
import { useSearchStore } from "../../stores/searchStore";
import { useEditorStore } from "../../stores/editorStore";
import { getModel } from "../../editor/modelStore";
import { openAndReveal } from "../../utils/reveal";

const REBUILD_DEBOUNCE = 300;

interface OutlineSymbol extends monaco.languages.DocumentSymbol {
  children?: OutlineSymbol[];
}

function OutlineRow({
  symbol,
  depth,
  onJump,
}: {
  symbol: OutlineSymbol;
  depth: number;
  onJump: (symbol: OutlineSymbol) => void;
}) {
  const children = symbol.children ?? [];
  return (
    <>
      <button
        type="button"
        className="outline-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onJump(symbol)}
      >
        <span className="outline-kind" aria-hidden="true">
          ◆
        </span>
        <span className="outline-name">{symbol.name}</span>
      </button>
      {children.map((child, i) => (
        <OutlineRow
          key={`${child.name}:${i}`}
          symbol={child}
          depth={depth + 1}
          onJump={onJump}
        />
      ))}
    </>
  );
}

function OutlinePanel() {
  const open = useSearchStore((s) => s.rightSidebarOpen);
  const tab = useSearchStore((s) => s.rightSidebarTab);
  const activePath = useEditorStore((s) => s.activePath);

  const [symbols, setSymbols] = useState<OutlineSymbol[] | null>(null);
  const [loading, setLoading] = useState(false);
  const buildSeq = useRef(0);

  const active = open && tab === "outline";

  useEffect(() => {
    if (!active) return;
    const path = activePath;
    const model = path ? getModel(path) : undefined;

    setSymbols(null);
    if (!model) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++buildSeq.current;
    let cancelled = false;

    const build = async () => {
      const languageFeatures = StandaloneServices.get<{
        documentSymbolProvider: {
          register(selector: unknown, provider: unknown): unknown;
          ordered(model: monaco.editor.ITextModel): unknown[];
          onDidChange(listener: () => void): unknown;
        };
      }>(ILanguageFeaturesService);
      const outline = await OutlineModel.create(
        languageFeatures.documentSymbolProvider,
        model,
        CancellationToken.None,
      );
      if (cancelled) return;
      setSymbols((outline.getTopLevelSymbols() as OutlineSymbol[]) ?? []);
      setLoading(false);
    };

    void build().catch(() => {
      if (!cancelled) {
        setSymbols([]);
        setLoading(false);
      }
    });

    const onContentChange = () => {
      const timer = setTimeout(() => {
        if (buildSeq.current !== seq) return;
        void build();
      }, REBUILD_DEBOUNCE);
      return () => clearTimeout(timer);
    };
    const contentSub = model.onDidChangeContent(onContentChange);

    return () => {
      cancelled = true;
      contentSub.dispose();
    };
  }, [active, activePath]);

  const jump = (symbol: OutlineSymbol) => {
    if (!activePath) return;
    const { startLineNumber, startColumn } = symbol.range;
    void openAndReveal(activePath, startLineNumber, startColumn);
  };

  if (!active) return null;

  let body: React.ReactNode;
  if (!activePath) {
    body = <p className="search-empty">未打开文件</p>;
  } else if (loading) {
    body = <p className="search-empty">加载中…</p>;
  } else if (!symbols || symbols.length === 0) {
    body = <p className="search-empty">无符号</p>;
  } else {
    body = (
      <div className="outline-list">
        {symbols.map((symbol, i) => (
          <OutlineRow
            key={`${symbol.name}:${i}`}
            symbol={symbol}
            depth={0}
            onJump={jump}
          />
        ))}
      </div>
    );
  }

  return <div className="panel outline-panel">{body}</div>;
}

export default OutlinePanel;