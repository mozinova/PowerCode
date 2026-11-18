import { FileJson, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openUserSettings } from "../exthost/settings";
import { useExtensions } from "../extensions/runtime";
import { BUILTIN_SECTIONS, extensionSections, type SettingDef, type SettingOption, type SettingsSection } from "../settings/registry";
import { useSettingsPage } from "../settings/page";
import { setUserSetting, useUserSettings } from "../settings/store";
import { Select } from "./Select";
import { tooltipProps } from "./Tooltip";


/** Settings descriptions are Markdown; shown as text with `code` and links kept readable. */
function Description({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="rounded bg-white/6 px-1 font-mono text-xs text-fg">
            {part.slice(1, -1)}
          </code>
        ) : (
          // Markdown links and setting references (`#editor.fontSize#`) as plain text.
          part.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/#([\w.]+)#/g, "$1")
        ),
      )}
    </p>
  );
}

const inputClass =
  "h-7 rounded-md border bg-input px-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent";

/** A text or number field that commits on Enter or when it loses focus. */
function TextField({ def, value, onCommit }: { def: SettingDef; value: unknown; onCommit: (value: unknown) => void }) {
  const numeric = def.type === "number" || def.type === "integer";
  const [draft, setDraft] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => setDraft(value === undefined || value === null ? "" : String(value)), [value]);
  const problem = (() => {
    if (!numeric || draft === "") return null;
    const n = Number(draft);
    if (!Number.isFinite(n)) return "Enter a number.";
    if (def.type === "integer" && !Number.isInteger(n)) return "Enter a whole number.";
    if (def.minimum !== undefined && n < def.minimum) return `The minimum is ${def.minimum}.`;
    if (def.maximum !== undefined && n > def.maximum) return `The maximum is ${def.maximum}.`;
    return null;
  })();
  const commit = () => {
    if (problem) return;
    const next = numeric ? (draft === "" ? undefined : Number(draft)) : draft;
    if (next !== value) onCommit(next);
  };
  return (
    <div className="mt-1.5">
      <input
        value={draft}
        inputMode={numeric ? "decimal" : undefined}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(value === undefined || value === null ? "" : String(value));
        }}
        className={`${inputClass} ${numeric ? "w-40" : "w-full max-w-xl"} ${problem ? "border-danger" : "border-input-border"}`}
      />
      {problem && <div className="mt-1 text-xs text-danger">{problem}</div>}
    </div>
  );
}

function EnumField({ options, value, onCommit }: { options: SettingOption[]; value: unknown; onCommit: (value: unknown) => void }) {
  const current = options.find((o) => o.value === value);
  return (
    <div className="mt-1.5 max-w-xs">
      <div className="flex">
        <Select
          options={options.map((o, i) => ({ id: String(i), label: o.label }))}
          value={current ? String(options.indexOf(current)) : ""}
          onChange={(id) => onCommit(options[Number(id)].value)}
        />
      </div>
      {current?.description && <div className="mt-1 text-xs text-fg-subtle">{current.description}</div>}
    </div>
  );
}

function SettingRow({ def }: { def: SettingDef }) {
  // Settings bound to app state use its hooks; the rest read settings.json.
  const bound = def.binding?.use();
  const boundOptions = def.binding?.useOptions?.();
  const stored = useUserSettings((s) => s.values[def.key]);
  const value = def.binding ? bound : (stored ?? def.default);
  const modified = def.binding ? bound !== def.default && def.default !== "" : stored !== undefined;
  const options = boundOptions ?? def.options ?? [];

  const commit = (next: unknown) => {
    if (def.binding) def.binding.set(next);
    // Back to the default removes the key, keeping settings.json minimal.
    else void setUserSetting(def.key, next === undefined || JSON.stringify(next) === JSON.stringify(def.default) ? undefined : next);
  };

  return (
    <div className={`group relative border-l-2 py-2.5 pr-4 pl-4 ${modified ? "border-accent" : "border-transparent"} hover:bg-white/[0.02]`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 text-[13px]">
          <span className="text-fg-muted">{def.group}: </span>
          <span className="font-semibold">{def.title}</span>
        </div>
        {modified && (
          <button
            type="button"
            {...tooltipProps("Reset to Default")}
            aria-label={`Reset ${def.title}`}
            onClick={() => (def.binding ? def.binding.set(def.default) : void setUserSetting(def.key, undefined))}
            className="invisible flex size-5 items-center justify-center rounded text-fg-muted group-hover:visible hover:bg-hover hover:text-fg"
          >
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      {def.type === "boolean" ? (
        <label className="mt-1 flex cursor-pointer items-start gap-2">
          <input type="checkbox" checked={value === true} onChange={(e) => commit(e.target.checked)} className="mt-1 size-3.5 shrink-0 accent-accent" />
          {def.description && <Description text={def.description} />}
        </label>
      ) : (
        <>
          {def.description && <Description text={def.description} />}
          {def.type === "enum" ? (
            <EnumField options={options} value={value} onCommit={commit} />
          ) : def.type === "complex" ? (
            <button type="button" onClick={() => void openUserSettings()} className="mt-1 text-[13px] text-accent-hover hover:underline">
              Edit in settings.json
            </button>
          ) : (
            <TextField def={def} value={value} onCommit={commit} />
          )}
        </>
      )}
      <div className="mt-1 hidden font-mono text-[11px] text-fg-subtle group-hover:block">{def.key}</div>
    </div>
  );
}

function matches(def: SettingDef, section: SettingsSection, words: string[]): boolean {
  const haystack = `${def.key} ${def.group} ${def.title} ${def.description} ${section.title}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** The Settings editor tab: PowerCode's settings, then each extension's. */
export function SettingsPage() {
  const installed = useExtensions((s) => s.installed);
  const { query: initialQuery, nonce } = useSettingsPage();
  const [query, setQuery] = useState(initialQuery);
  const [current, setCurrent] = useState<string>("appearance");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
    searchRef.current?.focus();
  }, [initialQuery, nonce]);

  const sections = useMemo(() => [...BUILTIN_SECTIONS, ...extensionSections(installed)], [installed]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sections
    .map((section) => ({ ...section, settings: section.settings.filter((def) => matches(def, section, words)) }))
    .filter((section) => section.settings.length > 0);
  const count = shown.reduce((n, s) => n + s.settings.length, 0);

  const scrollTo = (id: string) => {
    setCurrent(id);
    listRef.current?.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
  };

  // The navigation follows the section at the top of the list while scrolling.
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    let visible = shown[0]?.id;
    for (const el of list.querySelectorAll<HTMLElement>("[data-section]")) {
      if (el.getBoundingClientRect().top - top <= 24 && el.dataset.section) visible = el.dataset.section;
    }
    if (visible && visible !== current) setCurrent(visible);
  };

  const builtin = shown.filter((s) => !s.extensionId);
  const extensions = shown.filter((s) => s.extensionId);
  const navItem = (section: SettingsSection) => (
    <button
      key={section.id}
      type="button"
      onClick={() => scrollTo(section.id)}
      className={`flex h-7 w-full items-center truncate rounded-md px-2 text-left text-[13px] ${
        current === section.id ? "bg-selected-inactive text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      <span className="truncate">{section.title}</span>
      {words.length > 0 && <span className="ml-auto pl-2 text-xs text-fg-subtle">{section.settings.length}</span>}
    </button>
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-editor">
      <div className="flex shrink-0 items-center gap-2 px-6 pt-5 pb-3">
        <div className="relative max-w-2xl flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search settings"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            className={`${inputClass} h-8 w-full border-input-border pl-8`}
          />
        </div>
        {words.length > 0 && <span className="shrink-0 text-xs text-fg-muted">{count === 1 ? "1 setting" : `${count} settings`}</span>}
        <button
          type="button"
          onClick={() => void openUserSettings()}
          className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <FileJson size={15} />
          Open settings.json
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-56 shrink-0 overflow-y-auto px-3 pb-4">
          <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">PowerCode</div>
          {builtin.map(navItem)}
          {extensions.length > 0 && (
            <div className="px-2 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">Extensions</div>
          )}
          {extensions.map(navItem)}
        </nav>
        <div ref={listRef} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto pr-6 pb-10">
          {shown.length === 0 && <p className="px-4 py-6 text-fg-muted">No settings match "{query}".</p>}
          {shown.map((section) => (
            <section key={section.id} data-section={section.id} className="pb-4">
              <h2 className="sticky top-0 z-10 bg-editor px-4 pt-2 pb-2 text-base font-semibold">{section.title}</h2>
              {section.settings.map((def) => (
                <SettingRow key={def.key} def={def} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
