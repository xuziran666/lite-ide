/* Type surface for monaco internals used by the Outline panel. These modules
 * are not part of the public API but are reachable through the package
 * `exports` map; loose typing is enough for the OutlineModel service usage. */

declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    get<T>(service?: unknown): T;
  };
}

declare module "monaco-editor/editor/common/services/languageFeatures.js" {
  export const ILanguageFeaturesService: unknown;
}

declare module "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js" {
  import type * as monaco from "monaco-editor";
  export class OutlineModel {
    static create(
      registry: {
        ordered(model: monaco.editor.ITextModel): unknown[];
        onDidChange(listener: () => void): unknown;
      },
      model: monaco.editor.ITextModel,
      token: unknown,
    ): Promise<OutlineModel>;
    getTopLevelSymbols(): monaco.languages.DocumentSymbol[];
  }
}

declare module "monaco-editor/base/common/cancellation.js" {
  export const CancellationToken: { None: unknown };
}