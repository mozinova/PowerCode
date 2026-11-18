//! Documents extensions provide (`registerTextDocumentContentProvider`,
//! `registerFileSystemProvider`), shown as editor models under the extension's
//! URI scheme. Their text comes from the host (`virtual/read`); edits to the
//! writable ones (file system providers) are saved back (`virtual/write`).

import { disposeModel, isModelDirty, loadModel, runWillSave, SaveReason, saveModel } from "../editor/models";
import { monaco } from "../editor/monaco";
import { fileUri, uriToPath } from "../editor/uris";
import { documentTabPath, parseCompareTab, parseDocumentTab } from "../lib/virtualTabs";
import { openPaths, useWorkspace } from "../state/workspace";
import * as rpc from "./rpc";

/** Schemes extensions registered, and whether their documents can be saved. */
const schemes = new Map<string, { writable: boolean }>();
/** Alternative version id of each extension document at its last read or save. */
const savedVersions = new Map<string, number>();
const pending = new Map<string, Promise<monaco.editor.ITextModel>>();
/** Files a compare tab loaded, released with it (see `releaseDocumentModels`). */
const comparedFiles = new Set<string>();
const saveListeners = new Set<(uri: string) => void>();

const isFileUri = (uri: monaco.Uri) => uri.scheme === "file" || uri.scheme === "ssh";
/** The same URI as editor models write it (encoding may differ from the host's). */
const normalize = (uri: string) => monaco.Uri.parse(uri).toString();

export const isVirtualScheme = (scheme: string) => schemes.has(scheme);

export function isVirtualModel(model: monaco.editor.ITextModel) {
  return savedVersions.has(model.uri.toString());
}

export function isWritableDocument(uri: string) {
  const parsed = monaco.Uri.parse(uri);
  return isFileUri(parsed) || schemes.get(parsed.scheme)?.writable === true;
}

function isDirty(uri: string, model: monaco.editor.ITextModel) {
  return model.getAlternativeVersionId() !== savedVersions.get(uri);
}

export function isVirtualDirty(uri: string) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  return !!model && isVirtualModel(model) && isDirty(model.uri.toString(), model);
}

function createVirtualModel(uri: monaco.Uri, text: string) {
  const key = uri.toString();
  // The language follows the URI's file name, like files.
  const model = monaco.editor.createModel(text, undefined, uri);
  savedVersions.set(key, model.getAlternativeVersionId());
  model.onDidChangeContent(() => useWorkspace.getState().setDirty(documentTabPath(key), isDirty(key, model)));
  model.onWillDispose(() => savedVersions.delete(key));
  return model;
}

/** The model of a document an extension provides, read from the host the first time. */
export function virtualModel(uri: string): Promise<monaco.editor.ITextModel> {
  const parsed = monaco.Uri.parse(uri);
  const existing = monaco.editor.getModel(parsed);
  if (existing) return Promise.resolve(existing);
  const key = parsed.toString();
  let promise = pending.get(key);
  if (!promise) {
    promise = rpc
      .request<string>("virtual/read", { uri })
      .then((text) => monaco.editor.getModel(parsed) ?? createVirtualModel(parsed, text ?? ""))
      .finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}

/** The model of any document by URI: files (as in their tabs) or extension documents. */
export async function documentModel(uri: string, compared = false): Promise<monaco.editor.ITextModel> {
  const parsed = monaco.Uri.parse(uri);
  if (!isFileUri(parsed)) return virtualModel(uri);
  const path = uriToPath(parsed);
  if (compared && !openPaths(useWorkspace.getState()).has(path)) comparedFiles.add(path);
  return loadModel(path);
}

/** Calls `listener` after an extension document is saved; returns the unsubscribe function. */
export function onDidSaveVirtual(listener: (uri: string) => void) {
  saveListeners.add(listener);
  return () => void saveListeners.delete(listener);
}

export async function saveVirtual(uri: string) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model || !isVirtualModel(model)) return;
  await runWillSave(model, SaveReason.Manual);
  const key = model.uri.toString();
  const version = model.getAlternativeVersionId();
  await rpc.request("virtual/write", { uri, text: model.getValue() });
  savedVersions.set(key, version);
  useWorkspace.getState().setDirty(documentTabPath(key), isDirty(key, model));
  saveListeners.forEach((listener) => listener(key));
}

/** Saves any document by URI: a file, or an extension's writable document. */
export async function saveDocument(uri: string) {
  const parsed = monaco.Uri.parse(uri);
  if (isFileUri(parsed)) await saveModel(uriToPath(parsed));
  else await saveVirtual(uri);
}

/** The provider says the document changed: an unmodified model shows the new text. */
async function refresh(uri: string) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model || !isVirtualModel(model)) return;
  const key = model.uri.toString();
  if (isDirty(key, model)) return;
  const text = await rpc.request<string>("virtual/read", { uri }).catch(() => null);
  if (text === null || text === model.getValue() || isDirty(key, model)) return;
  model.setValue(text);
  savedVersions.set(key, model.getAlternativeVersionId());
}

/**
 * Disposes the models only closed tabs used: extension documents no tab shows
 * (unless edited), and files a compare tab loaded that no tab shows any more.
 */
export function releaseDocumentModels() {
  const open = openPaths(useWorkspace.getState());
  const used = new Set<string>();
  for (const path of open) {
    const document = parseDocumentTab(path);
    if (document) used.add(normalize(document));
    const compare = parseCompareTab(path);
    if (compare) used.add(normalize(compare.original)).add(normalize(compare.modified));
  }
  for (const uri of [...savedVersions.keys()]) {
    if (!used.has(uri) && !isVirtualDirty(uri)) monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
  }
  for (const path of [...comparedFiles]) {
    if (open.has(path) || used.has(fileUri(path).toString())) continue;
    comparedFiles.delete(path);
    if (!isModelDirty(path)) disposeModel(path);
  }
}

export function registerVirtualDocumentHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("virtual/register", ({ scheme, writable }) => schemes.set(scheme, { writable: writable === true }));
  onNotification("virtual/changed", ({ uri }) => void refresh(uri));
}

/** The host stopped: its schemes and documents are gone, so are the tabs showing them. */
export function resetVirtualDocuments() {
  schemes.clear();
  const { groups, closeTab } = useWorkspace.getState();
  const isExtensionUri = (uri: string) => !isFileUri(monaco.Uri.parse(uri));
  for (const group of groups) {
    for (const tab of group.tabs) {
      const document = parseDocumentTab(tab.path);
      const compare = parseCompareTab(tab.path);
      if ((document && isExtensionUri(document)) || (compare && (isExtensionUri(compare.original) || isExtensionUri(compare.modified)))) {
        closeTab(tab.path, group.id);
      }
    }
  }
  for (const uri of [...savedVersions.keys()]) monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
  releaseDocumentModels();
}
