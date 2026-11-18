import { monaco } from "./monaco";
import { fsApi } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";

/** Alternative version id of each model at its last load or save. */
const savedVersions = new Map<string, number>();
const pending = new Map<string, Promise<monaco.editor.ITextModel>>();
/** File path of each model, by URI: `Uri.fsPath` does not keep the original drive letter case. */
const paths = new Map<string, string>();

export function getModel(path: string) {
  return monaco.editor.getModel(monaco.Uri.file(path));
}

function isDirty(path: string, model: monaco.editor.ITextModel) {
  return model.getAlternativeVersionId() !== savedVersions.get(path);
}

function createModel(path: string, text: string, dirty: boolean) {
  // The language is inferred from the file name, including languages
  // contributed by extensions.
  const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(path));
  paths.set(model.uri.toString(), path);
  model.onWillDispose(() => paths.delete(model.uri.toString()));
  // A version id that never occurs keeps the model dirty until saved.
  savedVersions.set(path, dirty ? -1 : model.getAlternativeVersionId());
  model.onDidChangeContent(() => {
    useWorkspace.getState().setDirty(path, isDirty(path, model));
  });
  return model;
}

/** The file path a model was opened from, or undefined for other models (e.g. diff originals). */
export function modelPath(model: monaco.editor.ITextModel): string | undefined {
  return paths.get(model.uri.toString());
}

export function loadModel(path: string): Promise<monaco.editor.ITextModel> {
  const existing = getModel(path);
  if (existing) return Promise.resolve(existing);

  let promise = pending.get(path);
  if (!promise) {
    promise = fsApi
      .readTextFile(path)
      .then((text) => createModel(path, text, false))
      .finally(() => pending.delete(path));
    pending.set(path, promise);
  }
  return promise;
}

const saveListeners = new Set<(path: string, model: monaco.editor.ITextModel) => void>();

/** Calls `listener` after a model is saved to disk; returns the unsubscribe function. */
export function onDidSaveModel(listener: (path: string, model: monaco.editor.ITextModel) => void) {
  saveListeners.add(listener);
  return () => void saveListeners.delete(listener);
}

export async function saveModel(path: string) {
  const model = getModel(path);
  if (!model) return;
  const version = model.getAlternativeVersionId();
  await fsApi.writeTextFile(path, model.getValue());
  savedVersions.set(path, version);
  useWorkspace.getState().setDirty(path, isDirty(path, model));
  saveListeners.forEach((listener) => listener(path, model));
}

/** Moves an open model to the file's new path, keeping unsaved edits. */
export function moveModel(from: string, to: string) {
  const model = getModel(from);
  if (!model) return;
  createModel(to, model.getValue(), isDirty(from, model));
  disposeModel(from);
}

export function disposeModel(path: string) {
  getModel(path)?.dispose();
  savedVersions.delete(path);
}

export function disposeAllModels() {
  for (const model of monaco.editor.getModels()) model.dispose();
  savedVersions.clear();
}

/**
 * Re-reads open, unmodified files from disk after something else changed them
 * (checkout, pull, rollback). Files with unsaved edits are left alone.
 */
export async function reloadCleanModels() {
  await Promise.all(
    [...paths.values()].map(async (path) => {
      const model = getModel(path);
      if (!model || isDirty(path, model)) return;
      const text = await fsApi.readTextFile(path).catch(() => null);
      if (text === null || text === model.getValue() || isDirty(path, model)) return;
      model.setValue(text);
      savedVersions.set(path, model.getAlternativeVersionId());
    }),
  );
}

/** True if `path` is open with unsaved edits. */
export function isModelDirty(path: string): boolean {
  const model = getModel(path);
  return model ? isDirty(path, model) : false;
}
