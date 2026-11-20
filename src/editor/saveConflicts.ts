//! A file changed on disk while it has unsaved edits (an AI agent, `git`, another
//! editor): saving would overwrite that change. As in VS Code, nothing is written
//! until the user chooses: Compare (the file on disk next to the edits), Overwrite
//! (keep the edits) or Revert (take the file on disk).

import { basename } from "../lib/paths";
import { compareTabPath } from "../lib/virtualTabs";
import { ask } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { FileChangedError, SaveReason, diskSignature, getModel, revertModel, saveModel } from "./models";
import { monaco } from "./monaco";
import { fileUri } from "./uris";
import { fsApi } from "../lib/ipc";

export const isFileChanged = (e: unknown): e is FileChangedError => e instanceof FileChangedError;

/** Files with the question showing (one question per file at a time). */
const asking = new Set<string>();
/**
 * The disk signature each file had when the user dismissed the question: auto save
 * and the change watcher do not ask again until the file changes once more.
 */
const dismissed = new Map<string, string | null>();

/** The file on disk, read-only, for the comparison (one per file, replaced on each Compare). */
const diskModels = new Map<string, monaco.editor.ITextModel>();

async function compare(path: string) {
  const model = getModel(path);
  if (!model) return;
  const text = await fsApi.readTextFile(path);
  diskModels.get(path)?.dispose();
  const uri = monaco.Uri.from({ scheme: "pcdisk", path: fileUri(path).path, query: String(Date.now()) });
  diskModels.set(path, monaco.editor.createModel(text, model.getLanguageId(), uri));
  const name = basename(path);
  useWorkspace.getState().openFile(compareTabPath(uri.toString(), model.uri.toString()), `${name} (on disk) ↔ ${name}`);
}

/**
 * Asks what to do about a file that changed on disk under unsaved edits. `when`
 * says how it was noticed: a refused save, or the change watcher.
 */
export async function resolveSaveConflict(path: string, when: "save" | "watcher" = "save") {
  if (asking.has(path) || !getModel(path)) return;
  asking.add(path);
  try {
    const name = basename(path);
    const message =
      when === "save"
        ? "The file was changed outside PowerCode after you opened it. Saving would overwrite that change."
        : "The file was changed outside PowerCode and you have unsaved changes in it.";
    let actions = ["Compare", "Overwrite", "Revert"];
    for (;;) {
      const choice = await ask("error", `${name} changed on disk`, message, actions);
      const action = choice === null ? null : actions[choice];
      if (action === "Compare") {
        await compare(path).catch(() => {});
        // Then the other two, with the comparison in view.
        actions = ["Overwrite", "Revert"];
        continue;
      }
      if (action === "Overwrite") {
        dismissed.delete(path);
        await saveModel(path, SaveReason.Manual, true);
      } else if (action === "Revert") {
        dismissed.delete(path);
        await revertModel(path);
      } else {
        dismissed.set(path, (await fsApi.signatures([path]).catch(() => [null]))[0] ?? null);
      }
      return;
    }
  } finally {
    asking.delete(path);
  }
}

/** Whether to ask now: not while asking, nor again for a change the user dismissed. */
export async function shouldAsk(path: string): Promise<boolean> {
  if (asking.has(path)) return false;
  if (!dismissed.has(path)) return true;
  const current = (await fsApi.signatures([path]).catch(() => [null]))[0] ?? null;
  return current !== dismissed.get(path);
}

/**
 * Whether auto save should leave the file alone: its question is showing, or was
 * dismissed and the file has not changed since. (Trying anyway would run the save
 * participants, e.g. format on save, every few seconds for nothing.)
 */
export async function heldBack(path: string): Promise<boolean> {
  if (asking.has(path)) return true;
  if (!dismissed.has(path)) return false;
  return !(await shouldAsk(path));
}

/** For a manual save: asks again even after a dismissal. */
export function forgetDismissal(path: string) {
  dismissed.delete(path);
}

export { diskSignature };
