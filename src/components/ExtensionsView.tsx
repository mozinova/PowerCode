import { message } from "@tauri-apps/plugin-dialog";
import { BadgeCheck, Blocks, ChevronDown, ChevronRight, Download, Loader2, Minus, PowerOff, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { setIconTheme, useIconThemes } from "../extensions/iconThemes";
import { openExtensionPage, pickAndInstallVsix } from "../actions";
import {
  checkForUpdates,
  installExtension,
  installedIconUrl,
  setEditorTheme,
  setExtensionEnabled,
  uninstallExtension,
  useExtensions,
} from "../extensions/runtime";
import { errorMessage, extensionsApi, type InstalledExtension, type OpenVsxEntry } from "../lib/ipc";
import { notify } from "../state/notifications";
import { setAutoUpdateExtensions, useSettings } from "../state/settings";
import { useWorkspace } from "../state/workspace";
import { InstallProgressRing, useInstallProgress } from "./InstallProgress";
import { Select } from "./Select";
import { IconButton, ToolWindowHeader } from "./ui";
import { tooltipProps } from "./Tooltip";

function formatCount(n?: number) {
  if (n === undefined) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function summarize(ext: InstalledExtension) {
  const c = ext.manifest.contributes ?? {};
  const parts = [
    [c.themes?.length, "theme", "themes"],
    [c.grammars?.length, "grammar", "grammars"],
    [c.snippets?.length, "snippet", "snippets"],
    [c.languages?.length, "language", "languages"],
    [c.iconThemes?.length, "icon theme", "icon themes"],
  ] as const;
  const text = parts
    .filter(([n]) => n)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(" · ");
  return text || "No supported contributions";
}

async function reportError(action: string, e: unknown) {
  await message(`${action}:\n${errorMessage(e)}`, { title: "PowerCode", kind: "error" });
}

function ExtensionIcon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-hover text-fg-muted">
        <Blocks size={18} />
      </div>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} className="size-9 shrink-0 rounded-md object-contain" />;
}

function Picker({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onSelect: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="w-28 shrink-0 text-fg-muted">{label}</span>
      <Select
        ariaLabel={label}
        options={options}
        value={value}
        busy={busy}
        onChange={async (id) => {
          setBusy(true);
          try {
            await onSelect(id);
          } catch (err) {
            await reportError(`Could not apply the ${label.toLowerCase()}`, err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function ThemePickers() {
  const themes = useExtensions((s) => s.themes);
  const activeThemeId = useExtensions((s) => s.activeThemeId);
  const iconThemes = useIconThemes((s) => s.options);
  const activeIconThemeId = useIconThemes((s) => s.activeId);
  const autoUpdate = useSettings((s) => s.autoUpdateExtensions);
  return (
    <div className="py-1">
      <Picker label="Editor theme" options={themes} value={activeThemeId} onSelect={setEditorTheme} />
      <Picker label="File icon theme" options={iconThemes} value={activeIconThemeId} onSelect={setIconTheme} />
      <label className="flex items-center gap-2 px-3 py-1.5">
        <span className="w-28 shrink-0 text-fg-muted">Auto update</span>
        <input
          type="checkbox"
          checked={autoUpdate}
          onChange={(e) => setAutoUpdateExtensions(e.target.checked)}
          className="accent-accent"
        />
        <span className="text-xs text-fg-subtle">Checks at startup and every 6 hours</span>
      </label>
    </div>
  );
}

function InstalledRow({ ext }: { ext: InstalledExtension }) {
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const { manifest } = ext;
  const icon = installedIconUrl(ext);
  const update = useExtensions((s) => s.updates[ext.id]);
  const progress = useInstallProgress(manifest.publisher, manifest.name);
  const toggle = async () => {
    setToggling(true);
    try {
      await setExtensionEnabled(ext.id, ext.disabled);
    } catch (err) {
      await reportError(`Could not ${ext.disabled ? "enable" : "disable"} the extension`, err);
    } finally {
      setToggling(false);
    }
  };
  return (
    <div
      onClick={() =>
        openExtensionPage(manifest.publisher, manifest.name, manifest.displayName ?? manifest.name, icon)
      }
      className="group flex cursor-default items-start gap-2.5 px-3 py-2 hover:bg-hover/50"
    >
      <div className={ext.disabled ? "opacity-50 grayscale" : ""}>
        <ExtensionIcon src={icon} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`truncate font-medium ${ext.disabled ? "text-fg-muted" : ""}`}>{manifest.displayName ?? manifest.name}</span>
          <span className="shrink-0 text-xs text-fg-subtle">{manifest.version}</span>
        </div>
        <div className="truncate text-xs text-fg-muted">{ext.disabled ? "Disabled" : summarize(ext)}</div>
        {progress && <InstallProgressRing progress={progress} namespace={manifest.publisher} name={manifest.name} className="mt-1.5" />}
      </div>
      {ext.disabled ? (
        <button
          type="button"
          disabled={toggling}
          onClick={(e) => {
            e.stopPropagation();
            void toggle();
          }}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-input-border px-2.5 text-xs hover:bg-hover disabled:opacity-70"
        >
          {toggling && <Loader2 size={12} className="animate-spin" />}
          Enable
        </button>
      ) : (
        <button
          type="button"
          {...tooltipProps("Disable")}
          aria-label={`Disable ${manifest.displayName ?? manifest.name}`}
          disabled={toggling}
          onClick={(e) => {
            e.stopPropagation();
            void toggle();
          }}
          className="invisible flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted group-hover:visible hover:bg-hover hover:text-fg focus-visible:visible"
        >
          {toggling ? <Loader2 size={14} className="animate-spin" /> : <PowerOff size={14} />}
        </button>
      )}
      {update && !progress && (
        <button
          type="button"
          {...tooltipProps(`Update to ${update}`)}
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await installExtension(manifest.publisher, manifest.name);
            } catch (err) {
              await reportError("Could not update the extension", err);
            }
          }}
          className="flex h-7 shrink-0 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-white hover:bg-accent-hover"
        >
          Update
        </button>
      )}
      <button
        type="button"
        {...tooltipProps("Uninstall")}
        aria-label={`Uninstall ${manifest.displayName ?? manifest.name}`}
        disabled={busy}
        onClick={async (e) => {
          e.stopPropagation();
          setBusy(true);
          try {
            await uninstallExtension(ext.id);
          } catch (e) {
            await reportError("Could not uninstall", e);
            setBusy(false);
          }
        }}
        className="invisible flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted group-hover:visible hover:bg-hover hover:text-danger focus-visible:visible"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
      </button>
    </div>
  );
}

function MarketplaceRow({ entry }: { entry: OpenVsxEntry }) {
  const id = `${entry.namespace}.${entry.name}`.toLowerCase();
  const installed = useExtensions((s) => s.installed.some((e) => e.id === id) || s.disabled.some((e) => e.id === id));
  const progress = useInstallProgress(entry.namespace, entry.name);
  const busy = progress !== undefined;
  return (
    <div
      onClick={() =>
        openExtensionPage(entry.namespace, entry.name, entry.displayName ?? entry.name, entry.files.icon)
      }
      className="flex cursor-default items-start gap-2.5 px-3 py-2 hover:bg-hover/50"
    >
      <ExtensionIcon src={entry.files.icon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{entry.displayName ?? entry.name}</span>
          {entry.verified && <BadgeCheck size={13} className="shrink-0 text-accent-hover" />}
        </div>
        <div className="truncate text-xs text-fg-muted">{entry.description}</div>
        <div className="mt-0.5 flex gap-2 text-xs text-fg-subtle">
          <span className="truncate">{entry.namespace}</span>
          {entry.downloadCount !== undefined && (
            <span className="flex shrink-0 items-center gap-0.5">
              <Download size={11} />
              {formatCount(entry.downloadCount)}
            </span>
          )}
        </div>
        {progress && <InstallProgressRing progress={progress} namespace={entry.namespace} name={entry.name} className="mt-1.5" />}
      </div>
      <button
        type="button"
        disabled={busy || installed}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await installExtension(entry.namespace, entry.name);
          } catch (e) {
            await reportError("Could not install the extension", e);
          }
        }}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-input-border px-2.5 text-xs hover:bg-hover disabled:cursor-default disabled:border-transparent disabled:text-fg-subtle disabled:hover:bg-transparent"
      >
        {busy && <Loader2 size={12} className="animate-spin" />}
        {installed ? "Installed" : busy ? "Installing…" : "Install"}
      </button>
    </div>
  );
}

function useOpenVsxSearch(query: string) {
  const [results, setResults] = useState<OpenVsxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const found = await extensionsApi.search(query);
        if (!cancelled) {
          setResults(found);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return { results, loading, error };
}

const COLLAPSED_KEY = "powercode.extensionSections.collapsed";

function storedCollapsed(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Which sections are collapsed, remembered across sessions. */
function useCollapsedSections() {
  const [collapsed, setCollapsed] = useState<string[]>(storedCollapsed);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Not remembering it is harmless.
      }
      return next;
    });
  return { isCollapsed: (id: string) => collapsed.includes(id), toggle };
}

/** A list's title; clicking it collapses or expands the list. */
function Section({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 pt-3 pb-1 text-left text-[11px] font-semibold tracking-wide text-fg-subtle uppercase hover:text-fg-muted"
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        {title}
        {count !== undefined && <span className="ml-1 rounded-full bg-hover px-1.5 font-normal normal-case">{count}</span>}
      </button>
      {!collapsed && children}
    </section>
  );
}

export function ExtensionsView() {
  const [query, setQuery] = useState("");
  const installed = useExtensions((s) => s.installed);
  const disabled = useExtensions((s) => s.disabled);
  const toggleTool = useWorkspace((s) => s.toggleTool);
  const { results, loading, error } = useOpenVsxSearch(query);
  const { isCollapsed, toggle } = useCollapsedSections();
  const searching = query.trim() !== "";

  return (
    <div className="flex h-full flex-col">
      <ToolWindowHeader title="Extensions">
        <IconButton icon={Upload} title="Install from VSIX…" onClick={() => void pickAndInstallVsix()} className="size-7" />
        <IconButton
          icon={RefreshCw}
          title="Check for Extension Updates"
          onClick={() =>
            void checkForUpdates(false).then(
              (ids) => notify("info", ids.length ? `${ids.length} ${ids.length === 1 ? "update" : "updates"} available` : "All extensions are up to date"),
              (e) => notify("error", "Could not check for updates", errorMessage(e)),
            )
          }
          className="size-7"
          size={14}
        />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleTool("extensions")} className="size-7" />
      </ToolWindowHeader>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-input-border bg-input px-2 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-fg-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Open VSX"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <ThemePickers />
        {installed.length > 0 && (
          <Section title="Installed" count={installed.length} collapsed={isCollapsed("installed")} onToggle={() => toggle("installed")}>
            {installed.map((ext) => (
              <InstalledRow key={ext.id} ext={ext} />
            ))}
          </Section>
        )}
        {disabled.length > 0 && (
          <Section title="Disabled" count={disabled.length} collapsed={isCollapsed("disabled")} onToggle={() => toggle("disabled")}>
            {disabled.map((ext) => (
              <InstalledRow key={ext.id} ext={ext} />
            ))}
          </Section>
        )}
        {/* Search results and the popular list fold separately: a search always shows its results. */}
        <Section
          title={searching ? "Results" : "Popular on Open VSX"}
          collapsed={isCollapsed(searching ? "results" : "popular")}
          onToggle={() => toggle(searching ? "results" : "popular")}
        >
          {error && <p className="px-3 py-2 text-danger">{error}</p>}
          {!error && !loading && results.length === 0 && <p className="px-3 py-2 text-fg-muted">No extensions found.</p>}
          {results.map((entry) => (
            <MarketplaceRow key={`${entry.namespace}.${entry.name}`} entry={entry} />
          ))}
        </Section>
      </div>
    </div>
  );
}
