import * as monaco from "monaco-editor";

/**
 * Lightweight C/C++ document-symbol provider. Monaco ships tokenization for
 * cpp but no symbol provider, so the Outline panel would always be empty for C
 * and C++ files. This scans declarations with brace-depth tracking — a simple
 * line scanner, NOT a full AST — and assembles a hierarchy out of the depths.
 */

interface CppSymbol {
  name: string;
  kind: monaco.languages.SymbolKind;
  line: number;
  startCol: number;
  endCol: number;
  depth: number;
}

interface CppNode extends CppSymbol {
  children: CppNode[];
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "sizeof",
  "decltype",
  "require",
  "alignas",
  "static_assert",
]);

/** Match a declaration name + column. Index of `col` is 1-based start. */
interface NameHit {
  name: string;
  col: number;
}

function matchName(line: string, prefixRe: RegExp): NameHit | null {
  const m = prefixRe.exec(line);
  if (!m) return null;
  const pre = line.slice(0, m.index);
  const col = pre.length + 1;
  return { name: m[1], col };
}

const NAMESPACE_RE = /^namespace\s+([A-Za-z_]\w*)/;
const ENUM_CLASS_RE = /^enum\s+class\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^(?:class|struct|union)\s+(?:final|sealed)?\s*([A-Za-z_]\w*)/;
const ENUM_RE = /^enum\s+([A-Za-z_]\w*)/;
const TYPEDEF_RE = /^typedef\s+(?:[\w:\s<>,\*&]+?)\s+([A-Za-z_]\w*)\s*;/;
const USING_ALIAS_RE = /^using\s+([A-Za-z_]\w*)\s*=/;
const FUNCTION_RE = /(?<![.\w>])((?:~?[A-Za-z_]\w*|operator\s*(?:\(\)|\[\]|[\w+\-*/%<>=!&|^~]+)))\s*\(/;

function scanFunction(line: string): NameHit | null {
  // A "(" must be present; skip control-flow statements and object-like usage.
  const m = FUNCTION_RE.exec(line);
  if (!m) return null;
  const name = m[1];
  if (CONTROL_KEYWORDS.has(name)) return null;
  const pre = line.slice(0, m.index);
  const col = pre.length + 1;
  return { name, col };
}

/** Strip a leading `template<...>` segment so the declaration itself matches. */
function stripTemplate(line: string): string {
  if (!line.startsWith("template")) return line;
  const idx = line.indexOf("<");
  if (idx < 0) return line;
  let depth = 0;
  for (let i = idx; i < line.length; i++) {
    const ch = line[i];
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return line.slice(i + 1).trimStart();
    }
  }
  return line;
}

function classify(line: string): CppSymbol | null {
  let hit: NameHit | null;
  const l = stripTemplate(line).trimStart();

  if (l.startsWith("#") || l.startsWith("//") || l.startsWith("/*") || l.startsWith("*")) {
    return null;
  }

  if ((hit = matchName(l, ENUM_CLASS_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.Enum);
  }
  if ((hit = matchName(l, NAMESPACE_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.Namespace);
  }
  if ((hit = matchName(l, CLASS_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.Class);
  }
  if ((hit = matchName(l, ENUM_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.Enum);
  }
  if ((hit = matchName(l, TYPEDEF_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.TypeParameter);
  }
  if ((hit = matchName(l, USING_ALIAS_RE))) {
    return kindOf(hit, monaco.languages.SymbolKind.TypeParameter);
  }
  if ((hit = scanFunction(l))) {
    return kindOf(hit, monaco.languages.SymbolKind.Function);
  }
  return null;
}

function kindOf(hit: NameHit, kind: monaco.languages.SymbolKind): CppSymbol {
  return {
    name: hit.name,
    kind,
    line: 0,
    startCol: hit.col,
    endCol: hit.col + hit.name.length,
    depth: 0,
  };
}

function buildTree(lines: string[]): CppNode[] {
  const tree: CppNode[] = [];
  const stack: CppNode[] = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const symbol = classify(line);
    if (symbol) {
      symbol.line = i + 1;
      symbol.depth = braceDepth;
      const node: CppNode = { ...symbol, children: [] };
      while (stack.length && stack[stack.length - 1].depth >= node.depth) {
        stack.pop();
      }
      if (stack.length) {
        stack[stack.length - 1].children.push(node);
      } else {
        tree.push(node);
      }
      stack.push(node);
    }

    const openBraces = (line.match(/\{/g) ?? []).length;
    const closeBraces = (line.match(/\}/g) ?? []).length;
    braceDepth = Math.max(0, braceDepth + openBraces - closeBraces);
  }
  return tree;
}

function toDocumentSymbols(nodes: CppNode[]): monaco.languages.DocumentSymbol[] {
  return nodes.map((node) => ({
    name: node.name,
    kind: node.kind,
    detail: "",
    tags: [],
    range: {
      startLineNumber: node.line,
      startColumn: 1,
      endLineNumber: node.line,
      endColumn: node.endCol,
    },
    selectionRange: {
      startLineNumber: node.line,
      startColumn: node.startCol,
      endLineNumber: node.line,
      endColumn: node.endCol,
    },
    children: toDocumentSymbols(node.children),
  }));
}

let registered = false;

export function registerCppOutline(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerDocumentSymbolProvider(
    [{ language: "cpp" }, { language: "c" }],
    {
      provideDocumentSymbols(model) {
        return toDocumentSymbols(buildTree(model.getValue().split("\n")));
      },
    },
  );
}