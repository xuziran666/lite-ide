import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import * as monaco from "monaco-editor";
import { registerLspClient } from "../lsp/client";

interface MonacoEnv {
  getWorker(moduleId: string, label: string): Worker;
}

(self as unknown as { MonacoEnvironment: MonacoEnv }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === "json") {
      return new JsonWorker();
    }
    if (label === "css" || label === "scss" || label === "less") {
      return new CssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new TsWorker();
    }
    return new EditorWorker();
  },
};

// The built-in LSP client (rust-analyzer / clangd / typescript-language-server)
// is the source of truth for completion, hover, definition, symbols and
// diagnostics. Disable the Monaco TypeScript/JavaScript worker's copy of those
// features so an installed server does not produce duplicate suggestions,
// outline entries or problems. The worker keeps the features the client does
// not replace (formatting, rename, references, code actions).
const TS_JS_MODE_CONFIGURATION = {
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  definitions: false,
  diagnostics: false,
  references: true,
  documentHighlights: true,
  rename: true,
  documentRangeFormattingEdits: true,
  signatureHelp: true,
  onTypeFormattingEdits: true,
  codeActions: true,
  inlayHints: true,
};
monaco.typescript.typescriptDefaults.setModeConfiguration(
  TS_JS_MODE_CONFIGURATION,
);
monaco.typescript.javascriptDefaults.setModeConfiguration(
  TS_JS_MODE_CONFIGURATION,
);

// Built-in LSP client. One server per language, started lazily and feeding
// diagnostics, completion, hover, definition and symbols to Monaco.
registerLspClient();

export {};
