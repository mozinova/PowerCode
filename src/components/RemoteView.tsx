import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, Laptop, Minus, Plug, Plus, RefreshCw, Server, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { closeRemoteConnection } from "../actions";
import { errorMessage, remoteApi, type RemoteHosts, type SshHost } from "../lib/ipc";
import { remoteLabel, remoteOf, type RemoteTarget } from "../lib/remote";
import { track } from "../state/activity";
import { pickRemoteFolder } from "../state/folderPicker";
import { notify } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { tooltipProps } from "./Tooltip";
import { IconButton, ToolWindowHeader } from "./ui";

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div role="group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-1 px-1.5 text-[11px] font-semibold tracking-wide text-fg-muted uppercase hover:text-fg"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
        <span className="ml-1 font-normal text-fg-subtle">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function HostRow({
  icon: Icon,
  name,
  detail,
  current,
  onConnect,
}: {
  icon: typeof Server;
  name: string;
  detail?: string;
  current: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      role="treeitem"
      onClick={onConnect}
      {...tooltipProps(`Open a folder on ${name}`)}
      className="group mx-1 flex h-7 cursor-default items-center gap-2 rounded pr-1 pl-6 hover:bg-hover/50"
    >
      <Icon size={15} className={`shrink-0 ${current ? "text-[#73bd79]" : "text-fg-muted"}`} />
      <span className="shrink-0">{name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{current ? "connected" : detail}</span>
      <span className="hidden text-fg-muted group-hover:flex">
        <Plug size={14} />
      </span>
    </div>
  );
}

function sshDetail(host: SshHost) {
  const address = host.hostName ?? host.alias;
  return `${host.user ? `${host.user}@` : ""}${address}${host.port && host.port !== "22" ? `:${host.port}` : ""}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent";

/** Adds a `Host` entry to ~/.ssh/config. */
function AddSshHostDialog({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) {
  const [alias, setAlias] = useState("");
  const [hostName, setHostName] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const portNumber = port.trim() ? Number(port) : null;
    if (portNumber !== null && !(Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536)) {
      return setError("The port must be a number between 1 and 65535.");
    }
    setBusy(true);
    try {
      await remoteApi.addSshHost({
        alias: alias.trim() || hostName.trim(),
        hostName: hostName.trim(),
        user: user.trim() || null,
        port: portNumber,
        identityFile: identityFile.trim() || null,
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-label="Add New SSH Host"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="flex h-fit w-[420px] flex-col gap-3 rounded-lg border border-line-soft bg-panel p-4 shadow-2xl shadow-black/50"
      >
        <div className="font-semibold">Add New SSH Host</div>
        <Field label="Address">
          <input autoFocus value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="server.example.com or 10.0.0.5" spellCheck={false} className={INPUT_CLASS} />
        </Field>
        <div className="flex gap-2">
          <div className="flex-1">
            <Field label="User">
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="optional" spellCheck={false} className={INPUT_CLASS} />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Port">
              <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" className={INPUT_CLASS} />
            </Field>
          </div>
        </div>
        <Field label="Name (Host alias)">
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={hostName.trim() || "my-server"} spellCheck={false} className={INPUT_CLASS} />
        </Field>
        <Field label="Private key">
          <div className="flex gap-2">
            <input value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} placeholder="optional, e.g. ~/.ssh/id_ed25519" spellCheck={false} className={INPUT_CLASS} />
            <button
              type="button"
              onClick={async () => {
                const file = await open({ multiple: false, directory: false, title: "Select Private Key" });
                if (typeof file === "string") setIdentityFile(file);
              }}
              className="h-8 shrink-0 rounded-md border border-input-border px-2.5 hover:bg-hover"
            >
              Browse…
            </button>
          </div>
        </Field>
        <p className="text-xs text-fg-subtle">
          The host is added to your SSH config file, so it also works from any terminal. Connections use key-based
          authentication (keys or the SSH agent).
        </p>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-7 rounded-md border border-input-border px-3 hover:bg-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !hostName.trim()}
            className="h-7 rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            Add Host
          </button>
        </div>
      </form>
    </div>
  );
}

/** Remote Explorer: SSH hosts from ~/.ssh/config and WSL distributions to open folders on. */
export function RemoteView() {
  const root = useWorkspace((s) => s.root);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const openFile = useWorkspace((s) => s.openFile);
  const [hosts, setHosts] = useState<RemoteHosts | null>(null);
  const [adding, setAdding] = useState(false);
  const current = remoteOf(root);

  const load = () => {
    void track("Loading remote hosts…", () => remoteApi.hosts()).then(setHosts, (e) =>
      notify("error", "Could not list remote hosts", errorMessage(e)),
    );
  };
  useEffect(load, []);

  const connect = async (target: RemoteTarget) => {
    try {
      // Connecting may take a moment (SSH handshake, starting WSL).
      const home = await track(`Connecting to ${remoteLabel(target)}…`, () =>
        remoteApi.home(target.kind, target.kind === "ssh" ? target.host : target.distro),
      );
      pickRemoteFolder(target, home);
    } catch (e) {
      notify("error", `Could not connect to ${remoteLabel(target)}`, errorMessage(e));
    }
  };

  const isCurrent = (target: RemoteTarget) =>
    current?.kind === target.kind &&
    (target.kind === "ssh" ? current.kind === "ssh" && current.host === target.host : current.kind === "wsl" && current.distro === target.distro);

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Remote Hosts">
        <IconButton icon={Plus} title="Add New SSH Host" onClick={() => setAdding(true)} className="size-7" />
        {hosts && (
          <IconButton icon={Settings2} title="Open SSH Config File" onClick={() => openFile(hosts.sshConfig)} className="size-7" size={14} />
        )}
        <IconButton icon={RefreshCw} title="Refresh" onClick={load} className="size-7" size={14} />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("remote")} className="size-7" />
      </ToolWindowHeader>

      {current && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-selected-inactive px-2.5 py-1.5 text-xs">
          <span className="size-2 shrink-0 rounded-full bg-[#73bd79]" />
          <span className="min-w-0 flex-1 truncate">Connected to {remoteLabel(current)}</span>
          <button
            type="button"
            onClick={() => void closeRemoteConnection()}
            className="shrink-0 rounded px-1.5 py-0.5 text-[#548af7] hover:bg-hover"
          >
            Disconnect
          </button>
        </div>
      )}

      <div role="tree" className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!hosts ? null : (
          <>
            <Section title="SSH" count={hosts.ssh.length}>
              {hosts.ssh.length === 0 && (
                <p className="px-6 py-1 text-xs text-fg-muted">
                  No hosts in your SSH config yet.{" "}
                  <button type="button" onClick={() => setAdding(true)} className="text-[#548af7] hover:underline">
                    Add one
                  </button>
                </p>
              )}
              {hosts.ssh.map((host) => {
                const target: RemoteTarget = { kind: "ssh", host: host.alias };
                return (
                  <HostRow
                    key={host.alias}
                    icon={Server}
                    name={host.alias}
                    detail={sshDetail(host)}
                    current={isCurrent(target)}
                    onConnect={() => void connect(target)}
                  />
                );
              })}
            </Section>
            {hosts.wsl.length > 0 && (
              <Section title="WSL Targets" count={hosts.wsl.length}>
                {hosts.wsl.map((distro) => {
                  const target: RemoteTarget = { kind: "wsl", distro };
                  return (
                    <HostRow
                      key={distro}
                      icon={Laptop}
                      name={distro}
                      detail="WSL"
                      current={isCurrent(target)}
                      onConnect={() => void connect(target)}
                    />
                  );
                })}
              </Section>
            )}
          </>
        )}
      </div>

      {adding && <AddSshHostDialog onAdded={load} onClose={() => setAdding(false)} />}
    </div>
  );
}
