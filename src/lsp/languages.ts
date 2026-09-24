import * as monaco from "monaco-editor";
import { cppDocumentSymbols } from "../editor/cppOutline";
import { lspCommandFor } from "../stores/configStore";

/**
 * Language descriptors for the built-in LSP client. Each entry maps one server
 * (one client-side language id, one set of Monaco language ids) to the file
 * types it serves. Keeping this declarative is what lets the client register a
 * single set of Monaco providers and dispatch by the model's language.
 */
export interface LspLanguage {
  /** Client-side language id used across commands and events. */
  id: string;
  /** Monaco language ids served by this server. */
  monacoLanguages: string[];
  /** File extensions handled (mirrors `languageForPath` for documentation). */
  extensions: string[];
  /** Human-readable server name, used in toasts and the Outline label. */
  serverLabel: string;
  /** Extra completion trigger characters specific to the server. */
  triggerCharacters: string[];
  /** Outline symbols to fall back to when the server yields nothing. */
  fallbackDocumentSymbols?: (
    model: monaco.editor.ITextModel,
  ) => monaco.languages.DocumentSymbol[];
}

export const LSP_LANGUAGES: LspLanguage[] = [
  {
    id: "rust",
    monacoLanguages: ["rust"],
    extensions: [".rs"],
    serverLabel: "rust-analyzer",
    triggerCharacters: [".", ":"],
  },
  {
    id: "cpp",
    monacoLanguages: ["c", "cpp"],
    extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    serverLabel: "clangd",
    triggerCharacters: [".", ">", ":", "<"],
    fallbackDocumentSymbols: cppDocumentSymbols,
  },
  {
    id: "typescript",
    monacoLanguages: ["typescript", "javascript"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    serverLabel: "typescript-language-server",
    triggerCharacters: [".", ":", "<", ">", "\"", "'", "/", "@"],
  },
];

const MONACO_LANGUAGE_INDEX = new Map<string, LspLanguage>();
for (const language of LSP_LANGUAGES) {
  for (const monacoLanguage of language.monacoLanguages) {
    MONACO_LANGUAGE_INDEX.set(monacoLanguage, language);
  }
}

/** Monaco selector matching every language served by the LSP client. */
export const LSP_MONACO_SELECTOR = LSP_LANGUAGES.flatMap((language) =>
  language.monacoLanguages.map((languageId) => ({ language: languageId })),
);

/** All completion trigger characters across servers (de-duplicated). */
export const LSP_TRIGGER_CHARACTERS = [
  ...new Set(LSP_LANGUAGES.flatMap((language) => language.triggerCharacters)),
];

export function languageForMonacoId(id: string): LspLanguage | undefined {
  return MONACO_LANGUAGE_INDEX.get(id);
}

export function languageForModel(
  model: monaco.editor.ITextModel,
): LspLanguage | undefined {
  return MONACO_LANGUAGE_INDEX.get(model.getLanguageId());
}

export function languageById(id: string): LspLanguage | undefined {
  return LSP_LANGUAGES.find((language) => language.id === id);
}

/** The configured server argv for a language, or undefined to use the default. */
export function serverCommand(language: LspLanguage): string[] | undefined {
  return lspCommandFor(language.id);
}
