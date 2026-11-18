import { create } from "zustand";

const AUTO_SAVE_KEY = "powercode.autoSave";

function storedAutoSave(): boolean {
  try {
    return localStorage.getItem(AUTO_SAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** User preferences that persist across sessions. */
export const useSettings = create<{ autoSave: boolean }>(() => ({ autoSave: storedAutoSave() }));

export function setAutoSave(autoSave: boolean) {
  useSettings.setState({ autoSave });
  try {
    localStorage.setItem(AUTO_SAVE_KEY, autoSave ? "on" : "off");
  } catch {
    // Not remembering the choice is harmless.
  }
}
