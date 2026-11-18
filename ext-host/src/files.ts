//! Extensions taking part in saves and file operations: `onWillSaveTextDocument`
//! (edits applied before the save, e.g. organize imports) and `onWill/onDid`
//! `Create/Rename/DeleteFiles` (e.g. updating imports when a file moves). The UI
//! asks before it acts (`documents/willSave`, `files/willOperate`) and reports
//! after (`files/didOperate`).

import { documentFor } from "./documents";
import * as dto from "./dto";
import * as rpc from "./rpc";
import { CancellationTokenSource, EventEmitter, TextEdit, Uri, WorkspaceEdit } from "./types";

/** VS Code gives save participants about 1.5s; file operations get longer (they may search the project). */
const SAVE_TIMEOUT_MS = 1500;
const OPERATION_TIMEOUT_MS = 10_000;

export const onWillSave = new EventEmitter<any>();
export const onWillCreate = new EventEmitter<any>();
export const onDidCreate = new EventEmitter<any>();
export const onWillRename = new EventEmitter<any>();
export const onDidRename = new EventEmitter<any>();
export const onWillDelete = new EventEmitter<any>();
export const onDidDelete = new EventEmitter<any>();

/**
 * Fires `emitter` with an event whose `waitUntil` collects promises (only while
 * listeners run, as in VS Code), then waits for them up to `timeout`. Results of
 * promises that failed or took too long are left out.
 */
async function participate(emitter: EventEmitter<any>, event: Record<string, unknown>, timeout: number): Promise<unknown[]> {
  const pending: Promise<unknown>[] = [];
  let open = true;
  const source = new CancellationTokenSource();
  emitter.fire({
    ...event,
    token: source.token,
    waitUntil(thenable: PromiseLike<unknown>) {
      if (!open) throw new Error("waitUntil can only be called while the event is being dispatched");
      pending.push(Promise.resolve(thenable));
    },
  });
  open = false;
  if (pending.length === 0) return [];
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeout));
  const results = await Promise.all(
    pending.map((p) =>
      Promise.race([p, timer]).then(
        (value) => (value === "timeout" ? undefined : value),
        (e) => {
          rpc.notify("log", { level: "warning", message: `A file participant failed: ${e instanceof Error ? e.message : String(e)}` });
          return undefined;
        },
      ),
    ),
  );
  source.cancel();
  return results.filter((r) => r !== undefined);
}

type FilesDto = { kind: "create" | "delete"; files: { uri: string }[] } | { kind: "rename"; files: { from: string; to: string }[] };

function filesEvent(params: FilesDto) {
  return params.kind === "rename"
    ? { files: params.files.map((f) => ({ oldUri: Uri.parse(f.from), newUri: Uri.parse(f.to) })) }
    : { files: params.files.map((f) => Uri.parse(f.uri)) };
}

const WILL = { create: onWillCreate, rename: onWillRename, delete: onWillDelete };
const DID = { create: onDidCreate, rename: onDidRename, delete: onDidDelete };

export function listen() {
  rpc.onRequest("documents/willSave", async (params: { uri: string; reason: number }) => {
    const document = documentFor(params.uri);
    if (!document) return [];
    const results = await participate(onWillSave, { document, reason: params.reason }, SAVE_TIMEOUT_MS);
    return results
      .flatMap((r) => (Array.isArray(r) ? r : []))
      .filter((e): e is TextEdit => !!e && typeof e === "object" && "range" in e && typeof (e as TextEdit).newText === "string")
      .map(dto.textEdit);
  });

  // The edits extensions want made alongside the operation, as one workspace edit (or null).
  rpc.onRequest("files/willOperate", async (params: FilesDto) => {
    const results = await participate(WILL[params.kind], filesEvent(params), OPERATION_TIMEOUT_MS);
    const edits = results.filter((r): r is WorkspaceEdit => r instanceof WorkspaceEdit).map(dto.workspaceEdit);
    if (edits.length === 0) return null;
    return { edits: edits.flatMap((e) => e.edits), operations: edits.flatMap((e) => e.operations) };
  });

  rpc.onNotification("files/didOperate", (params: FilesDto) => DID[params.kind].fire(filesEvent(params)));
}
