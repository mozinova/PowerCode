//! The extensions VS Code ships built in (vscode-builtins.json: languages, their
//! language servers, Emmet, npm, the JavaScript debugger, ...), installed from
//! Open VSX when PowerCode starts, so a fresh install works like VS Code. Each is
//! installed once: one the user uninstalls is not brought back.

import list from "../../vscode-builtins.json";
import { errorMessage } from "../lib/ipc";
import { dismiss, notify } from "../state/notifications";
import { installExtension, useExtensions } from "./runtime";

/**
 * Built-ins PowerCode leaves out: it provides the Git API and the GitHub sign-in
 * itself (the real ones would add a second Git provider and a second "github"
 * account provider), Microsoft sign-in needs `registerUriHandler` (not supported
 * yet), and tunnel forwarding needs VS Code's tunnel CLI.
 */
const EXCLUDED = new Set([
  "vscode.git",
  "vscode.git-base",
  "vscode.github-authentication",
  "vscode.microsoft-authentication",
  "vscode.tunnel-forwarding",
]);

export const BUILTIN_EXTENSIONS: string[] = (list as string[]).map((id) => id.toLowerCase()).filter((id) => !EXCLUDED.has(id));

const OFFERED_KEY = "powercode.builtinExtensionsOffered";
/** Downloads at once: enough to be quick, few enough not to flood the connection. */
const CONCURRENCY = 3;

function offered(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(OFFERED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function saveOffered(ids: Set<string>) {
  try {
    localStorage.setItem(OFFERED_KEY, JSON.stringify([...ids].sort()));
  } catch {
    // Not remembering only means asking Open VSX again next time.
  }
}

let running = false;

/** Installs the built-ins that are missing and were never installed before; call after the extensions loaded. */
export async function installBuiltinExtensions() {
  if (running) return;
  const { installed, disabled } = useExtensions.getState();
  const present = new Set([...installed, ...disabled].map((e) => e.id));
  const done = offered();
  // Ones already there count as offered: uninstalling them later is the user's choice.
  for (const id of BUILTIN_EXTENSIONS) if (present.has(id)) done.add(id);
  const missing = BUILTIN_EXTENSIONS.filter((id) => !done.has(id));
  // Claimed before installing, so another window starting now does not install them too.
  saveOffered(new Set([...done, ...missing]));
  if (missing.length === 0) return;

  running = true;
  const progress = notify("progress", `Installing ${missing.length} built-in extensions…`, "Languages, language servers and tools VS Code ships with.");
  // The extension host restarts once at the end, not after every extension.
  useExtensions.setState({ batchInstalling: true });
  const failed: string[] = [];
  let count = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const dot = id.indexOf(".");
      try {
        if (await installExtension(id.slice(0, dot), id.slice(dot + 1))) count++;
      } catch (e) {
        const message = errorMessage(e);
        // Not on Open VSX: no use asking again. Anything else (offline) is tried next start.
        if (!/404/.test(message)) {
          const retry = offered();
          retry.delete(id);
          saveOffered(retry);
        }
        failed.push(id);
        console.warn(`Built-in extension ${id}: ${message}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    useExtensions.setState({ batchInstalling: false });
    running = false;
  }
  dismiss(progress);
  if (failed.length === 0) notify("success", `Installed ${count} built-in extensions`);
  else notify("error", `Installed ${count} built-in extensions; ${failed.length} could not be installed`, failed.join(", "));
}
