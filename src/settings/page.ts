import { create } from "zustand";

/** The search the Settings page opens with (e.g. from an extension's `workbench.action.openSettings`). */
export const useSettingsPage = create<{ query: string; nonce: number }>(() => ({ query: "", nonce: 0 }));
