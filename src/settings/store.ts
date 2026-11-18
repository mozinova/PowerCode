//! The user's `settings.json` as a store: VS Code keys (`editor.fontSize`) for
//! PowerCode's own settings and extensions' ones alike. The Settings page and
//! the editor read it; extensions get it through the extension host.

import { create } from "zustand";
import { readUserSettings, updateUserSetting } from "../exthost/settings";

export const useUserSettings = create<{ values: Record<string, unknown>; loaded: boolean }>(() => ({ values: {}, loaded: false }));

/** Re-reads settings.json (at startup, and after it is saved in an editor). */
export async function loadUserSettings() {
  const values = await readUserSettings().catch(() => ({}));
  useUserSettings.setState({ values, loaded: true });
}

/** Writes run one at a time: each reads the file the previous one wrote. */
let writing: Promise<unknown> = Promise.resolve();

/** Sets `key`, or removes it (back to its default) with `undefined`. */
export function setUserSetting(key: string, value: unknown): Promise<void> {
  const write = writing.then(async () => {
    await updateUserSetting(key, value);
    useUserSettings.setState(({ values }) => {
      const next = { ...values };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { values: next };
    });
  });
  writing = write.catch(() => {});
  return write;
}

/** The value of `key`, or `fallback` when unset (or of another type). */
export function setting<T>(key: string, fallback: T, values = useUserSettings.getState().values): T {
  const value = values[key];
  return value !== undefined && value !== null && typeof value === typeof fallback ? (value as T) : fallback;
}
