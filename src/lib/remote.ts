//! Remote workspaces: `ssh://host/path` for SSH, `\\wsl.localhost\<distro>\...`
//! (or `\\wsl$\...`) for WSL.

export type RemoteTarget = { kind: "ssh"; host: string } | { kind: "wsl"; distro: string };

const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i;

export function remoteOf(path: string | null): RemoteTarget | null {
  if (!path) return null;
  if (path.startsWith("ssh://")) {
    const host = path.slice(6).split("/")[0];
    return host ? { kind: "ssh", host } : null;
  }
  const wsl = WSL_SHARE.exec(path);
  return wsl ? { kind: "wsl", distro: wsl[1] } : null;
}

export function remoteLabel(target: RemoteTarget): string {
  return target.kind === "ssh" ? `SSH: ${target.host}` : `WSL: ${target.distro}`;
}

/** SSH paths have no local file behind them (no media preview, no file manager). */
export function isSshPath(path: string): boolean {
  return path.startsWith("ssh://");
}

/** The workspace path of `linux` (an absolute path) on `target`. */
export function workspacePath(target: RemoteTarget, linux: string): string {
  if (target.kind === "ssh") return `ssh://${target.host}${linux}`;
  // The distribution's root is the share itself, which needs its trailing backslash.
  const rest = linux.replace(/\/+$/, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${target.distro}${rest || "\\"}`;
}

/** The parent of an absolute Linux path; `/` is its own parent. */
export function linuxParent(linux: string): string {
  return linux.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
}

/** The Linux path part of a remote workspace path. */
export function linuxPath(target: RemoteTarget, path: string): string {
  if (target.kind === "ssh") return path.slice(`ssh://${target.host}`.length) || "/";
  const rest = path.replace(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+/i, "");
  return rest.replace(/\\/g, "/") || "/";
}
