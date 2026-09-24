import * as monaco from "monaco-editor";
import { listen } from "@tauri-apps/api/event";
import { lspStart, lspStop, lspNotify, lspRequest } from "../commands";
import {
  pathToFileUri,
  fileUriToPath,
  monacoPositionToLsp,
  lspRangeToMonaco,
  lspDiagnosticsToMonacoMarkers,
  lspSymbolKindToMonaco,
  lspCompletionKindToMonaco,
  type LspDiagnostic,
  type LspCompletionItem,
  type LspSymbol,
  type LspRange,
} from "./protocol";
import { openAndReveal } from "../utils/reveal";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useUiStore } from "../stores/uiStore";

/**
 * Built-in LSP client wiring for the `rust` language, driven by rust-analyzer
 * over the Tauri commands in `src-tauri/src/commands/lsp.rs`. One server per
 * workspace, started lazily when the first `.rs` file opens and stopped when
 * the workspace switches, the app closes, or the last Rust file is closed.
 *
 * The server speaks to Monaco through the standard `monaco.languages` provider
 * APIs only - no monaco-lsp-client integration.
 */

const MARKER_OWNER = "rust-analyzer";
const CHANGE_DEBOUNCE_MS = 150;

/** Text-document state: the live model plus its debounced change listener. */
interface OpenDoc {
  model: monaco.editor.ITextModel;
  listener: monaco.IDisposable;
}

/** Root URI the current session runs under, or null when none is live. */
let startedRoot: string | null = null;
/** Serializes `ensureServer` so two models opening at once start once. */
let startGate: Promise<boolean> | null = null;
/** Open rust documents, keyed by their LSP file URI. */
const docs = new Map<string, OpenDoc>();
/** Debounce timers per document URI. */
const changeTimers = new Map<string, number>();

function isRust(model: monaco.editor.ITextModel): boolean {
  return model.getLanguageId() === "rust";
}

/** Non-ASCII-safe normalization of a workspace-backed model key:
 *  strips a Windows extended-length (`\\?\`, seen as `//?/`) prefix so open
 *  model keys match the clean paths LSP servers report back. Monaco may also
 *  emit the authority without the trailing slash (`file://%3FUNC/...`). */
function normalizePathKey(path: string): string {
  const unc = path.match(/^\/\/\?\/?UNC\/(.*)$/i);
  if (unc) return "//" + unc[1];
  if (path.startsWith("//?")) return path.slice(4).replace(/^\/+/, "");
  return path;
}

/** The model-store-style path key for a model, derived from its URI. */
function modelPath(model: monaco.editor.ITextModel): string {
  return normalizePathKey(
    fileUriToPath(model.uri.toString()) ?? model.uri.toString()
  );
}

function uriFor(model: monaco.editor.ITextModel): string {
  return pathToFileUri(modelPath(model));
}

function findOpenModel(path: string): monaco.editor.ITextModel | undefined {
  const needle = normalizePathKey(path).toLowerCase();
  for (const { model } of docs.values()) {
    if (normalizePathKey(modelPath(model)).toLowerCase() === needle) {
      return model;
    }
  }
  return monaco.editor
    .getModels()
    .find(
      (m) =>
        isRust(m) && normalizePathKey(modelPath(m)).toLowerCase() === needle
    );
}

/**
 * Windows path matching is case-insensitive (rust-analyzer normalizes the
 * drive letter to lowercase, opened models keep the original case). Return a
 * path that matches an already-open model so we never create a second tab for
 * the same physical file.
 */
function matchOpenModelCase(path: string): string {
  const model = findOpenModel(path);
  if (!model) return path;
  const existing = modelPath(model);
  return normalizePathKey(existing).toLowerCase() === path.toLowerCase()
    ? normalizePathKey(existing)
    : path;
}

/** Start the session if it isn't running yet. Resolves true when ready. */
async function ensureServer(triggerPath: string): Promise<boolean> {
  if (startedRoot !== null) return true;
  if (startGate) return startGate;

  startGate = (async () => {
    try {
      const result = await lspStart(triggerPath);
      startedRoot = result.rootUri;
      return true;
    } catch (err) {
      startedRoot = null;
      startGate = null;
      useUiStore
        .getState()
        .showToast(`无法启动 rust-analyzer: ${String(err)}`, "error");
      return false;
    }
  })();

  return startGate;
}

/** Drop every document reference and clear markers (server stopped/exited). */
function resetSession(): void {
  startedRoot = null;
  startGate = null;
  for (const { listener } of docs.values()) {
    listener.dispose();
  }
  docs.clear();
  for (const timer of changeTimers.values()) {
    window.clearTimeout(timer);
  }
  changeTimers.clear();
  for (const model of monaco.editor.getModels()) {
    if (isRust(model)) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    }
  }
}

function attachChangeListener(
  model: monaco.editor.ITextModel,
  uri: string,
): monaco.IDisposable {
  return model.onDidChangeContent(() => {
    if (model.isDisposed()) return;
    window.clearTimeout(changeTimers.get(uri));
    const timer = window.setTimeout(() => {
      changeTimers.delete(uri);
      void pushChanges(model, uri);
    }, CHANGE_DEBOUNCE_MS);
    changeTimers.set(uri, timer);
  });
}

async function pushChanges(
  model: monaco.editor.ITextModel,
  uri: string,
): Promise<void> {
  if (model.isDisposed() || !docs.has(uri)) return;
  try {
    await lspNotify("textDocument/didChange", {
      textDocument: { uri, version: model.getVersionId() },
      contentChanges: [{ text: model.getValue() }],
    });
  } catch {
    // The server may have died mid-edit; the exit toast already explains it.
  }
}

/** Send `didOpen` for a new rust model (idempotent per URI). */
async function openRustModel(model: monaco.editor.ITextModel): Promise<void> {
  const uri = uriFor(model);
  if (docs.has(uri)) return;

  const ok = await ensureServer(modelPath(model));
  if (!ok || docs.has(uri)) return;

  const listener = attachChangeListener(model, uri);
  docs.set(uri, { model, listener });
  try {
    await lspNotify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "rust",
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  } catch {
    docs.delete(uri);
    listener.dispose();
  }
}

/** Send `didClose` and stop the server when no Rust files remain open. */
function closeRustModel(model: monaco.editor.ITextModel): void {
  const uri = uriFor(model);
  const doc = docs.get(uri);
  if (doc) {
    window.clearTimeout(changeTimers.get(uri));
    changeTimers.delete(uri);
    doc.listener.dispose();
    docs.delete(uri);
  }
  void lspNotify("textDocument/didClose", { textDocument: { uri } }).catch(
    () => {},
  );
  if (docs.size === 0 && startedRoot !== null) {
    void lspStop()
      .then(() => resetSession())
      .catch((err) =>
        useUiStore
          .getState()
          .showToast(`停止 rust-analyzer 失败: ${String(err)}`, "error"),
      );
  }
}

// --- Providers ------------------------------------------------------------

function toMonacoCompletion(
  raw: LspCompletionItem,
  fallbackRange: monaco.Range,
): monaco.languages.CompletionItem {
  const item: monaco.languages.CompletionItem = {
    label: raw.label,
    kind: lspCompletionKindToMonaco(raw.kind),
    detail: raw.detail,
    sortText: raw.sortText,
    filterText: raw.filterText,
    insertText: raw.insertText ?? raw.label,
    range: fallbackRange,
  };

  if (raw.textEdit && raw.textEdit.newText) {
    const replace = raw.textEdit.replace ?? raw.textEdit.range;
    if (replace) {
      item.range = lspRangeToMonaco(replace);
    }
    item.insertText = raw.textEdit.newText;
  }

  if (raw.insertTextFormat === 2) {
    item.insertTextRules =
      monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }

  const doc = raw.documentation;
  if (typeof doc === "string") {
    item.documentation = { value: doc, isTrusted: false };
  } else if (doc && typeof doc.value === "string") {
    const value = doc.language && doc.value
      ? `\`\`\`${doc.language}\n${doc.value}\n\`\`\``
      : doc.value;
    item.documentation = { value, isTrusted: false };
  }

  return item;
}

function toDocumentSymbols(
  symbols: LspSymbol[],
): monaco.languages.DocumentSymbol[] {
  return symbols.map((s) => ({
    name: s.name,
    detail: s.detail ?? "",
    kind: lspSymbolKindToMonaco(s.kind),
    tags: [],
    range: lspRangeToMonaco(s.range),
    selectionRange: lspRangeToMonaco(s.selectionRange ?? s.range),
    children: toDocumentSymbols(s.children ?? []),
  }));
}

interface LspCompletionResult {
  items?: unknown;
}

interface LspHover {
  contents?: unknown;
  range?: LspRange;
}

interface LspLocation {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
  targetRange?: LspRange;
}

// --- Registration ----------------------------------------------------------

let registered = false;

/** Wire rust-analyzer into Monaco (idempotent; called once from monacoSetup). */
export function registerRustLsp(): void {
  if (registered) return;
  registered = true;

  monaco.editor.onDidCreateModel((model) => {
    if (isRust(model)) {
      void openRustModel(model);
    }
  });
  monaco.editor.onWillDisposeModel((model) => {
    if (isRust(model)) {
      closeRustModel(model);
    }
  });

  monaco.languages.registerCompletionItemProvider("rust", {
    triggerCharacters: [".", ":"],
    async provideCompletionItems(model, position, context, token) {
      const suggestions: monaco.languages.CompletionItem[] = [];
      try {
        const result = await lspRequest("textDocument/completion", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
          context: {
            triggerKind: context.triggerKind + 1,
            triggerCharacter: context.triggerCharacter ?? null,
          },
        });
        if (token.isCancellationRequested || !result) {
          return { suggestions: [] };
        }
        const list = Array.isArray(result)
          ? { items: result }
          : (result as LspCompletionResult);
        if (!Array.isArray(list.items)) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const replaceRange = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        for (const raw of list.items) {
          suggestions.push(
            toMonacoCompletion(raw as LspCompletionItem, replaceRange),
          );
        }
      } catch {
        // No server (yet) — surface an empty list, never an editor error.
      }
      return { suggestions };
    },
  });

  monaco.languages.registerHoverProvider("rust", {
    async provideHover(model, position, token) {
      try {
        const result = await lspRequest("textDocument/hover", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
        });
        if (token.isCancellationRequested || !result) return null;

        const hover = result as LspHover;
        const raw = Array.isArray(hover.contents)
          ? hover.contents
          : hover.contents
            ? [hover.contents]
            : [];
        const contents: monaco.IMarkdownString[] = [];
        for (const entry of raw) {
          if (typeof entry === "string") {
            contents.push({ value: entry, isTrusted: false });
          } else if (
            entry &&
            typeof entry === "object" &&
            typeof (entry as { value?: unknown }).value === "string"
          ) {
            const markdown = entry as { language?: string; value: string };
            contents.push({
              value: markdown.language && markdown.value
                ? `\`\`\`${markdown.language}\n${markdown.value}\n\`\`\``
                : markdown.value,
              isTrusted: false,
            });
          }
        }
        if (contents.length === 0) return null;
        return {
          contents,
          range: hover.range ? lspRangeToMonaco(hover.range) : undefined,
        };
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerDefinitionProvider("rust", {
    async provideDefinition(model, position, token) {
      try {
        const result = await lspRequest("textDocument/definition", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
        });
        if (token.isCancellationRequested || !result) return [];

        const list = Array.isArray(result) ? result : [result];
        const targets: {
          path: string;
          line: number;
          column: number;
        }[] = [];
        for (const entry of list) {
          const loc = entry as LspLocation;
          const uri = loc.uri ?? loc.targetUri;
          const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
          const path = uri ? fileUriToPath(uri) : undefined;
          if (!path || !range) continue;
          targets.push({
            path,
            line: range.start.line + 1,
            column: range.start.character + 1,
          });
        }

        if (targets.length > 0) {
          const path = matchOpenModelCase(targets[0].path);
          await openAndReveal(path, targets[0].line, targets[0].column);
        }
        const paths = targets.map((t) => matchOpenModelCase(t.path));
        return targets.map((t, i) => ({
          uri: monaco.Uri.file(paths[i]),
          range: new monaco.Range(t.line, t.column, t.line, t.column),
        }));
      } catch {
        return [];
      }
    },
  });

  monaco.languages.registerDocumentSymbolProvider("rust", {
    displayName: "rust-analyzer",
    async provideDocumentSymbols(model, token) {
      try {
        const result = await lspRequest("textDocument/documentSymbol", {
          textDocument: { uri: uriFor(model) },
        });
        if (token.isCancellationRequested || !result) return [];
        const symbols = Array.isArray(result) ? result : [];
        return toDocumentSymbols(symbols as LspSymbol[]);
      } catch {
        return [];
      }
    },
  });

  void listen<{
    path: string;
    diagnostics: LspDiagnostic[];
  }>("lsp-diagnostics", (event) => {
    const model = findOpenModel(event.payload.path);
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      lspDiagnosticsToMonacoMarkers(event.payload.diagnostics),
    );
  });

  void listen<{ message?: string }>("lsp-exited", (event) => {
    if (startedRoot === null) return;
    resetSession();
    useUiStore
      .getState()
      .showToast(
        `rust-analyzer 已退出: ${event.payload?.message ?? "未知原因"}`,
        "error",
      );
  });

  // Deferred: during module initialization `useWorkspaceStore` is still in the
  // import cycle (workspaceStore -> editorStore -> modelStore -> monacoSetup ->
  // rust.ts), so subscribing eagerly would hit the TDZ. A microtask runs after
  // the whole module graph has finished evaluating.
  queueMicrotask(() => {
    useWorkspaceStore.subscribe((state, prevState) => {
      if (state.workspacePath !== prevState.workspacePath) {
        resetSession();
      }
    });
  });

  // Models created before this module registered (defensive; normally none).
  for (const model of monaco.editor.getModels()) {
    if (isRust(model)) {
      void openRustModel(model);
    }
  }
}