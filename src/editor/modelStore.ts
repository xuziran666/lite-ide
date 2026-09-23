import * as monaco from "monaco-editor";
import "./monacoSetup";
import { languageForPath } from "../utils/language";

interface Tracked {
  model: monaco.editor.ITextModel;
  savedVersion: number;
  suppressChange: boolean;
}

const tracked = new Map<string, Tracked>();

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

export function getModel(path: string): monaco.editor.ITextModel | undefined {
  return tracked.get(norm(path))?.model;
}

/** Reverse lookup: the normalized path owning a live model, if any. */
export function pathForModel(
  model: monaco.editor.ITextModel,
): string | undefined {
  for (const [key, entry] of tracked) {
    if (entry.model === model) return key;
  }
  return undefined;
}

export function getTracked(path: string): Tracked | undefined {
  return tracked.get(norm(path));
}

export function isDirty(path: string): boolean {
  const entry = tracked.get(norm(path));
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
  const key = norm(path);
  const existing = tracked.get(key);
  if (existing) {
    return existing.model;
  }

  const uri = monaco.Uri.file(key);
  const prior = monaco.editor.getModel(uri);
  if (prior) {
    prior.dispose();
  }

  const model = monaco.editor.createModel(
    content,
    languageForPath(key),
    uri,
  );

  const entry: Tracked = {
    model,
    savedVersion: model.getVersionId(),
    suppressChange: false,
  };
  tracked.set(key, entry);

  const listener = model.onDidChangeContent(() => {
    if (entry.suppressChange || model.isDisposed()) {
      return;
    }
    onChange(model.getVersionId() !== entry.savedVersion);
  });

  model.onWillDispose(() => {
    listener.dispose();
    tracked.delete(key);
  });

  return model;
}

export function markSaved(path: string) {
  const entry = tracked.get(norm(path));
  if (entry && !entry.model.isDisposed()) {
    entry.savedVersion = entry.model.getVersionId();
  }
}

/** Reload a model's content from disk without marking it dirty. */
export function setModelContent(path: string, content: string) {
  const entry = tracked.get(norm(path));
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
  const key = norm(path);
  const entry = tracked.get(key);
  if (!entry || entry.model.isDisposed()) return;
  const newKey = norm(newPath);
  if (key === newKey) return;

  const content = entry.model.getValue();
  const dirty = entry.model.getVersionId() !== entry.savedVersion;

  entry.model.dispose();
  tracked.delete(key);

  createModel(newPath, content, onChange);
  const newEntry = tracked.get(newKey);
  if (newEntry) {
    newEntry.savedVersion = newEntry.model.getVersionId() - (dirty ? 1 : 0);
  }
}

export function disposeModel(path: string) {
  const entry = tracked.get(norm(path));
  if (entry && !entry.model.isDisposed()) {
    entry.model.dispose();
  }
  tracked.delete(norm(path));
}