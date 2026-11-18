//! Workspace Trust, as in VS Code: a folder opened for the first time starts in
//! Restricted Mode and the user is asked whether they trust its authors. Until
//! then, nothing in the folder can run code by itself: extensions (except those
//! that support Restricted Mode), automatic git (a repository's config can run
//! commands) and debugging wait.

import { create } from "zustand";
import { isWithin } from "../lib/paths";
import { pathKey } from "../lib/platform";
import { setting } from "../settings/store";

/** `pending`: not decided yet (the question is showing); restricted until answered. */
export type TrustState = "trusted" | "restricted" | "pending";

const STORAGE_KEY = "powercode.workspaceTrust";

interface Decisions {
  /** Trusted folders; their subfolders are trusted too. */
  trusted: string[];
  /** Folders the user chose not to trust (not asked about again). */
  restricted: string[];
}

function load(): Decisions {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
    return { trusted: strings(value.trusted), restricted: strings(value.restricted) };
  } catch {
    return { trusted: [], restricted: [] };
  }
}

interface TrustStore extends Decisions {
  /** The open folder's state. */
  state: TrustState;
  /** The trust dialog: asking about a newly opened folder, or managing trust. */
  dialog: { root: string; asking: boolean } | null;
}

export const useTrust = create<TrustStore>(() => ({ ...load(), state: "trusted", dialog: null }));

function save() {
  const { trusted, restricted } = useTrust.getState();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ trusted, restricted }));
  } catch {
    // Decisions just won't be remembered.
  }
}

/** Whether trust is on at all (`security.workspace.trust.enabled`). */
export const trustEnabled = () => setting("security.workspace.trust.enabled", true);

/** Inside (or equal to) one of `folders`, comparing paths as the OS does. */
const covered = (path: string, folders: string[]) => folders.some((folder) => isWithin(pathKey(path), pathKey(folder)));

/** The state a folder opens in. */
export function trustOf(root: string): TrustState {
  if (!trustEnabled()) return "trusted";
  const { trusted, restricted } = useTrust.getState();
  if (covered(root, trusted)) return "trusted";
  if (restricted.some((folder) => pathKey(folder) === pathKey(root))) return "restricted";
  return "pending";
}

/** Called as a folder opens (before anything runs in it): asks when undecided. */
export function enterFolder(root: string | null) {
  if (!root) {
    useTrust.setState({ state: "trusted", dialog: null });
    return;
  }
  const state = trustOf(root);
  useTrust.setState({ state, dialog: state === "pending" ? { root, asking: true } : null });
}

/** Trusts `folder` (and everything in it), then leaves Restricted Mode if it covers the open folder. */
export function trustFolder(folder: string, openRoot: string | null) {
  useTrust.setState(({ trusted, restricted }) => ({
    trusted: [...trusted.filter((t) => !isWithin(pathKey(t), pathKey(folder))), folder],
    restricted: restricted.filter((r) => !isWithin(pathKey(r), pathKey(folder))),
    dialog: null,
  }));
  save();
  if (openRoot) useTrust.setState({ state: trustOf(openRoot) });
}

/** Keeps the open folder in Restricted Mode, without asking again. */
export function restrictFolder(root: string) {
  useTrust.setState(({ trusted, restricted }) => ({
    trusted: trusted.filter((t) => pathKey(t) !== pathKey(root)),
    restricted: [...restricted.filter((r) => pathKey(r) !== pathKey(root)), root],
    dialog: null,
  }));
  save();
  useTrust.setState({ state: trustOf(root) === "trusted" ? "trusted" : "restricted" });
}

/** Forgets a trusted folder (Restricted Mode applies again if it held the open folder). */
export function untrustFolder(folder: string, openRoot: string | null) {
  useTrust.setState(({ trusted }) => ({ trusted: trusted.filter((t) => t !== folder) }));
  save();
  if (openRoot) {
    const state = trustOf(openRoot);
    useTrust.setState({ state: state === "pending" ? "restricted" : state });
  }
}

export function showTrustDialog(root: string) {
  useTrust.setState({ dialog: { root, asking: false } });
}

export function closeTrustDialog() {
  const { dialog, state } = useTrust.getState();
  // Closing the question without answering leaves the folder restricted (asked again next time).
  useTrust.setState({ dialog: null, state: dialog?.asking && state === "pending" ? "restricted" : state });
}

export const isTrusted = () => useTrust.getState().state === "trusted";
