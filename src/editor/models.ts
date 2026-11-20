import { monaco } from "./monaco";
import { fileUri } from "./uris";
import { FILE_CHANGED, errorMessage, fsApi } from "../lib/ipc";
import { useWorkspace } from "../state/workspace";

/** Alternative version id of each model at its last load or save. */
const savedVersions = new Map<string, number>();
/**
 * Each open file's change signature on disk when it was last read or written: a
 * save checks the file is still like that, so it never overwrites a change made
 * outside the editor (see saveConflicts.ts). Null when unknown (no check).
 */
const diskSignatures = new Map<string, string | null>();

export function diskSignature(path: string): string | null | undefined {
  return diskSignatures.get(path);
}

/** A save refused because the file changed on disk since it was read. */
export class FileChangedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed on disk.`);
  }
}

/**
 * The file's text with its signature. The signature is taken first: a change that
 * lands between the two then shows up as a change later, never goes unnoticed.
 */
async function readFile(path: string): Promise<{ text: string; signature: string | null }> {
  const signature = (await fsApi.signatures([path]).catch(() => [null]))[0] ?? null;
  return { text: await fsApi.readTextFile(path), signature };
}
const pending = new Map<string, Promise<monaco.editor.ITextModel>>();
/** File path of each model, by URI: `Uri.fsPath` does not keep the original drive letter case. */
const paths = new Map<string, string>();

export function getModel(path: string) {
  return monaco.editor.getModel(fileUri(path));
}

function isDirty(path: string, model: monaco.editor.ITextModel) {
  return model.getAlternativeVersionId() !== savedVersions.get(path);
}

function createModel(path: string, text: string, dirty: boolean) {
  // The language is inferred from the file name, including languages
  // contributed by extensions.
  const model = monaco.editor.createModel(text, undefined, fileUri(path));
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
    promise = readFile(path)
      .then(({ text, signature }) => {
        diskSignatures.set(path, signature);
        return createModel(path, text, false);
      })
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

/** Why a document is saved, as `vscode.TextDocumentSaveReason`. */
export const SaveReason = { Manual: 1, AfterDelay: 2 } as const;
export type SaveReason = (typeof SaveReason)[keyof typeof SaveReason];

let willSave: ((model: monaco.editor.ITextModel, reason: SaveReason) => Promise<void>) | null = null;

/** Sets what runs before every save, e.g. extensions' `onWillSaveTextDocument` edits. */
export function setWillSaveParticipant(participant: typeof willSave) {
  willSave = participant;
}

/** Runs the save participant; a failing one never stops the save. */
export async function runWillSave(model: monaco.editor.ITextModel, reason: SaveReason) {
  try {
    await willSave?.(model, reason);
  } catch {
    // Logged by the participant.
  }
}

/**
 * Saves an open file. It fails with `FileChangedError` when the file changed on
 * disk since it was read, unless `overwrite` (the user chose to replace that change).
 */
export async function saveModel(path: string, reason: SaveReason = SaveReason.Manual, overwrite = false) {
  const model = getModel(path);
  if (!model) return;
  await runWillSave(model, reason);
  const version = model.getAlternativeVersionId();
  const text = model.getValue();
  let signature: string | null;
  try {
    signature = await fsApi.writeTextFile(path, text, overwrite ? null : diskSignatures.get(path));
  } catch (e) {
    if (errorMessage(e) !== FILE_CHANGED) throw e;
    // Changed on disk, but to what this save would write (e.g. the same edit made
    // elsewhere): nothing to lose.
    const disk = await readFile(path).catch(() => null);
    if (disk?.text !== text) throw new FileChangedError(path);
    signature = disk.signature;
  }
  diskSignatures.set(path, signature);
  savedVersions.set(path, version);
  useWorkspace.getState().setDirty(path, isDirty(path, model));
  saveListeners.forEach((listener) => listener(path, model));
}

/** Replaces an open file's text with what is on disk, dropping its unsaved edits (one undoable edit). */
export async function revertModel(path: string) {
  const model = getModel(path);
  if (!model) return;
  const { text, signature } = await readFile(path);
  if (text !== model.getValue()) {
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
  }
  diskSignatures.set(path, signature);
  savedVersions.set(path, model.getAlternativeVersionId());
  useWorkspace.getState().setDirty(path, false);
}

/** Moves an open model to the file's new path, keeping unsaved edits. */
export function moveModel(from: string, to: string) {
  const model = getModel(from);
  if (!model) return;
  const signature = diskSignatures.get(from);
  createModel(to, model.getValue(), isDirty(from, model));
  disposeModel(from);
  // A rename keeps the file's time and size: its signature is the same.
  diskSignatures.set(to, signature ?? null);
}

export function disposeModel(path: string) {
  getModel(path)?.dispose();
  savedVersions.delete(path);
  diskSignatures.delete(path);
}

export function disposeAllModels() {
  for (const model of monaco.editor.getModels()) model.dispose();
  savedVersions.clear();
  diskSignatures.clear();
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
      const disk = await readFile(path).catch(() => null);
      if (disk === null || isDirty(path, model)) return;
      diskSignatures.set(path, disk.signature);
      if (disk.text === model.getValue()) return;
      model.setValue(disk.text);
      savedVersions.set(path, model.getAlternativeVersionId());
    }),
  );
}

/** Re-reads one open file from disk if it has no unsaved edits (it changed outside the app). */
export async function reloadModelIfClean(path: string) {
  const model = getModel(path);
  if (!model || isDirty(path, model)) return;
  const disk = await readFile(path).catch(() => null);
  if (disk === null || isDirty(path, model)) return;
  // Touched with the same content (a formatter, `git checkout`): the new signature is the one to check against.
  diskSignatures.set(path, disk.signature);
  const text = disk.text;
  if (text === model.getValue()) return;
  // As one undoable edit, so the cursor and scroll position stay where they were.
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  savedVersions.set(path, model.getAlternativeVersionId());
  useWorkspace.getState().setDirty(path, false);
}

/** Paths of the open files (models loaded from disk). */
export function openModelPaths(): string[] {
  return [...paths.values()];
}

/** True if `path` is open with unsaved edits. */
export function isModelDirty(path: string): boolean {
  const model = getModel(path);
  return model ? isDirty(path, model) : false;
}
