import * as monaco from "monaco-editor";
import "./monacoSetup";
import { languageForPath } from "../utils/language";
import { canonicalPath, fileKey } from "../utils/pathIdentity";

interface Tracked {
  /** Canonical (case-preserving) path, used for the Monaco URI and display. */
  path: string;
  model: monaco.editor.ITextModel;
  savedVersion: number;
  suppressChange: boolean;
}

const tracked = new Map<string, Tracked>();

/** Models are keyed by the case-insensitive canonical identity (so the same
 *  physical file can never own two models) while their URI is built from the
 *  case-preserving canonical path. */
function norm(path: string): string {
  return canonicalPath(path);
}

function key(path: string): string {
  return fileKey(path);
}

export function getModel(path: string): monaco.editor.ITextModel | undefined {
  return tracked.get(key(path))?.model;
}

/** Reverse lookup: the canonical path owning a live model, if any. */
export function pathForModel(
  model: monaco.editor.ITextModel,
): string | undefined {
  for (const entry of tracked.values()) {
    if (entry.model === model) return entry.path;
  }
  return undefined;
}

export function getTracked(path: string): Tracked | undefined {
  return tracked.get(key(path));
}

export function isDirty(path: string): boolean {
  const entry = tracked.get(key(path));
  return (
    !!entry &&
    !entry.model.isDisposed() &&
    entry.model.getVersionId() !== entry.savedVersion
  );
}

export function createModel(
  path: string,
  content: string,
  onChange: (dirty: boolean) => void,
): monaco.editor.ITextModel {
  const canonical = norm(path);
  const mapKey = key(path);
  const existing = tracked.get(mapKey);
  if (existing) {
    return existing.model;
  }

  const uri = monaco.Uri.file(canonical);
  const prior = monaco.editor.getModel(uri);
  if (prior) {
    prior.dispose();
  }

  const model = monaco.editor.createModel(
    content,
    languageForPath(canonical),
    uri,
  );

  const entry: Tracked = {
    path: canonical,
    model,
    savedVersion: model.getVersionId(),
    suppressChange: false,
  };
  tracked.set(mapKey, entry);

  const listener = model.onDidChangeContent(() => {
    if (entry.suppressChange || model.isDisposed()) {
      return;
    }
    onChange(model.getVersionId() !== entry.savedVersion);
  });

  model.onWillDispose(() => {
    listener.dispose();
    tracked.delete(mapKey);
  });

  return model;
}

/** Advance the saved baseline to `version`, defaulting to the current one.
 *  Pass the version that was actually written so that edits made while the
 *  write was in flight remain dirty and get picked up by the next save. */
export function markSaved(path: string, version?: number) {
  const entry = tracked.get(key(path));
  if (entry && !entry.model.isDisposed()) {
    entry.savedVersion = version ?? entry.model.getVersionId();
  }
}

/** Reload a model's content from disk without marking it dirty. */
export function setModelContent(path: string, content: string) {
  const entry = tracked.get(key(path));
  if (!entry || entry.model.isDisposed()) return;
  entry.suppressChange = true;
  entry.model.setValue(content);
  entry.suppressChange = false;
  entry.savedVersion = entry.model.getVersionId();
}

/** Remap a model to a new path after an external rename, preserving dirtiness. */
export function rekeyPath(
  path: string,
  newPath: string,
  onChange: (dirty: boolean) => void,
) {
  const oldKey = key(path);
  const entry = tracked.get(oldKey);
  if (!entry || entry.model.isDisposed()) return;
  const newKey = key(newPath);
  if (oldKey === newKey) return;

  const content = entry.model.getValue();
  const dirty = entry.model.getVersionId() !== entry.savedVersion;

  entry.model.dispose();
  tracked.delete(oldKey);

  createModel(newPath, content, onChange);
  const newEntry = tracked.get(newKey);
  if (newEntry) {
    newEntry.savedVersion = newEntry.model.getVersionId() - (dirty ? 1 : 0);
  }
}

export function disposeModel(path: string) {
  const mapKey = key(path);
  const entry = tracked.get(mapKey);
  if (entry && !entry.model.isDisposed()) {
    entry.model.dispose();
  }
  tracked.delete(mapKey);
}