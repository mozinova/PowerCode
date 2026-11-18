import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { BadgeCheck, Blocks, Download, ExternalLink, Loader2, Star } from "lucide-react";
import { marked } from "marked";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { installExtension, installedIconUrl, uninstallExtension, useExtensions } from "../extensions/runtime";
import {
  errorMessage,
  extensionsApi,
  type ExtensionDetails,
  type InstalledExtension,
  type OpenVsxMetadata,
} from "../lib/ipc";
import { extensionTabPath } from "../lib/virtualTabs";
import { useWorkspace } from "../state/workspace";
import { InstallProgressBar, useInstallProgress } from "./InstallProgress";

const README_NAMES = ["README.md", "readme.md", "Readme.md"];

/** Offline fallback: the installed copy's manifest and README. */
async function localDetails(ext: InstalledExtension): Promise<ExtensionDetails> {
  // The manifest has more fields than `ExtensionManifest` declares.
  const manifest = ext.manifest as InstalledExtension["manifest"] & {
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
    categories?: string[];
  };
  let readme: string | null = null;
  for (const name of README_NAMES) {
    readme = await extensionsApi.readFile(ext.id, name).catch(() => null);
    if (readme !== null) break;
  }
  return {
    metadata: {
      namespace: manifest.publisher,
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      license: manifest.license,
      homepage: manifest.homepage,
      repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url,
      categories: manifest.categories,
    },
    readme,
  };
}

function iconUrl(metadata: OpenVsxMetadata, installed?: InstalledExtension) {
  return metadata.files?.icon ?? (installed && installedIconUrl(installed));
}

/** README links open in the system browser instead of navigating the app. */
function onReadmeClick(e: MouseEvent) {
  const link = (e.target as Element).closest("a");
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) void openUrl(href);
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(href)}
      className="flex items-center gap-1.5 text-left text-[#548af7] hover:underline"
    >
      {children}
      <ExternalLink size={12} className="shrink-0" />
    </button>
  );
}

function InstallButton({ namespace, name }: { namespace: string; name: string }) {
  const id = `${namespace}.${name}`.toLowerCase();
  const installed = useExtensions((s) => s.installed.some((e) => e.id === id));
  const progress = useInstallProgress(namespace, name);
  const [uninstalling, setUninstalling] = useState(false);
  const busy = uninstalling || progress !== undefined;

  const run = async () => {
    try {
      if (installed) {
        setUninstalling(true);
        await uninstallExtension(id);
      } else {
        await installExtension(namespace, name);
      }
    } catch (e) {
      await message(`Could not ${installed ? "uninstall" : "install"} the extension:\n${errorMessage(e)}`, {
        title: "PowerCode",
        kind: "error",
      });
    } finally {
      setUninstalling(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className={`flex h-8 items-center gap-1.5 rounded-md px-4 font-medium disabled:opacity-70 ${
          installed
            ? "border border-input-border text-fg hover:bg-hover"
            : "bg-accent text-white hover:bg-accent-hover"
        }`}
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {busy ? (installed ? "Uninstalling…" : "Installing…") : installed ? "Uninstall" : "Install"}
      </button>
      {progress && <InstallProgressBar progress={progress} className="w-56" />}
    </>
  );
}

export function ExtensionPage({ namespace, name }: { namespace: string; name: string }) {
  const id = `${namespace}.${name}`.toLowerCase();
  const installed = useExtensions((s) => s.installed.find((e) => e.id === id));
  const [details, setDetails] = useState<ExtensionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    extensionsApi.details(namespace, name).then(
      (loaded) => !cancelled && setDetails(loaded),
      async (e) => {
        const local = useExtensions.getState().installed.find((x) => x.id === id);
        const fallback = local ? await localDetails(local).catch(() => null) : null;
        if (cancelled) return;
        if (fallback) setDetails(fallback);
        else setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [namespace, name, id, attempt]);

  const readmeHtml = useMemo(() => {
    if (!details?.readme) return null;
    // The README comes from the network, so it is sanitized before rendering.
    return DOMPurify.sanitize(marked.parse(details.readme, { async: false }));
  }, [details]);

  const icon = details ? iconUrl(details.metadata, installed) : undefined;
  // Tabs opened without an icon pick it up once it is known.
  useEffect(() => {
    if (icon) useWorkspace.getState().setTabIcon(extensionTabPath(namespace, name), icon);
  }, [icon, namespace, name]);

  if (error) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-editor text-fg-muted">
        <p>Could not load the extension details.</p>
        <p className="max-w-md text-center text-xs text-fg-subtle">{error}</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="rounded-md border border-input-border px-3 py-1 text-fg hover:bg-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-editor text-fg-muted">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  const { metadata } = details;
  const updated = metadata.timestamp ? new Date(metadata.timestamp).toLocaleDateString() : null;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-editor select-text">
      <div className="@container mx-auto max-w-5xl px-8 py-6">
        <header className="flex gap-5 border-b border-line-soft pb-5">
          {icon ? (
            <img src={icon} alt="" className="size-22 shrink-0 rounded-lg object-contain" />
          ) : (
            <div className="flex size-22 shrink-0 items-center justify-center rounded-lg bg-panel text-fg-muted">
              <Blocks size={40} strokeWidth={1.5} />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <h1 className="text-2xl font-semibold">{metadata.displayName ?? metadata.name}</h1>
              <span className="rounded bg-panel px-1.5 py-0.5 text-xs text-fg-muted">v{metadata.version}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fg-muted">
              <span className="flex items-center gap-1">
                {metadata.namespace}
                {metadata.verified && <BadgeCheck size={14} className="text-accent-hover" />}
              </span>
              {metadata.downloadCount !== undefined && (
                <span className="flex items-center gap-1">
                  <Download size={13} />
                  {metadata.downloadCount.toLocaleString()}
                </span>
              )}
              {metadata.averageRating !== undefined && (
                <span className="flex items-center gap-1">
                  <Star size={13} className="fill-current text-[#e5bf00]" />
                  {metadata.averageRating.toFixed(1)}
                  {metadata.reviewCount !== undefined && ` (${metadata.reviewCount})`}
                </span>
              )}
            </div>
            {metadata.description && <p className="text-fg-muted">{metadata.description}</p>}
            <div className="mt-1.5 flex items-center gap-3">
              <InstallButton namespace={metadata.namespace} name={metadata.name} />
              {installed && <span className="text-xs text-fg-subtle">Installed v{installed.manifest.version}</span>}
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-8 pt-5 @3xl:grid-cols-[minmax(0,1fr)_220px]">
          {readmeHtml ? (
            <article
              onClick={onReadmeClick}
              className="markdown-body min-w-0"
              dangerouslySetInnerHTML={{ __html: readmeHtml }}
            />
          ) : (
            <p className="text-fg-muted">This extension has no README.</p>
          )}
          <aside className="flex flex-col gap-5 text-[13px]">
            <section>
              <h2 className="mb-2 font-semibold">More Info</h2>
              <dl className="flex flex-col gap-2.5">
                <InfoRow label="Identifier">{`${metadata.namespace}.${metadata.name}`}</InfoRow>
                <InfoRow label="Version">{metadata.version}</InfoRow>
                {updated && <InfoRow label="Last Updated">{updated}</InfoRow>}
                {metadata.license && <InfoRow label="License">{metadata.license}</InfoRow>}
                {metadata.categories && metadata.categories.length > 0 && (
                  <InfoRow label="Categories">
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {metadata.categories.map((c) => (
                        <span key={c} className="rounded bg-panel px-1.5 py-0.5 text-xs">
                          {c}
                        </span>
                      ))}
                    </div>
                  </InfoRow>
                )}
              </dl>
            </section>
            <section>
              <h2 className="mb-2 font-semibold">Resources</h2>
              <div className="flex flex-col gap-1.5">
                <LinkButton href={`https://open-vsx.org/extension/${metadata.namespace}/${metadata.name}`}>
                  Open VSX
                </LinkButton>
                {metadata.repository && <LinkButton href={metadata.repository}>Repository</LinkButton>}
                {metadata.homepage && <LinkButton href={metadata.homepage}>Homepage</LinkButton>}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
