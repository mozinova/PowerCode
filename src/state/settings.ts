import { create } from "zustand";

const AUTO_SAVE_KEY = "powercode.autoSave";
const AUTO_UPDATE_KEY = "powercode.autoUpdateExtensions";

/** On unless turned off. */
function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function storeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // Not remembering the choice is harmless.
  }
}

/** User preferences that persist across sessions. */
export const useSettings = create<{ autoSave: boolean; autoUpdateExtensions: boolean }>(() => ({
  autoSave: storedFlag(AUTO_SAVE_KEY),
  autoUpdateExtensions: storedFlag(AUTO_UPDATE_KEY),
}));

export function setAutoSave(autoSave: boolean) {
  useSettings.setState({ autoSave });
  storeFlag(AUTO_SAVE_KEY, autoSave);
}

export function setAutoUpdateExtensions(autoUpdateExtensions: boolean) {
  useSettings.setState({ autoUpdateExtensions });
  storeFlag(AUTO_UPDATE_KEY, autoUpdateExtensions);
}
