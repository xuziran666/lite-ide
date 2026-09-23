import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import { registerCppOutline } from "./cppOutline";

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

// Monaco ships only tokenization for C/C++; register a lightweight symbol
// provider so the Outline panel works for cpp/c sources too.
registerCppOutline();

export {};