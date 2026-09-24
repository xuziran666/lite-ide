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
import { canonicalPath, fileKey, isPathInsideWorkspace } from "../utils/pathIdentity";
import {
  pathToFileUri,
  fileUriToPath,
  monacoPositionToLsp,
  monacoRangeToLsp,
  lspRangeToMonaco,
  lspDiagnosticsToMonacoMarkers,
  lspSymbolKindToMonaco,
  lspCompletionKindToMonaco,
  lspTextEditToMonaco,
  monacoMarkerToLspDiagnostic,
  type LspDiagnostic,
  type LspCompletionItem,
  type LspSymbol,
  type LspRange,
  type LspTextEdit,
} from "./protocol";
import { applyWorkspaceEdit, buildMonacoWorkspaceEdit, type LspWorkspaceEdit } from "./workspaceEdit";
import { openAndReveal } from "../utils/reveal";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useUiStore } from "../stores/uiStore";
import { useConfigStore } from "../stores/configStore";
import { useSearchStore, type ReferenceItem } from "../stores/searchStore";
import {
  LSP_LANGUAGES,
  LSP_MONACO_SELECTOR,
  LSP_TRIGGER_CHARACTERS,
  languageById,
  languageForModel,
  serverCommand,
  type LspLanguage,
} from "./languages";

/**
 * Built-in LSP client, shared by every language (rust-analyzer, clangd and
 * typescript-language-server). One server per language per workspace, started
 * lazily when the first file of that language opens and stopped on workspace
 * switch, app exit, or when the last file of that language closes.
 *
 * A single set of Monaco providers is registered for all served languages and
 * dispatches to the right server based on the model's language — no per-language
 * provider duplication. The servers speak through the standard
 * `monaco.languages` provider APIs only.
 */

const MARKER_OWNER = "lsp";
const CHANGE_DEBOUNCE_MS = 150;

/** Text-document state: the live model plus its debounced change listener. */
interface OpenDoc {
  model: monaco.editor.ITextModel;
  listener: monaco.IDisposable;
  language: string;
}

/** Open documents, keyed by their LSP file URI. */
const docs = new Map<string, OpenDoc>();
/** Debounce timers per document URI. */
const changeTimers = new Map<string, number>();
/** Client-side ids of languages whose server is currently live. */
const activeLanguages = new Set<string>();
/** Serializes `ensureServer` so two models opening at once start once. */
const startGates = new Map<string, Promise<boolean>>();

/**
 * Plain Monaco models created for definition-target hover previews. They are
 * not tracked by the model store and live only until their language's session
 * resets (read-only placeholders so Monaco's Ctrl+hover preview and click can
 * resolve the target's file URI). Once the user actually jumps to a target the
 * editor store re-reads the file and takes ownership of the model.
 */
const previewModels = new Set<monaco.editor.ITextModel>();

/**
 * The `initialize` capabilities reported by each running server, keyed by
 * language id. Used to skip requests a server does not support (a missing entry
 * means "not started yet" and the request is attempted, failing gracefully).
 */
const serverCapabilities = new Map<string, Record<string, unknown>>();

/** Whether a language's server advertises a capability (unknown => try it). */
export function serverSupports(languageId: string, capability: string): boolean {
  const capabilities = serverCapabilities.get(languageId);
  if (!capabilities) return true;
  return Boolean(capabilities[capability]);
}

/** Non-ASCII-safe canonical key for a workspace-backed model path. Delegates to
 *  the shared file identity so tree paths, LSP URIs and relative paths all
 *  collapse to the same key (see `utils/pathIdentity.ts`). */
function normalizePathKey(path: string): string {
  return canonicalPath(path);
}

/** The model-store-style path key for a model, derived from its URI. */
function modelPath(model: monaco.editor.ITextModel): string {
  return normalizePathKey(
    fileUriToPath(model.uri.toString()) ?? model.uri.toString(),
  );
}

function uriFor(model: monaco.editor.ITextModel): string {
  return pathToFileUri(modelPath(model));
}

export function findOpenModel(path: string): monaco.editor.ITextModel | undefined {
  const needle = fileKey(path);
  for (const { model } of docs.values()) {
    if (fileKey(modelPath(model)) === needle) {
      return model;
    }
  }
  return monaco.editor
    .getModels()
    .find((m) => languageForModel(m) !== undefined && fileKey(modelPath(m)) === needle);
}

/**
 * Windows path matching is case-insensitive (LSP servers normalize the drive
 * letter to lowercase, opened models keep the original case). Return the
 * canonical path of an already-open model so we never create a second tab for
 * the same physical file.
 */
export function matchOpenModelCase(path: string): string {
  const model = findOpenModel(path);
  if (!model) return normalizePathKey(path);
  return normalizePathKey(modelPath(model));
}

/** Whether a path belongs to the currently opened workspace. */
export function isInsideWorkspace(path: string): boolean {
  return isPathInsideWorkspace(path, useWorkspaceStore.getState().workspacePath);
}

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
    const model = monaco.editor.createModel(content, languageForPath(key), uri);
    previewModels.add(model);
    model.onWillDispose(() => previewModels.delete(model));
  } catch {
    // Unreadable target — nothing to preview, the click path still reports it.
  }
}

/** Start a language's session if it isn't running yet. Resolves true when ready. */
async function ensureServer(
  language: LspLanguage,
  triggerPath: string,
): Promise<boolean> {
  if (activeLanguages.has(language.id)) return true;
  const gate = startGates.get(language.id);
  if (gate) return gate;

  const start = (async () => {
    try {
      const result = await lspStart(language.id, triggerPath, serverCommand(language));
      if (result.capabilities && typeof result.capabilities === "object") {
        serverCapabilities.set(
          language.id,
          result.capabilities as Record<string, unknown>,
        );
      }
      activeLanguages.add(language.id);
      return true;
    } catch (err) {
      // Allow a retry the next time a file of this language opens.
      startGates.delete(language.id);
      useUiStore
        .getState()
        .showToast(`无法启动 ${language.serverLabel}: ${String(err)}`, "error");
      return false;
    }
  })();

  startGates.set(language.id, start);
  return start;
}

/** How many documents of a language are currently open. */
function openDocCount(languageId: string): number {
  let count = 0;
  for (const doc of docs.values()) {
    if (doc.language === languageId) count += 1;
  }
  return count;
}

/** Drop one language's document references, previews and markers (stopped/exited). */
function resetLanguage(language: LspLanguage): void {
  activeLanguages.delete(language.id);
  startGates.delete(language.id);
  serverCapabilities.delete(language.id);

  for (const [uri, doc] of [...docs]) {
    if (doc.language !== language.id) continue;
    doc.listener.dispose();
    docs.delete(uri);
    window.clearTimeout(changeTimers.get(uri));
    changeTimers.delete(uri);
  }

  for (const model of [...previewModels]) {
    if (languageForModel(model)?.id === language.id && !model.isDisposed()) {
      model.dispose();
    }
  }

  for (const model of monaco.editor.getModels()) {
    if (languageForModel(model)?.id === language.id) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    }
  }
}

/** Reset every language (workspace switch / shutdown). */
function resetAllLanguages(): void {
  for (const language of LSP_LANGUAGES) {
    resetLanguage(language);
  }
}

function attachChangeListener(
  model: monaco.editor.ITextModel,
  uri: string,
  languageId: string,
): monaco.IDisposable {
  return model.onDidChangeContent(() => {
    if (model.isDisposed()) return;
    window.clearTimeout(changeTimers.get(uri));
    const timer = window.setTimeout(() => {
      changeTimers.delete(uri);
      void pushChanges(model, uri, languageId);
    }, CHANGE_DEBOUNCE_MS);
    changeTimers.set(uri, timer);
  });
}

async function pushChanges(
  model: monaco.editor.ITextModel,
  uri: string,
  languageId: string,
): Promise<void> {
  if (model.isDisposed() || !docs.has(uri)) return;
  try {
    await lspNotify(languageId, "textDocument/didChange", {
      textDocument: { uri, version: model.getVersionId() },
      contentChanges: [{ text: model.getValue() }],
    });
  } catch {
    // The server may have died mid-edit; the exit toast already explains it.
  }
}

/**
 * Send any debounced `didChange` for a model right away. Monaco's parameter
 * hints fire ~120ms after typing, which is faster than the 150ms change
 * debounce, so without this the server would answer `signatureHelp` against a
 * stale document (missing the `(` / `,` just typed) and return nothing.
 */
async function flushPendingChanges(
  model: monaco.editor.ITextModel,
  languageId: string,
): Promise<void> {
  const uri = uriFor(model);
  const timer = changeTimers.get(uri);
  if (timer === undefined) return;
  window.clearTimeout(timer);
  changeTimers.delete(uri);
  await pushChanges(model, uri, languageId);
}

/** Send `didOpen` for a new served model (idempotent per URI). */
async function openDocModel(model: monaco.editor.ITextModel): Promise<void> {
  const language = languageForModel(model);
  if (!language) return;
  // Only workspace files are sent to the servers. Preview models created for
  // out-of-workspace targets and read-only external tabs (stdlib sources etc.)
  // stay local to the editor; sending them to a server would be noise.
  if (!isInsideWorkspace(modelPath(model))) return;

  const uri = uriFor(model);
  if (docs.has(uri)) return;

  const ok = await ensureServer(language, modelPath(model));
  if (!ok || docs.has(uri)) return;

  const listener = attachChangeListener(model, uri, language.id);
  docs.set(uri, { model, listener, language: language.id });
  try {
    await lspNotify(language.id, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
  } catch {
    docs.delete(uri);
    listener.dispose();
  }
}

/** Send `didClose` and stop a language's server when no files of it remain. */
function closeDocModel(model: monaco.editor.ITextModel): void {
  const language = languageForModel(model);
  if (!language) return;
  if (!isInsideWorkspace(modelPath(model))) return;

  const uri = uriFor(model);
  const doc = docs.get(uri);
  if (doc) {
    window.clearTimeout(changeTimers.get(uri));
    changeTimers.delete(uri);
    doc.listener.dispose();
    docs.delete(uri);
  }
  void lspNotify(language.id, "textDocument/didClose", {
    textDocument: { uri },
  }).catch(() => {});
  if (openDocCount(language.id) === 0 && activeLanguages.has(language.id)) {
    void lspStop(language.id)
      .then(() => resetLanguage(language))
      .catch((err) =>
        useUiStore
          .getState()
          .showToast(`停止 ${language.serverLabel} 失败: ${String(err)}`, "error"),
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
    const value =
      doc.language && doc.value
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

/** Resolve `textDocument/definition` for a model position against the serving
 *  language's session. Returns [] when there is nothing or a failure. */
async function fetchDefinitions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<DefinitionTarget[]> {
  const language = languageForModel(model);
  if (!language) return [];

  const key = `${model.uri.toString()}:${model.getVersionId()}:${position.lineNumber}:${position.column}`;
  if (definitionCacheKey === key && definitionCacheValue !== null) {
    return definitionCacheValue;
  }
  try {
    const result = await lspRequest(language.id, "textDocument/definition", {
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

// --- Phase 12: capabilities, references, rename, signature, code actions, formatting ---

interface LspParameterInformation {
  label: string | [number, number];
  documentation?: string | { value?: string };
}

interface LspSignatureInformation {
  label: string;
  documentation?: string | { value?: string };
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}

interface LspSignatureHelp {
  signatures?: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

interface LspCommand {
  title?: string;
  command: string;
  arguments?: unknown[];
}

interface LspCodeAction {
  title?: string;
  kind?: string;
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  isPreferred?: boolean;
  disabled?: { reason?: string } | string;
}

/** Monaco code-action command id; the handler applies the LSP payload. */
const CODE_ACTION_COMMAND = "liteide.applyCodeAction";

/** One LSP location/{{LocationLink}} as a Monaco location (null when unusable). */
function toMonacoLocation(
  loc: LspLocation,
): monaco.languages.Location | null {
  const uri = loc.uri ?? loc.targetUri;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  const path = uri ? fileUriToPath(uri) : undefined;
  if (!path || !range) return null;
  return {
    uri: monaco.Uri.file(matchOpenModelCase(path)),
    range: lspRangeToMonaco(range),
  };
}

/** Hover/signature documentation value -> Monaco markdown (or undefined). */
function toMarkdownString(
  value: string | { value?: string } | undefined,
): monaco.IMarkdownString | undefined {
  if (typeof value === "string") return { value, isTrusted: false };
  if (value && typeof value.value === "string") {
    return { value: value.value, isTrusted: false };
  }
  return undefined;
}

/** A rename rejection carrying only a reason (Monaco checks `rejectReason`). */
function renameRejection(
  reason: string,
): monaco.languages.RenameLocation & monaco.languages.Rejection {
  return { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: reason };
}

/** Word-under-cursor fallback when the server has no prepareRename support. */
function wordRenameLocation(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): monaco.languages.RenameLocation & monaco.languages.Rejection {
  const word = model.getWordAtPosition(position);
  if (!word) return renameRejection("该位置没有可重命名的符号");
  return {
    range: new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    ),
    text: word.word,
  };
}

/** Formatting options: prefer the app's editor settings over Monaco's. */
function formattingOptions(
  options: monaco.languages.FormattingOptions,
): { tabSize: number; insertSpaces: boolean } {
  const editor = useConfigStore.getState().editor as
    | { tabSize?: number; insertSpaces?: boolean }
    | undefined;
  return {
    tabSize:
      typeof editor?.tabSize === "number" ? editor.tabSize : options.tabSize,
    insertSpaces:
      typeof editor?.insertSpaces === "boolean"
        ? editor.insertSpaces
        : options.insertSpaces ?? true,
  };
}

/** Run an LSP `workspace/executeCommand`; apply a returned WorkspaceEdit. */
async function executeLspCommand(
  languageId: string,
  command: LspCommand,
): Promise<void> {
  if (!languageById(languageId)) return;
  try {
    const result = await lspRequest(languageId, "workspace/executeCommand", {
      command: command.command,
      arguments: command.arguments ?? [],
    });
    if (
      result &&
      typeof result === "object" &&
      ("changes" in (result as object) || "documentChanges" in (result as object))
    ) {
      await applyWorkspaceEdit(result as LspWorkspaceEdit);
    }
  } catch (err) {
    useUiStore
      .getState()
      .showToast(`执行命令失败: ${String(err)}`, "error");
  }
}

/** Apply a code action's edit (if any) then run its command (if any). */
async function runCodeAction(
  languageId: string,
  edit: LspWorkspaceEdit | null,
  command: LspCommand | null,
): Promise<void> {
  if (edit) await applyWorkspaceEdit(edit);
  if (command) await executeLspCommand(languageId, command);
}

/** Wrap one LSP CodeAction/Command so accepting it runs through our applier. */
function toMonacoCodeAction(
  languageId: string,
  raw: LspCodeAction,
): monaco.languages.CodeAction | null {
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const edit = raw.edit ?? null;
  const command = raw.command ?? null;
  if (!title || (!edit && !command)) return null;

  const action: monaco.languages.CodeAction = {
    title,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    isPreferred: raw.isPreferred === true ? true : undefined,
    command: {
      id: CODE_ACTION_COMMAND,
      title,
      arguments: [languageId, edit, command],
    },
  };
  if (raw.disabled) {
    action.disabled =
      typeof raw.disabled === "string"
        ? raw.disabled
        : raw.disabled.reason ?? "不可用";
  }
  return action;
}

/** Whether any Monaco editor currently owns keyboard focus. */
export function editorHasTextFocus(): boolean {
  return monaco.editor.getEditors()[0]?.hasTextFocus() ?? false;
}

/** F2: run Monaco's rename (which drives the registered rename provider). */
export function runRenameAction(): void {
  void monaco.editor.getEditors()[0]?.getAction("editor.action.rename")?.run();
}

/** Ctrl+. : open Monaco's quick-fix widget (drives our code-action provider). */
export function runCodeActionAction(): void {
  void monaco.editor.getEditors()[0]?.getAction("editor.action.quickFix")?.run();
}

/** Ctrl+Shift+Space: trigger Monaco's native parameter-hints widget. */
export function runSignatureHelpAction(): void {
  void monaco.editor
    .getEditors()[0]
    ?.getAction("editor.action.triggerParameterHints")
    ?.run();
}

/** Ctrl/Cmd+Y: delete the current line (or the selected lines) via Monaco. */
export function runDeleteLineAction(): void {
  void monaco.editor
    .getEditors()[0]
    ?.getAction("editor.action.deleteLines")
    ?.run();
}

/** Shift+Alt+F: format the document, with a clear notice when unsupported. */
export function runFormatDocumentAction(): void {
  const editor = monaco.editor.getEditors()[0];
  const model = editor?.getModel();
  const language = model ? languageForModel(model) : undefined;
  if (
    language &&
    serverSupports(language.id, "documentFormattingProvider") === false
  ) {
    useUiStore
      .getState()
      .showToast("Formatting is not supported by the language server", "error");
    return;
  }
  void editor?.getAction("editor.action.formatDocument")?.run();
}

/**
 * Shift+F12: resolve references for the symbol under the cursor and show them
 * in the secondary sidebar. Falls back to a plain notice when the language or
 * server has no reference support.
 */
export async function findReferencesAtCursor(): Promise<void> {
  const editor = monaco.editor.getEditors()[0];
  const model = editor?.getModel();
  const position = editor?.getPosition();
  if (!editor || !model || !position) return;

  const language = languageForModel(model);
  if (!language) {
    useUiStore.getState().showToast("No references available", "error");
    return;
  }
  if (serverSupports(language.id, "referencesProvider") === false) {
    useUiStore.getState().showToast("No references available", "error");
    return;
  }

  const search = useSearchStore.getState();
  search.beginReferences(model.getWordAtPosition(position)?.word ?? "");
  const workspace = useWorkspaceStore.getState().workspacePath;

  try {
    const result = await lspRequest(language.id, "textDocument/references", {
      textDocument: { uri: uriFor(model) },
      position: monacoPositionToLsp(position.lineNumber, position.column),
      context: { includeDeclaration: true },
    });
    if (useWorkspaceStore.getState().workspacePath !== workspace) return;
    const items: ReferenceItem[] = [];
    if (Array.isArray(result)) {
      for (const raw of result) {
        const loc = raw as LspLocation;
        const uri = loc.uri ?? loc.targetUri;
        const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
        const path = uri ? fileUriToPath(uri) : undefined;
        if (!path || !range) continue;
        const line = range.start.line + 1;
        const column = range.start.character + 1;
        const target = findOpenModel(path);
        const preview =
          target && !target.isDisposed()
            ? (target.getLineContent(line) ?? "").trim()
            : "";
        items.push({ path, line, column, preview });
      }
    }
    useSearchStore.getState().finishReferences(items);
  } catch {
    if (useWorkspaceStore.getState().workspacePath !== workspace) return;
    useSearchStore.getState().finishReferences([]);
  }
}

// --- Registration ----------------------------------------------------------

let registered = false;

/** Wire every language server into Monaco (idempotent; called once). */
export function registerLspClient(): void {
  if (registered) return;
  registered = true;

  monaco.editor.onDidCreateModel((model) => {
    if (languageForModel(model)) {
      void openDocModel(model);
    }
  });
  monaco.editor.onWillDisposeModel((model) => {
    if (languageForModel(model)) {
      closeDocModel(model);
    }
  });

  monaco.languages.registerCompletionItemProvider(LSP_MONACO_SELECTOR, {
    triggerCharacters: LSP_TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, context, token) {
      const language = languageForModel(model);
      if (!language) return { suggestions: [] };

      const suggestions: monaco.languages.CompletionItem[] = [];
      try {
        const result = await lspRequest(language.id, "textDocument/completion", {
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

  monaco.languages.registerHoverProvider(LSP_MONACO_SELECTOR, {
    async provideHover(model, position, token) {
      const language = languageForModel(model);
      if (!language) return null;
      try {
        const result = await lspRequest(language.id, "textDocument/hover", {
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
              value:
                markdown.language && markdown.value
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

  monaco.languages.registerDefinitionProvider(LSP_MONACO_SELECTOR, {
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

  monaco.languages.registerDocumentSymbolProvider(LSP_MONACO_SELECTOR, {
    displayName: "lsp",
    async provideDocumentSymbols(model, token) {
      const language = languageForModel(model);
      if (!language) return [];
      const fallback = language.fallbackDocumentSymbols;
      try {
        const result = await lspRequest(
          language.id,
          "textDocument/documentSymbol",
          { textDocument: { uri: uriFor(model) } },
        );
        if (token.isCancellationRequested) return [];
        const symbols = Array.isArray(result) ? (result as LspSymbol[]) : [];
        if (symbols.length === 0) return fallback ? fallback(model) : [];
        return toDocumentSymbols(symbols);
      } catch {
        // Server unavailable — keep the Outline useful via the local fallback.
        return fallback ? fallback(model) : [];
      }
    },
  });

  // Find References (Shift+F12). Registered so Monaco's own peek works too;
  // our sidebar flow goes through `findReferencesAtCursor`.
  monaco.languages.registerReferenceProvider(LSP_MONACO_SELECTOR, {
    async provideReferences(model, position, context, token) {
      const language = languageForModel(model);
      if (!language) return [];
      if (serverSupports(language.id, "referencesProvider") === false) return [];
      try {
        const result = await lspRequest(language.id, "textDocument/references", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
          context: { includeDeclaration: context.includeDeclaration },
        });
        if (token.isCancellationRequested || !Array.isArray(result)) return [];
        return (result as LspLocation[])
          .map(toMonacoLocation)
          .filter((loc): loc is monaco.languages.Location => loc !== null);
      } catch {
        return [];
      }
    },
  });

  // Rename (F2). Monaco's built-in rename input drives this; the provider
  // returns a Monaco WorkspaceEdit whose resources are the real open models
  // (the file is opened first so multi-file renames work).
  monaco.languages.registerRenameProvider(LSP_MONACO_SELECTOR, {
    async resolveRenameLocation(model, position, token) {
      const language = languageForModel(model);
      if (!language) return null;
      if (serverSupports(language.id, "renameProvider") === false) {
        return renameRejection("Rename is not supported by the language server");
      }
      try {
        const result = await lspRequest(language.id, "textDocument/prepareRename", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
        });
        if (token.isCancellationRequested) return null;
        if (!result) return wordRenameLocation(model, position);
        const info = result as { range?: LspRange; placeholder?: string };
        if (!info.range) return wordRenameLocation(model, position);
        const range = lspRangeToMonaco(info.range);
        return {
          range,
          text: info.placeholder ?? model.getValueInRange(range),
        };
      } catch {
        // prepareRename unsupported: fall back to the word under the cursor.
        return wordRenameLocation(model, position);
      }
    },
    async provideRenameEdits(model, position, newName, token) {
      const language = languageForModel(model);
      if (!language) return { edits: [], rejectReason: "当前文件不支持重命名" };
      if (serverSupports(language.id, "renameProvider") === false) {
        return { edits: [], rejectReason: "Rename is not supported by the language server" };
      }
      try {
        const result = await lspRequest(language.id, "textDocument/rename", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
          newName,
        });
        if (token.isCancellationRequested) return null;
        if (!result) return { edits: [] };
        return await buildMonacoWorkspaceEdit(result as LspWorkspaceEdit);
      } catch (err) {
        return { edits: [], rejectReason: String(err) };
      }
    },
  });

  // Signature Help: auto-triggered on "(" and ",".
  monaco.languages.registerSignatureHelpProvider(LSP_MONACO_SELECTOR, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position, token, context) {
      const language = languageForModel(model);
      if (!language) return null;
      if (serverSupports(language.id, "signatureHelpProvider") === false) return null;
      try {
        // Sync the just-typed trigger character before asking the server.
        await flushPendingChanges(model, language.id);
        const result = await lspRequest(language.id, "textDocument/signatureHelp", {
          textDocument: { uri: uriFor(model) },
          position: monacoPositionToLsp(position.lineNumber, position.column),
          context: {
            triggerKind: context.triggerKind,
            triggerCharacter: context.triggerCharacter ?? null,
            isRetrigger: context.isRetrigger,
            activeSignatureHelp: context.activeSignatureHelp ?? null,
          },
        });
        if (token.isCancellationRequested || !result) return null;
        const help = result as LspSignatureHelp;
        const signatures = Array.isArray(help.signatures) ? help.signatures : [];
        if (signatures.length === 0) return null;
        const value: monaco.languages.SignatureHelp = {
          signatures: signatures.map((signature) => ({
            label: signature.label,
            documentation: toMarkdownString(signature.documentation),
            parameters: (signature.parameters ?? []).map((parameter) => ({
              label: parameter.label,
              documentation: toMarkdownString(parameter.documentation),
            })),
            activeParameter: signature.activeParameter,
          })),
          activeSignature:
            typeof help.activeSignature === "number" ? help.activeSignature : 0,
          activeParameter:
            typeof help.activeParameter === "number" ? help.activeParameter : 0,
        };
        return { value, dispose() {} };
      } catch {
        return null;
      }
    },
  });

  // Code Actions (Ctrl+.). Every action is wrapped as a Monaco command that
  // applies the edit through `applyWorkspaceEdit` / `workspace/executeCommand`.
  monaco.languages.registerCodeActionProvider(LSP_MONACO_SELECTOR, {
    async provideCodeActions(model, range, context, token) {
      const language = languageForModel(model);
      if (!language) return { actions: [], dispose() {} };
      if (serverSupports(language.id, "codeActionProvider") === false) {
        return { actions: [], dispose() {} };
      }
      try {
        const result = await lspRequest(language.id, "textDocument/codeAction", {
          textDocument: { uri: uriFor(model) },
          range: monacoRangeToLsp(range),
          context: {
            diagnostics: context.markers.map(monacoMarkerToLspDiagnostic),
            only: context.only ? [context.only] : undefined,
            triggerKind: context.trigger,
          },
        });
        if (token.isCancellationRequested || !Array.isArray(result)) {
          return { actions: [], dispose() {} };
        }
        const actions: monaco.languages.CodeAction[] = [];
        for (const raw of result as LspCodeAction[]) {
          const action = toMonacoCodeAction(language.id, raw);
          if (action) actions.push(action);
        }
        return { actions, dispose() {} };
      } catch {
        return { actions: [], dispose() {} };
      }
    },
  });

  // Formatting (Shift+Alt+F) and range formatting.
  monaco.languages.registerDocumentFormattingEditProvider(LSP_MONACO_SELECTOR, {
    displayName: "lsp",
    async provideDocumentFormattingEdits(model, options, token) {
      const language = languageForModel(model);
      if (!language) return null;
      if (serverSupports(language.id, "documentFormattingProvider") === false) return null;
      try {
        const result = await lspRequest(language.id, "textDocument/formatting", {
          textDocument: { uri: uriFor(model) },
          options: formattingOptions(options),
        });
        if (token.isCancellationRequested || !Array.isArray(result)) return null;
        return (result as LspTextEdit[]).map(lspTextEditToMonaco);
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(LSP_MONACO_SELECTOR, {
    displayName: "lsp",
    async provideDocumentRangeFormattingEdits(model, range, options, token) {
      const language = languageForModel(model);
      if (!language) return null;
      if (serverSupports(language.id, "documentRangeFormattingProvider") === false) return null;
      try {
        const result = await lspRequest(language.id, "textDocument/rangeFormatting", {
          textDocument: { uri: uriFor(model) },
          range: monacoRangeToLsp(range),
          options: formattingOptions(options),
        });
        if (token.isCancellationRequested || !Array.isArray(result)) return null;
        return (result as LspTextEdit[]).map(lspTextEditToMonaco);
      } catch {
        return null;
      }
    },
  });

  monaco.editor.registerCommand(
    CODE_ACTION_COMMAND,
    (
      _accessor: unknown,
      languageId: string,
      edit: LspWorkspaceEdit | null,
      command: LspCommand | null,
    ) => {
      void runCodeAction(languageId, edit, command);
    },
  );

  void listen<{
    language: string;
    path: string;
    diagnostics: LspDiagnostic[];
  }>("lsp-diagnostics", (event) => {
    const { language, path, diagnostics } = event.payload;
    const model = findOpenModel(path);
    if (!model || model.isDisposed()) return;
    // Ignore diagnostics addressed to a different language's model.
    if (languageForModel(model)?.id !== language) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      lspDiagnosticsToMonacoMarkers(diagnostics),
    );
  });

  void listen<{ language: string; message?: string }>("lsp-exited", (event) => {
    const { language, message } = event.payload;
    if (!activeLanguages.has(language)) return;
    const descriptor = languageById(language);
    if (descriptor) resetLanguage(descriptor);
    useUiStore
      .getState()
      .showToast(
        `${descriptor?.serverLabel ?? language} 已退出: ${message ?? "未知原因"}`,
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
      if (!languageForModel(model)) return;
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
  // lsp/client), so subscribing eagerly would hit the TDZ. A microtask runs
  // after the whole module graph has finished evaluating.
  queueMicrotask(() => {
    useWorkspaceStore.subscribe((state, prevState) => {
      if (state.workspacePath !== prevState.workspacePath) {
        resetAllLanguages();
      }
    });
  });

  // Models created before this module registered (defensive; normally none).
  for (const model of monaco.editor.getModels()) {
    if (languageForModel(model)) {
      void openDocModel(model);
    }
  }
}
