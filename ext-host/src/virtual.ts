//! Documents that are not files: `registerTextDocumentContentProvider` (read-only,
//! e.g. `git:` originals) and `registerFileSystemProvider` (readable and writable,
//! e.g. Claude Code's proposed changes). The UI reads them through `virtual/read`
//! to show them (diffs, `vscode.open`) and saves edits through `virtual/write`.

import { documentFor, onDidChange } from "./documents";
import * as rpc from "./rpc";
import { CancellationTokenSource, Disposable, FileChangeType, FileSystemError, Range, Uri } from "./types";

const contentProviders = new Map<string, any>();
const fileSystems = new Map<string, { provider: any; readonly: boolean }>();

/** A virtual document's text changed: open documents follow, and the UI refreshes its view. */
async function changed(uri: Uri) {
  const document = documentFor(uri.toString());
  if (document) {
    try {
      const text = await read(uri);
      if (text !== document.getText()) {
        const oldRange = new Range(document.positionAt(0), document.positionAt(document.getText().length));
        const oldLength = document.getText().length;
        document.setText(text, document.version + 1);
        onDidChange.fire({ document, contentChanges: [{ range: oldRange, rangeOffset: 0, rangeLength: oldLength, text }], reason: undefined });
      }
    } catch {
      // It may be gone; the UI asks again when it shows it.
    }
  }
  rpc.notify("virtual/changed", { uri: uri.toString() });
}

export function registerContentProvider(scheme: string, provider: any) {
  contentProviders.set(scheme, provider);
  const subscription = provider.onDidChange?.((uri: Uri) => void changed(uri));
  rpc.notify("virtual/register", { scheme, writable: false });
  return new Disposable(() => {
    subscription?.dispose?.();
    if (contentProviders.get(scheme) === provider) contentProviders.delete(scheme);
  });
}

export function registerFileSystem(scheme: string, provider: any, options?: { isReadonly?: boolean | unknown }) {
  const readonly = options?.isReadonly === true;
  fileSystems.set(scheme, { provider, readonly });
  const subscription = provider.onDidChangeFile?.((events: { type: number; uri: Uri }[]) => {
    for (const event of events ?? []) if (event.type !== FileChangeType.Deleted) void changed(event.uri);
  });
  rpc.notify("virtual/register", { scheme, writable: !readonly });
  return new Disposable(() => {
    subscription?.dispose?.();
    if (fileSystems.get(scheme)?.provider === provider) fileSystems.delete(scheme);
  });
}

export const isVirtualScheme = (scheme: string) => contentProviders.has(scheme) || fileSystems.has(scheme);

/** The file system provider of `uri`'s scheme, for `workspace.fs`. */
export function fileSystemFor(uri: Uri) {
  return fileSystems.get(uri.scheme);
}

export async function read(uri: Uri): Promise<string> {
  const content = contentProviders.get(uri.scheme);
  if (content) return (await content.provideTextDocumentContent(uri, new CancellationTokenSource().token)) ?? "";
  const fs = fileSystems.get(uri.scheme);
  if (fs) return new TextDecoder().decode(await fs.provider.readFile(uri));
  throw FileSystemError.Unavailable(uri);
}

export async function write(uri: Uri, text: string) {
  const fs = fileSystems.get(uri.scheme);
  if (!fs || fs.readonly) throw FileSystemError.NoPermissions(uri);
  await fs.provider.writeFile(uri, new TextEncoder().encode(text), { create: true, overwrite: true });
}

export function listen() {
  rpc.onRequest("virtual/read", (params: { uri: string }) => read(Uri.parse(params.uri)));
  rpc.onRequest("virtual/write", async (params: { uri: string; text: string }) => {
    await write(Uri.parse(params.uri), params.text);
    return true;
  });
}
