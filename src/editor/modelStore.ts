import * as monaco from "monaco-editor";
import "./monacoSetup";
import { languageForPath } from "../utils/language";

interface Tracked {
  model: monaco.editor.ITextModel;
  savedVersion: number;
}

const tracked = new Map<string, Tracked>();

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

export function getModel(path: string): monaco.editor.ITextModel | undefined {
  return tracked.get(norm(path))?.model;
}

export function getTracked(path: string): Tracked | undefined {
  return tracked.get(norm(path));
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

  const entry: Tracked = { model, savedVersion: model.getVersionId() };
  tracked.set(key, entry);

  const listener = model.onDidChangeContent(() => {
    if (model.isDisposed()) {
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

export function disposeModel(path: string) {
  const entry = tracked.get(norm(path));
  if (entry && !entry.model.isDisposed()) {
    entry.model.dispose();
  }
  tracked.delete(norm(path));
}