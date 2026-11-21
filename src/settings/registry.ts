//! Every setting the Settings page shows: PowerCode's own, then those that
//! installed extensions declare in `contributes.configuration`.

import { EDITOR_DEFAULTS } from "../editor/options";
import { setEditorTheme, useExtensions } from "../extensions/runtime";
import { setIconTheme, useIconThemes } from "../extensions/iconThemes";
import type { AiProviderId, InstalledExtension } from "../lib/ipc";
import { setAutoSave, setAutoUpdateExtensions, useSettings } from "../state/settings";
import { setDefaultTerminalProfile, useTerminals } from "../terminal/sessions";
import { createElement, useEffect, type ReactNode } from "react";
import { AiIcon, modelIcon, providerIcon } from "../components/AiIcon";
import { detectAiProviders, loadAiModels, setChatModel, setChatProvider, setCommitProvider, useAi, useChatSelection, useCommitSelection } from "../ai/store";
import { setUserSetting, setting, useUserSettings } from "./store";

export interface SettingOption {
  value: unknown;
  label: string;
  description?: string;
  icon?: ReactNode;
}

export interface SettingDef {
  key: string;
  /** "Editor: Font Size" is shown as the group prefix and the title. */
  group: string;
  title: string;
  description: string;
  type: "boolean" | "number" | "integer" | "string" | "enum" | "complex";
  options?: SettingOption[];
  default: unknown;
  minimum?: number;
  maximum?: number;
  /** Settings kept outside settings.json (themes, auto save, ...). */
  binding?: {
    /** A React hook returning the current value. */
    use: () => unknown;
    set: (value: unknown) => void;
    /** Options computed at render time (installed themes, terminal profiles). */
    useOptions?: () => SettingOption[];
  };
}

export interface SettingsSection {
  id: string;
  title: string;
  /** PowerCode's own sections, or the extension a section comes from. */
  extensionId?: string;
  settings: SettingDef[];
}

const MONO = EDITOR_DEFAULTS.fontFamily;

/** The assistants found, for the AI settings (looking for them the first time). */
function useProviderOptions(): SettingOption[] {
  const providers = useAi((s) => s.providers);
  const detected = useAi((s) => s.detected);
  useEffect(() => void detectAiProviders(), []);
  if (!detected) return [{ value: "", label: "Looking for assistants…" }];
  if (providers.length === 0) return [{ value: "", label: "None found" }];
  return providers.map((p) => ({
    value: p.id,
    label: `${p.name}${p.version ? ` ${p.version}` : ""}`,
    description: p.path,
    icon: createElement(AiIcon, { name: providerIcon(p.id) }),
  }));
}

function useModelOptions(provider: AiProviderId | undefined): SettingOption[] {
  const models = useAi((s) => (provider ? s.models[provider] : undefined));
  const detected = useAi((s) => s.detected);
  useEffect(() => {
    if (provider && detected) void loadAiModels(provider);
  }, [provider, detected]);
  return (models ?? [{ id: "", name: "Default", description: null, contextWindow: null }]).map((m) => ({
    value: m.id,
    label: m.name,
    description: m.description ?? undefined,
    icon: provider ? createElement(AiIcon, { name: modelIcon(provider, m.id) }) : undefined,
  }));
}


const choice = (value: string, label: string, description?: string): SettingOption => ({ value, label, description });

export const BUILTIN_SECTIONS: SettingsSection[] = [
  {
    id: "appearance",
    title: "Appearance",
    settings: [
      {
        key: "workbench.colorTheme",
        group: "Workbench",
        title: "Color Theme",
        description: "The color theme of the editor. Install more from the Extensions view.",
        type: "enum",
        default: "powercode-dark",
        binding: {
          use: () => useExtensions((s) => s.activeThemeId),
          set: (value) => void setEditorTheme(String(value)),
          useOptions: () => useExtensions((s) => s.themes).map((t) => ({ value: t.id, label: t.label })),
        },
      },
      {
        key: "workbench.iconTheme",
        group: "Workbench",
        title: "File Icon Theme",
        description: "The icons of files and folders in the Project view and tabs.",
        type: "enum",
        default: "",
        binding: {
          use: () => useIconThemes((s) => s.activeId),
          set: (value) => void setIconTheme(String(value)),
          useOptions: () => useIconThemes((s) => s.options).map((t) => ({ value: t.id, label: t.label })),
        },
      },
    ],
  },
  {
    id: "editor",
    title: "Editor",
    settings: [
      { key: "editor.fontFamily", group: "Editor", title: "Font Family", description: "Font family of the editor, as a CSS font list.", type: "string", default: MONO },
      { key: "editor.fontSize", group: "Editor", title: "Font Size", description: "Font size in pixels.", type: "number", default: 13, minimum: 6, maximum: 100 },
      { key: "editor.lineHeight", group: "Editor", title: "Line Height", description: "Line height in pixels (0 computes it from the font size).", type: "number", default: 20, minimum: 0, maximum: 150 },
      { key: "editor.fontLigatures", group: "Editor", title: "Font Ligatures", description: "Shows ligatures such as => and != as single glyphs, when the font has them.", type: "boolean", default: true },
      { key: "editor.tabSize", group: "Editor", title: "Tab Size", description: "Spaces a tab is equal to.", type: "integer", default: 4, minimum: 1, maximum: 16 },
      { key: "editor.insertSpaces", group: "Editor", title: "Insert Spaces", description: "Insert spaces when pressing Tab.", type: "boolean", default: true },
      { key: "editor.detectIndentation", group: "Editor", title: "Detect Indentation", description: "Use the indentation of each file's content instead of Tab Size and Insert Spaces.", type: "boolean", default: true },
      {
        key: "editor.wordWrap",
        group: "Editor",
        title: "Word Wrap",
        description: "How lines wrap.",
        type: "enum",
        default: "off",
        options: [
          choice("off", "off", "Lines never wrap."),
          choice("on", "on", "Lines wrap at the viewport width."),
          choice("wordWrapColumn", "wordWrapColumn", "Lines wrap at Word Wrap Column."),
          choice("bounded", "bounded", "Lines wrap at the smaller of the viewport and Word Wrap Column."),
        ],
      },
      { key: "editor.wordWrapColumn", group: "Editor", title: "Word Wrap Column", description: "The column lines wrap at with Word Wrap set to wordWrapColumn or bounded.", type: "integer", default: 80, minimum: 1 },
      {
        key: "editor.lineNumbers",
        group: "Editor",
        title: "Line Numbers",
        description: "How line numbers show.",
        type: "enum",
        default: "on",
        options: [choice("on", "on"), choice("off", "off"), choice("relative", "relative", "Distance to the cursor line."), choice("interval", "interval", "Every 10 lines.")],
      },
      {
        key: "editor.renderWhitespace",
        group: "Editor",
        title: "Render Whitespace",
        description: "When spaces and tabs show as dots and arrows.",
        type: "enum",
        default: "selection",
        options: [choice("none", "none"), choice("boundary", "boundary", "Except single spaces between words."), choice("selection", "selection", "Only in selected text."), choice("trailing", "trailing", "Only trailing whitespace."), choice("all", "all")],
      },
      { key: "editor.minimap.enabled", group: "Editor › Minimap", title: "Enabled", description: "Shows the minimap (a code overview) at the right of the editor.", type: "boolean", default: false },
      { key: "editor.stickyScroll.enabled", group: "Editor › Sticky Scroll", title: "Enabled", description: "Keeps the enclosing scopes' first lines at the top while scrolling.", type: "boolean", default: true },
      { key: "editor.bracketPairColorization.enabled", group: "Editor › Bracket Pair Colorization", title: "Enabled", description: "Colors matching brackets alike.", type: "boolean", default: true },
      { key: "editor.guides.indentation", group: "Editor › Guides", title: "Indentation", description: "Shows indentation guides.", type: "boolean", default: true },
      { key: "editor.smoothScrolling", group: "Editor", title: "Smooth Scrolling", description: "Animates scrolling.", type: "boolean", default: true },
      { key: "editor.inlineSuggest.enabled", group: "Editor › Inline Suggest", title: "Enabled", description: "Shows inline suggestions from extensions as ghost text while typing (Tab accepts).", type: "boolean", default: true },
      { key: "editor.linkedEditing", group: "Editor", title: "Linked Editing", description: "Renames matching ranges together while typing, e.g. an HTML tag's opening and closing names.", type: "boolean", default: false },
      { key: "editor.colorDecorators", group: "Editor", title: "Color Decorators", description: "Shows color swatches (with a picker) next to colors that extensions find.", type: "boolean", default: true },
      {
        key: "editor.cursorBlinking",
        group: "Editor",
        title: "Cursor Blinking",
        description: "How the cursor blinks.",
        type: "enum",
        default: "blink",
        options: ["blink", "smooth", "phase", "expand", "solid"].map((v) => choice(v, v)),
      },
      {
        key: "editor.cursorStyle",
        group: "Editor",
        title: "Cursor Style",
        description: "The shape of the cursor.",
        type: "enum",
        default: "line",
        options: ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"].map((v) => choice(v, v)),
      },
    ],
  },
  {
    id: "files",
    title: "Files",
    settings: [
      {
        key: "files.autoSave",
        group: "Files",
        title: "Auto Save",
        description: "Saves files after a delay since the last edit, and when their tab closes.",
        type: "enum",
        default: "afterDelay",
        options: [choice("off", "off", "Files are only saved explicitly."), choice("afterDelay", "afterDelay", "Files are saved Auto Save Delay after the last edit.")],
        binding: {
          use: () => (useSettings((s) => s.autoSave) ? "afterDelay" : "off"),
          set: (value) => setAutoSave(value === "afterDelay"),
        },
      },
      { key: "files.autoSaveDelay", group: "Files", title: "Auto Save Delay", description: "Milliseconds after the last edit before a file is saved.", type: "integer", default: 1000, minimum: 100 },
    ],
  },
  {
    id: "terminal",
    title: "Terminal",
    settings: [
      {
        key: "terminal.integrated.defaultProfile",
        group: "Terminal › Integrated",
        title: "Default Profile",
        description: "The shell new terminals use.",
        type: "enum",
        default: "",
        binding: {
          use: () => useTerminals((s) => s.defaultProfile) ?? "",
          set: (value) => setDefaultTerminalProfile(String(value)),
          useOptions: () => useTerminals((s) => s.profiles).map((p) => ({ value: p.id, label: p.name })),
        },
      },
      { key: "terminal.integrated.fontFamily", group: "Terminal › Integrated", title: "Font Family", description: "Font family of terminals (empty uses the editor's).", type: "string", default: "" },
      { key: "terminal.integrated.fontSize", group: "Terminal › Integrated", title: "Font Size", description: "Font size of terminals in pixels.", type: "number", default: 13, minimum: 6, maximum: 100 },
    ],
  },
  {
    id: "ai",
    title: "AI",
    settings: [
      {
        key: "ai.provider",
        group: "AI",
        title: "Assistant",
        description: "The AI assistant the AI tool window uses, among those found on this computer: Claude Code, Codex, OpenCode or Antigravity (their command-line programs).",
        type: "enum",
        default: "",
        binding: {
          use: () => useChatSelection().provider?.id ?? "",
          set: (value) => void setChatProvider(value as AiProviderId),
          useOptions: useProviderOptions,
        },
      },
      {
        key: "ai.model",
        group: "AI",
        title: "Model",
        description: "The model the AI tool window uses.",
        type: "enum",
        default: "",
        binding: {
          use: () => useUserSettings((s) => setting("ai.model", "", s.values)),
          set: (value) => setChatModel(String(value)),
          useOptions: () => useModelOptions(useChatSelection().provider?.id),
        },
      },
      {
        key: "ai.commitMessage.provider",
        group: "AI › Commit Message",
        title: "Assistant",
        description: "The assistant that writes commit messages (the sparkle button in the Commit tool window).",
        type: "enum",
        default: "",
        binding: {
          use: () => useUserSettings((s) => setting("ai.commitMessage.provider", "", s.values)),
          set: (value) => void setCommitProvider(String(value)),
          useOptions: () => [{ value: "", label: "Same as the AI tool window" }, ...useProviderOptions().filter((o) => o.value !== "")],
        },
      },
      {
        key: "ai.commitMessage.model",
        group: "AI › Commit Message",
        title: "Model",
        description: "The model that writes commit messages. A fast one is enough.",
        type: "enum",
        default: "",
        binding: {
          use: () => useCommitSelection().model,
          set: (value) => void setUserSetting("ai.commitMessage.model", value || undefined),
          useOptions: () => useModelOptions(useCommitSelection().provider?.id),
        },
      },
      { key: "ai.claude.path", group: "AI › Paths", title: "Claude Code", description: "Path of the claude program. Empty: found on PATH, in the usual install folders or in the Claude Code extension.", type: "string", default: "" },
      { key: "ai.codex.path", group: "AI › Paths", title: "Codex", description: "Path of the codex program. Empty: found on PATH, in the usual install folders or in the Codex extension.", type: "string", default: "" },
      { key: "ai.opencode.path", group: "AI › Paths", title: "OpenCode", description: "Path of the opencode program. Empty: found on PATH or in the usual install folders.", type: "string", default: "" },
      { key: "ai.antigravity.path", group: "AI › Paths", title: "Antigravity", description: "Path of the agy program (Antigravity's CLI). Empty: found on PATH or where Antigravity installs it.", type: "string", default: "" },
    ],
  },
  {
    id: "security",
    title: "Security",
    settings: [
      {
        key: "security.workspace.trust.enabled",
        group: "Security › Workspace › Trust",
        title: "Enabled",
        description:
          "Asks whether you trust a folder the first time it opens, and keeps untrusted folders in Restricted Mode (extensions that do not support it, Git and debugging stay off). Takes effect for folders opened afterwards.",
        type: "boolean",
        default: true,
      },
    ],
  },
  {
    id: "extensions",
    title: "Extensions",
    settings: [
      {
        key: "extensions.autoUpdate",
        group: "Extensions",
        title: "Auto Update",
        description: "Installs extension updates automatically (checked at startup and every 6 hours).",
        type: "boolean",
        default: true,
        binding: {
          use: () => useSettings((s) => s.autoUpdateExtensions),
          set: (value) => setAutoUpdateExtensions(value === true),
        },
      },
    ],
  },
];

// ---- Extensions' settings -------------------------------------------------------------

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** `myExt.formatOnSave` → "Format On Save"; nested keys keep their middle as the group. */
function humanize(segment: string): string {
  return segment
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function settingFromSchema(key: string, schema: any, sectionTitle: string): SettingDef | null {
  if (!schema || typeof schema !== "object" || schema.deprecationMessage || schema.markdownDeprecationMessage) return null;
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type ?? (schema.enum ? "string" : "complex")];
  const type = types.find((t) => t !== "null") ?? "complex";
  const segments = key.split(".");
  const title = humanize(segments[segments.length - 1]);
  const group = segments.length > 2 ? `${sectionTitle} › ${segments.slice(1, -1).map(humanize).join(" › ")}` : sectionTitle;
  const description = text(schema.markdownDescription) || text(schema.description);
  const base = { key, group, title, description, default: schema.default };
  if (Array.isArray(schema.enum)) {
    const descriptions: unknown[] = schema.markdownEnumDescriptions ?? schema.enumDescriptions ?? [];
    const labels: unknown[] = schema.enumItemLabels ?? [];
    return {
      ...base,
      type: "enum",
      options: schema.enum.map((value: unknown, i: number) => ({
        value,
        label: text(labels[i]) || String(value),
        description: text(descriptions[i]) || undefined,
      })),
    };
  }
  if (type === "boolean") return { ...base, type: "boolean" };
  if (type === "number" || type === "integer") return { ...base, type, minimum: schema.minimum, maximum: schema.maximum };
  if (type === "string") return { ...base, type: "string" };
  return { ...base, type: "complex" };
}

/** One section per extension with settings, ordered like its `order` fields. */
export function extensionSections(installed: InstalledExtension[]): SettingsSection[] {
  const sections: SettingsSection[] = [];
  for (const ext of installed) {
    const configuration = (ext.manifest.contributes as any)?.configuration;
    const blocks: any[] = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
    const title = ext.manifest.displayName ?? ext.manifest.name;
    const settings: SettingDef[] = [];
    for (const block of blocks) {
      const entries = Object.entries<any>(block?.properties ?? {}).sort(([, a], [, b]) => (a?.order ?? 1e9) - (b?.order ?? 1e9));
      for (const [key, schema] of entries) {
        const def = settingFromSchema(key, schema, text(block.title) || title);
        if (def) settings.push(def);
      }
    }
    if (settings.length > 0) sections.push({ id: `ext:${ext.id}`, title, extensionId: ext.id, settings });
  }
  return sections.sort((a, b) => a.title.localeCompare(b.title));
}
