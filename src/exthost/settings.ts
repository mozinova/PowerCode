//! User settings for extensions: `settings.json` in the app's data directory,
//! flat dotted keys as in VS Code (JSON with comments).

import { appDataDir, join } from "@tauri-apps/api/path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { fsApi } from "../lib/ipc";
import { getModel, saveModel } from "../editor/models";

let settingsPath: Promise<string> | null = null;

export function userSettingsPath(): Promise<string> {
  settingsPath ??= appDataDir().then((dir) => join(dir, "settings.json"));
  return settingsPath;
}

async function readText(): Promise<string> {
  const path = await userSettingsPath();
  // An open editor may hold newer (saved) text than a read would race with.
  return getModel(path)?.getValue() ?? (await fsApi.readTextFile(path).catch(() => "{}"));
}

export async function readUserSettings(): Promise<Record<string, unknown>> {
  const value = parseJsonc(await readText(), [], { allowTrailingComma: true });
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Sets (or, with `undefined`, removes) one key, keeping the file's comments and formatting. */
export async function updateUserSetting(key: string, value: unknown) {
  const path = await userSettingsPath();
  const text = await readText();
  const edits = modify(text.trim() ? text : "{}", [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(text.trim() ? text : "{}", edits);
  const model = getModel(path);
  if (model) {
    // Saving through the model keeps an open settings tab clean and in sync.
    model.setValue(next);
    await saveModel(path);
  } else {
    await ensureUserSettingsFile();
    await fsApi.writeTextFile(path, next);
  }
}

/** Creates the file with an empty object if it does not exist yet; returns its path. */
export async function ensureUserSettingsFile(): Promise<string> {
  const path = await userSettingsPath();
  const exists = await fsApi
    .readTextFile(path)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    const dir = path.replace(/[\\/][^\\/]*$/, "");
    await fsApi.createDir(dir).catch(() => {});
    await fsApi.writeTextFile(path, "{\n}\n");
  }
  return path;
}
