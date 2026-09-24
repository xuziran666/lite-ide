import * as monaco from "monaco-editor";
import { listen } from "@tauri-apps/api/event";
import {
  lspStart,
  lspStop,
  lspNotify,
  lspRequest,
  readFile,
  readExternalFile,
} from "../commands";
import { languageForPath } from "../utils/language";
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
  const forward = path.replace(/\\/g, "/");
  const unc = forward.match(/^\/\/\?\/?UNC\/(.*)$/i);
  if (unc) return "//" + unc[1];
  if (forward.startsWith("//?")) return forward.slice(4).replace(/^\/+/, "");
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

/** Whether a path belongs to the currently opened workspace. Windows paths are
 *  compared case-insensitively and normalized for separators and a verbatim
 *  (`\\?\`) / UNC prefix, mirroring the reveal helper used for navigation. */
function isInsideWorkspace(path: string): boolean {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return false;
  const key = (p: string) =>
    normalizePathKey(p).replace(/\\/g, "/").toLowerCase();
  const needle = key(path);
  const root = key(ws).replace(/\/+$/, "");
  return needle === root || needle.startsWith(root + "/");
}

/**
 * Plain Monaco models created for definition-target hover previews. They are
 * not tracked by the model store and live only until the session resets (they
 * are read-only placeholders so Monaco's Ctrl+hover preview and click can
 * resolve the target's file URI). Once the user actually jumps to a target the
 * editor store re-reads the file and takes ownership of the model.
 */
const previewModels = new Set<monaco.editor.ITextModel>();

/**
 * Best-effort materialization of a definition target's model. Reads the file
 * (from the workspace or externally) and creates a plain Monaco model so the
 * native hover preview works; errors are swallowed — the Ctrl+click handler
 * surfaces them through the editor store instead.
 */
async function ensureDefinitionModel(path: string): Promise<void> {
  const matched = matchOpenModelCase(path);
  if (findOpenModel(matched)) return;

  const key = matched.replace(/\\/g, "/");
  const uri = monaco.Uri.file(key);
  if (monaco.editor.getModel(uri)) return;

  try {
    let content: string;
    if (isInsideWorkspace(matched)) {
      content = await readFile(matched);
    } else {
      content = await readExternalFile(matched);
    }
    // Re-check: the user may have Ctrl+clicked and opened the target while the
    // read was in flight; creating a second model for the same URI would throw.
    if (monaco.editor.getModel(uri)) return;
    const model = monaco.editor.createModel(
      content,
      languageForPath(key),
      uri,
    );
    previewModels.add(model);
    model.onWillDispose(() => previewModels.delete(model));
  } catch {
    // Unreadable target — nothing to preview, the click path still reports it.
  }
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
  for (const model of previewModels) {
    if (!model.isDisposed()) model.dispose();
  }
  previewModels.clear();
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
  // Only workspace files are sent to rust-analyzer. Preview models created for
  // out-of-workspace targets and read-only external tabs (stdlib sources etc.)
  // stay local to the editor; sending them to the server would be noise.
  if (!isInsideWorkspace(modelPath(model))) return;
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
  if (!isInsideWorkspace(modelPath(model))) return;
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

/** A normalized definition target: an absolute local path plus 1-based x/y. */
interface DefinitionTarget {
  path: string;
  line: number;
  column: number;
}

/** One-slot cache so a Ctrl+hover (provider) and the following Ctrl+click
 *  (mouse handler) at the same position share a single LSP round-trip. */
let definitionCacheKey: string | null = null;
let definitionCacheValue: DefinitionTarget[] | null = null;

/** Resolve `textDocument/definition` for a model position against the live
 *  rust-analyzer session. Returns [] when there is nothing or a failure. */
async function fetchDefinitions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<DefinitionTarget[]> {
  const key = `${model.uri.toString()}:${model.getVersionId()}:${position.lineNumber}:${position.column}`;
  if (definitionCacheKey === key && definitionCacheValue !== null) {
    return definitionCacheValue;
  }
  try {
    const result = await lspRequest("textDocument/definition", {
      textDocument: { uri: uriFor(model) },
      position: monacoPositionToLsp(position.lineNumber, position.column),
    });
    const list = Array.isArray(result) ? result : result ? [result] : [];
    const targets: DefinitionTarget[] = [];
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
    // Only cache a hit; caching an empty result would permanently block a
    // Ctrl+click jump if the first hover raced the server coming up.
    if (targets.length > 0) {
      definitionCacheKey = key;
      definitionCacheValue = targets;
    }
    return targets;
  } catch {
    return [];
  }
}

/** Resolve and open the first definition target of a Ctrl/Cmd+clicked symbol. */
async function jumpToDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<void> {
  const targets = await fetchDefinitions(model, position);
  if (targets.length === 0) return;
  const target = targets[0];
  const path = matchOpenModelCase(target.path);
  await openAndReveal(path, target.line, target.column);
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
      const targets = await fetchDefinitions(model, position);
      if (token.isCancellationRequested || targets.length === 0) return [];

      const paths = targets.map((t) => matchOpenModelCase(t.path));
      // Materialize the first target's model so Monaco's Ctrl+hover preview and
      // the native "1 definition" affordance can resolve the file URI. Opening
      // must NOT happen here: Monaco also invokes this provider on plain
      // Ctrl+mouse-move, and navigating from inside it caused the auto-jump on
      // hover. Navigation is handled by our own Ctrl/Cmd+click mouse handler.
      await ensureDefinitionModel(paths[0]);

      return targets.map((t, i) => ({
        uri: monaco.Uri.file(paths[i]),
        range: new monaco.Range(t.line, t.column, t.line, t.column),
      }));
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

  // Ctrl/Cmd+Left-click navigation. Monaco's native definition click cannot
  // switch an editor to a different file in this single-editor setup, so we
  // hook a minimal native mouse-down that jumps to the resolved target. It only
  // reacts to Ctrl (or Cmd on macOS) + left click on text content; plain hovers
  // and plain clicks keep their default behavior.
  const attachMouseHooks = (editor: monaco.editor.ICodeEditor) => {
    return editor.onMouseDown((e) => {
      if (!e.event.leftButton) return;
      if (!(e.event.ctrlKey || e.event.metaKey)) return;
      if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      const position = e.target.position;
      const model = editor.getModel();
      if (!position || !model || model.isDisposed()) return;
      void jumpToDefinition(model, position);
    });
  };
  monaco.editor.onDidCreateEditor((editor) => {
    attachMouseHooks(editor);
  });
  for (const editor of monaco.editor.getEditors()) {
    attachMouseHooks(editor);
  }

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