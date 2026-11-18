//! Auto save, like VS Code's `files.autoSave: afterDelay`: a file is saved
//! `files.autoSaveDelay` (1 s) after its last edit, and when its tab closes (see `closeTabs`).

import { refreshGit } from "../git/store";
import { errorMessage } from "../lib/ipc";
import { notify } from "../state/notifications";
import { setting } from "../settings/store";
import { useSettings } from "../state/settings";
import { isModelDirty, modelPath, saveModel } from "./models";
import { monaco } from "./monaco";

/** `files.autoSaveDelay`, as in VS Code. */
const autoSaveDelay = () => Math.max(100, setting("files.autoSaveDelay", 1000));

const timers = new Map<string, number>();
/** Paths whose last auto save failed, so the error is reported once, not every second. */
const failing = new Set<string>();

/** Saves `path` now if it has unsaved edits; returns whether it ended up saved. */
export async function saveIfDirty(path: string): Promise<boolean> {
  window.clearTimeout(timers.get(path));
  timers.delete(path);
  if (!isModelDirty(path)) return true;
  try {
    await saveModel(path);
    failing.delete(path);
    void refreshGit();
    return true;
  } catch (e) {
    if (!failing.has(path)) notify("error", "Auto save failed", `${path}\n${errorMessage(e)}`);
    failing.add(path);
    return false;
  }
}

function schedule(path: string) {
  window.clearTimeout(timers.get(path));
  timers.set(
    path,
    window.setTimeout(() => void saveIfDirty(path), autoSaveDelay()),
  );
}

/** Starts watching editor models for edits; call once. */
export function startAutoSave() {
  monaco.editor.onDidCreateModel((model) => {
    // The path is looked up on each edit: it is registered only after creation,
    // and diff originals and other internal models have none.
    const listener = model.onDidChangeContent(() => {
      const path = modelPath(model);
      if (path && useSettings.getState().autoSave) schedule(path);
    });
    model.onWillDispose(() => {
      listener.dispose();
      const path = modelPath(model);
      if (path) {
        window.clearTimeout(timers.get(path));
        timers.delete(path);
      }
    });
  });
  // Turning auto save on saves what is pending.
  useSettings.subscribe((state, previous) => {
    if (state.autoSave && !previous.autoSave) {
      for (const model of monaco.editor.getModels()) {
        const path = modelPath(model);
        if (path && isModelDirty(path)) schedule(path);
      }
    }
  });
}
