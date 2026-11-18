import { create } from "zustand";
import type { RemoteTarget } from "../lib/remote";

/** A pending "Open Folder" on a remote target, shown by `RemoteFolderPicker`. */
export const useFolderPicker = create<{ request: { target: RemoteTarget; start: string } | null }>(() => ({
  request: null,
}));

/** Asks for a folder on `target`, starting at `start` (a workspace path), then opens it. */
export function pickRemoteFolder(target: RemoteTarget, start: string) {
  useFolderPicker.setState({ request: { target, start } });
}

export function closeFolderPicker() {
  useFolderPicker.setState({ request: null });
}
