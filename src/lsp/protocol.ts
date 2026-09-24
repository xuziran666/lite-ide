import * as monaco from "monaco-editor";

/**
 * Minimal LSP wire types (camelCase, matching the serde output of the Rust
 * session) plus the converters needed to translate between Monaco and LSP.
 *
 * Position semantics: Monaco is 1-based, LSP is 0-based. Every converter does
 * the +/-1 dance in one place so the providers never repeat it.
 */

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  message: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { language?: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: {
    range?: LspRange;
    insert?: LspRange;
    replace?: LspRange;
    newText: string;
  };
}

export interface LspSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspSymbol[];
}

/** URI‑safe helpers. Keep `/` and `:` verbatim like the Rust `uri.rs`. */
const ALLOWED =
  /[A-Za-z0-9\-._~/:]/;

function percentEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (const b of bytes) {
    if (ALLOWED.test(String.fromCharCode(b))) {
      out += String.fromCharCode(b);
    } else {
      out += "%" + b.toString(16).padStart(2, "0").toUpperCase();
    }
  }
  return out;
}

function percentDecode(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "%") {
      const hex = input.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error("bad percent escape");
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(bytes),
  );
}

/**
 * Convert a normalized filesystem key (the model store uses `/`-separated
 * absolute paths) into the LSP `file://` URI string.
 */
export function pathToFileUri(path: string): string {
  let norm = String(path).replace(/\\/g, "/");
  // Windows extended-length (verbatim) prefix: `\\?\C:\...` -> `//?/C:/...`,
  // `\\?\UNC\server\share` -> `//?/UNC/server/share`. LSP servers reject `?`
  // in a URI authority, so strip it (mirrors uri.rs). Handles Monaco's
  // authority form without the trailing slash too (`file://%3FUNC/...`).
  const unc = norm.match(/^\/\/\?\/?UNC\/(.*)$/i);
  if (unc) {
    norm = "//" + unc[1];
  } else if (norm.startsWith("//?")) {
    norm = norm.slice(4).replace(/^\/+/, "");
  }
  if (norm.startsWith("//")) {
    return "file://" + percentEncode(norm.replace(/^\/+/, ""));
  }
  if (norm.startsWith("/")) {
    return "file://" + percentEncode(norm);
  }
  return "file:///" + percentEncode(norm);
}

/** Reverse of {@link pathToFileUri}; null for anything non-file. */
export function fileUriToPath(uri: string): string | null {
  const prefix = "file://";
  if (!uri.startsWith(prefix)) return null;
  const after = uri.slice(prefix.length);
  const unc = !after.startsWith("/");

  let decoded: string;
  try {
    decoded = percentDecode(after);
  } catch {
    return null;
  }
  if (unc) {
    return decoded.length > 0 && !decoded.startsWith("/")
      ? "//" + decoded
      : decoded;
  }
  // `/E:/...` -> `E:/...` so platform paths match the model store keys.
  if (
    decoded.length >= 3 &&
    decoded[0] === "/" &&
    /^[A-Za-z]$/.test(decoded[1]) &&
    decoded[2] === ":"
  ) {
    return decoded.slice(1);
  }
  return decoded;
}

/** LSP position from Monaco's 1-based line/column. */
export function monacoPositionToLsp(line: number, column: number): LspPosition {
  return { line: line - 1, character: column - 1 };
}

export function monacoRangeToLsp(range: monaco.IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

/** Monaco 1-based range from an LSP 0-based range. */
export function lspRangeToMonaco(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * LSP DiagnosticSeverity (Error=1..Hint=4) -> Monaco MarkerSeverity
 * (Hint=1, Info=2, Warning=4, Error=8). A missing severity defaults to Error
 * per the LSP spec.
 */
export function lspSeverityToMonaco(
  severity: number | undefined,
): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

/** Convert one server diagnostic list into Monaco `IMarkerData`. */
export function lspDiagnosticsToMonacoMarkers(
  diagnostics: LspDiagnostic[],
): monaco.editor.IMarkerData[] {
  return diagnostics.map((d) => ({
    severity: lspSeverityToMonaco(d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  }));
}

/**
 * LSP DocumentSymbolKind (1..26) -> Monaco SymbolKind (0..25). The two enums
 * enumerate the same kinds in the same order, so it is simply kind - 1.
 */
export function lspSymbolKindToMonaco(kind: number): monaco.languages.SymbolKind {
  const value = kind - 1;
  if (value < 0) return monaco.languages.SymbolKind.File;
  if (value > monaco.languages.SymbolKind.TypeParameter) {
    return monaco.languages.SymbolKind.Variable;
  }
  return value as monaco.languages.SymbolKind;
}

/**
 * LSP CompletionItemKind (1..25) -> Monaco CompletionItemKind. These are NOT a
 * plain offset map (Monaco gained Text/Snippet kinds early), so an explicit
 * table is used.
 */
const LSP_COMPLETION_KIND_TO_MONACO: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter,
};

export function lspCompletionKindToMonaco(
  kind: number | undefined,
): monaco.languages.CompletionItemKind {
  if (kind === undefined) return monaco.languages.CompletionItemKind.Text;
  return (
    LSP_COMPLETION_KIND_TO_MONACO[kind] ??
    monaco.languages.CompletionItemKind.Text
  );
}