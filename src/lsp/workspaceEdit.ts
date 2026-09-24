import * as monaco from "monaco-editor";
import { lspRangeToMonaco, fileUriToPath, type LspRange, type LspTextEdit } from "./protocol";
import { findOpenModel, matchOpenModelCase, isInsideWorkspace } from "./client";
import { useEditorStore } from "../stores/editorStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useUiStore } from "../stores/uiStore";

/**
 * Lightweight LSP `WorkspaceEdit` handling. This is a helper, not a manager: it
 * parses the edit, enforces the workspace boundary, opens the affected files as
 * tabs (so the edits land in real Monaco models and the user keeps undo/dirty
 * state) and applies the text changes. Resource operations (create / rename /
 * delete) are intentionally unsupported.
 */

interface LspTextDocumentEdit {
  textDocument?: { uri?: string; version?: number | null };
  edits?: Array<LspTextEdit | { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange }>;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | { kind?: string }>;
}

interface FileEdits {
  path: string;
  edits: LspTextEdit[];
}

type Parsed =
  | { ok: true; files: FileEdits[] }
  | { ok: false; reason: string };

function normalizeEdit(
  raw: LspTextEdit | { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange },
): LspTextEdit | null {
  const range = (raw as LspTextEdit).range ?? (raw as { replace?: LspRange }).replace ?? (raw as { insert?: LspRange }).insert;
  if (!range || typeof raw.newText !== "string") return null;
  return { range, newText: raw.newText };
}

function parseWorkspaceEdit(edit: LspWorkspaceEdit): Parsed {
  const files: FileEdits[] = [];
  const add = (uri: string | undefined, rawEdits: unknown): boolean => {
    if (!uri) return true;
    const path = fileUriToPath(uri);
    if (!path) return true; // ignore non-file URIs rather than failing hard
    const list = Array.isArray(rawEdits) ? rawEdits : [];
    const edits: LspTextEdit[] = [];
    for (const raw of list) {
      const edit = normalizeEdit(raw);
      if (edit) edits.push(edit);
    }
    if (edits.length > 0) files.push({ path, edits });
    return true;
  };

  if (Array.isArray(edit.documentChanges) && edit.documentChanges.length > 0) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        add(change.textDocument?.uri, change.edits);
      } else {
        return { ok: false, reason: "该操作包含创建/重命名/删除，暂不支持" };
      }
    }
  } else if (edit.changes) {
    for (const [uri, list] of Object.entries(edit.changes)) {
      add(uri, list);
    }
  }

  if (files.some((file) => !isInsideWorkspace(file.path))) {
    return { ok: false, reason: "该操作会修改工作区外的文件，已取消" };
  }
  return { ok: true, files };
}

function toEditOperation(edit: LspTextEdit): monaco.editor.IIdentifiedSingleEditOperation {
  return { range: lspRangeToMonaco(edit.range), text: edit.newText };
}

/**
 * Apply an LSP workspace edit to the editor models. Files are opened as tabs
 * first (preserving any unsaved local content), so edits to files the user had
 * not opened still become visible, dirty, undoable tabs. Returns false when the
 * edit is unsupported, touches files outside the workspace, or the workspace
 * changed while the request was in flight.
 */
export async function applyWorkspaceEdit(edit: LspWorkspaceEdit): Promise<boolean> {
  const parsed = parseWorkspaceEdit(edit);
  if (!parsed.ok) {
    useUiStore.getState().showToast(parsed.reason, "error");
    return false;
  }
  if (parsed.files.length === 0) return false;

  const workspace = useWorkspaceStore.getState().workspacePath;
  const stale = () => useWorkspaceStore.getState().workspacePath !== workspace;

  for (const file of parsed.files) {
    await useEditorStore.getState().openFile(matchOpenModelCase(file.path));
    if (stale()) return false;
  }

  for (const file of parsed.files) {
    if (stale()) return false;
    const model = findOpenModel(file.path);
    if (!model || model.isDisposed()) continue;
    const operations = file.edits
      .map(toEditOperation)
      .sort(
        (a, b) =>
          a.range.startLineNumber - b.range.startLineNumber ||
          a.range.startColumn - b.range.startColumn,
      );
    if (operations.length === 0) continue;
    // pushEditOperations (not applyEdits) keeps the edits on the undo stack.
    model.pushEditOperations([], operations, () => null);
  }
  return true;
}

/**
 * Same parsing/boundary rules as {@link applyWorkspaceEdit}, but returns a
 * Monaco `WorkspaceEdit` for Monaco to apply itself (used by the rename
 * provider so the built-in rename input drives the flow).
 */
export async function buildMonacoWorkspaceEdit(
  edit: LspWorkspaceEdit,
): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
  const parsed = parseWorkspaceEdit(edit);
  if (!parsed.ok) return { edits: [], rejectReason: parsed.reason };

  const workspace = useWorkspaceStore.getState().workspacePath;
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const file of parsed.files) {
    await useEditorStore.getState().openFile(matchOpenModelCase(file.path));
    if (useWorkspaceStore.getState().workspacePath !== workspace) {
      return { edits: [], rejectReason: "工作区已切换，重命名已取消" };
    }
    const model = findOpenModel(file.path);
    const resource = model?.uri ?? monaco.Uri.file(file.path.replace(/\\/g, "/"));
    for (const textEdit of file.edits) {
      edits.push({
        resource,
        versionId: undefined,
        textEdit: { range: lspRangeToMonaco(textEdit.range), text: textEdit.newText },
      });
    }
  }
  return { edits };
}
