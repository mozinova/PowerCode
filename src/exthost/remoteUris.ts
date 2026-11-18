//! With the extension host on a remote, paths and URIs differ on each side:
//! the UI knows `ssh://host/home/me/a.ts` or `\\wsl.localhost\Ubuntu\home\me\a.ts`,
//! the host (and its extensions) `file:///home/me/a.ts` and `/home/me/a.ts`.
//! Messages are translated in both directions, but only in fields that carry
//! URIs or paths, never in content (document text, webview HTML, ...).

import { fileUri } from "../editor/uris";
import { monaco } from "../editor/monaco";

export type RemoteMapping = { kind: "ssh"; host: string } | { kind: "wsl"; distro: string };

/** Fields holding URIs (`file:` on the host side). */
const URI_KEYS = new Set(["uri", "$uri", "from", "to", "target", "resourceUri", "uris", "original", "modified"]);
/** Fields holding file system paths (DAP sources, terminals' folders, breakpoints, ...). */
const PATH_KEYS = new Set(["path", "file", "cwd"]);
/** Content that must stay exactly as written. */
const CONTENT_KEYS = new Set(["text", "html", "message", "output", "newText", "insertText", "value", "documentation", "settings"]);

export interface Translator {
  toHost(value: unknown): unknown;
  fromHost(value: unknown): unknown;
}

function walk(value: unknown, key: string | null, convert: (s: string, kind: "uri" | "path") => string | null): unknown {
  if (typeof value === "string") {
    const kind = key && URI_KEYS.has(key) ? "uri" : key && PATH_KEYS.has(key) ? "path" : null;
    return kind ? (convert(value, kind) ?? value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key, convert));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = CONTENT_KEYS.has(k) ? v : walk(v, k, convert);
    return out;
  }
  return value;
}

export function createTranslator(mapping: RemoteMapping): Translator {
  const sameDistro = (name: string) => mapping.kind === "wsl" && name.toLowerCase() === mapping.distro.toLowerCase();

  /** A workspace path as a path on the remote, or null when it is not on that remote. */
  const remotePath = (path: string): string | null => {
    if (mapping.kind === "ssh") {
      const prefix = `ssh://${mapping.host}`;
      return path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || "/" : null;
    }
    const share = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(path);
    return share && sameDistro(share[1]) ? (share[2] ?? "\\").replace(/\\/g, "/") : null;
  };

  const remoteUri = (uri: string): string | null => {
    if (mapping.kind === "ssh") {
      // Model URIs are encoded (`my%20app`): parse, do not cut the string.
      if (!uri.startsWith("ssh://")) return null;
      const parsed = monaco.Uri.parse(uri);
      return parsed.authority === mapping.host ? monaco.Uri.from({ scheme: "file", path: parsed.path || "/" }).toString() : null;
    }
    if (!uri.startsWith("file://wsl")) return null;
    const parsed = monaco.Uri.parse(uri);
    if (parsed.authority !== "wsl.localhost" && parsed.authority !== "wsl$") return null;
    const [, distro = "", ...rest] = parsed.path.split("/");
    return sameDistro(distro) ? monaco.Uri.from({ scheme: "file", path: `/${rest.join("/")}` }).toString() : null;
  };

  /** A path on the remote as a workspace path. */
  const localPath = (path: string): string | null => {
    if (!path.startsWith("/")) return null;
    return mapping.kind === "ssh" ? `ssh://${mapping.host}${path}` : `\\\\wsl.localhost\\${mapping.distro}${path.replace(/\//g, "\\")}`;
  };

  const localUri = (uri: string): string | null => {
    if (!uri.startsWith("file:///")) return null;
    const path = localPath(monaco.Uri.parse(uri).path);
    return path ? fileUri(path).toString() : null;
  };

  return {
    toHost: (value) => walk(value, null, (s, kind) => (kind === "uri" ? remoteUri(s) : remotePath(s))),
    fromHost: (value) => walk(value, null, (s, kind) => (kind === "uri" ? localUri(s) : localPath(s))),
  };
}

/** Messages whose payload is content only (logs, output, webview traffic, settings). */
export const UNTRANSLATED_METHODS = new Set([
  "log",
  "output/append",
  "webview/html",
  "webview/postMessage",
  "webview/message",
  "configuration/changed",
  "statusBar/update",
  "statusBar/message",
]);
