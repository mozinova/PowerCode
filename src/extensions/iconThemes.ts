//! File icon themes contributed by VS Code extensions (`contributes.iconThemes`).
//! Icons are resolved with VS Code's precedence: file name, then compound and
//! simple extensions, then language id, then the theme's default.

import { convertFileSrc } from "@tauri-apps/api/core";
import { parse as parseJsonc } from "jsonc-parser";
import { create } from "zustand";
import { monaco } from "../editor/monaco";
import { extensionsApi, type InstalledExtension } from "../lib/ipc";
import { joinPath } from "../lib/paths";

const STORAGE_KEY = "powercode.iconTheme";
const FONT_STYLE_ID = "powercode-icon-theme-fonts";

export type IconDefinition =
  | { kind: "image"; src: string }
  | { kind: "font"; character: string; fontFamily?: string; color?: string; size?: string };

type NameMap = Record<string, string>;

interface RawIconTheme {
  iconDefinitions?: Record<
    string,
    { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }
  >;
  fonts?: { id: string; src: { path: string; format?: string }[]; weight?: string; style?: string; size?: string }[];
  file?: string;
  folder?: string;
  folderExpanded?: string;
  rootFolder?: string;
  rootFolderExpanded?: string;
  fileExtensions?: NameMap;
  fileNames?: NameMap;
  folderNames?: NameMap;
  folderNamesExpanded?: NameMap;
  rootFolderNames?: NameMap;
  rootFolderNamesExpanded?: NameMap;
  languageIds?: NameMap;
}

/** Name lookups are case-insensitive, as in VS Code. */
function lowerKeys(map: NameMap | undefined): NameMap | undefined {
  return map && Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
}

function languageForFile(lowerName: string): string | undefined {
  const languages = monaco.languages.getLanguages();
  const byName = languages.find((l) => l.filenames?.some((f) => f.toLowerCase() === lowerName));
  if (byName) return byName.id;
  let best: string | undefined;
  let bestLength = 0;
  for (const language of languages) {
    for (const ext of language.extensions ?? []) {
      const e = ext.toLowerCase();
      if (lowerName.endsWith(e) && e.length > bestLength) {
        best = language.id;
        bestLength = e.length;
      }
    }
  }
  return best;
}

export class ResolvedIconTheme {
  private readonly cache = new Map<string, IconDefinition | null>();

  constructor(
    private readonly raw: RawIconTheme,
    private readonly definitions: Map<string, IconDefinition>,
  ) {}

  private memo(key: string, resolve: () => string | undefined): IconDefinition | null {
    let icon = this.cache.get(key);
    if (icon === undefined) {
      const id = resolve();
      icon = (id && this.definitions.get(id)) || null;
      this.cache.set(key, icon);
    }
    return icon;
  }

  forFile(name: string): IconDefinition | null {
    const lower = name.toLowerCase();
    return this.memo(`file:${lower}`, () => {
      const { raw } = this;
      let id = raw.fileNames?.[lower];
      // `a.test.ts` tries `test.ts`, then `ts`.
      for (let ext = lower, dot = ext.indexOf("."); !id && dot >= 0; dot = ext.indexOf(".")) {
        ext = ext.slice(dot + 1);
        id = raw.fileExtensions?.[ext];
      }
      if (!id) {
        const language = languageForFile(lower);
        if (language) id = raw.languageIds?.[language];
      }
      return id ?? raw.file;
    });
  }

  forFolder(name: string, expanded: boolean, root: boolean): IconDefinition | null {
    const lower = name.toLowerCase();
    return this.memo(`folder:${expanded}:${root}:${lower}`, () => {
      const { raw } = this;
      let id = root
        ? (expanded ? raw.rootFolderNamesExpanded?.[lower] : undefined) ?? raw.rootFolderNames?.[lower]
        : undefined;
      id ??= (expanded ? raw.folderNamesExpanded?.[lower] : undefined) ?? raw.folderNames?.[lower];
      if (root) id ??= expanded ? (raw.rootFolderExpanded ?? raw.rootFolder) : raw.rootFolder;
      id ??= expanded ? (raw.folderExpanded ?? raw.folder) : raw.folder;
      return id;
    });
  }
}

/** Resolves `.`/`..` in a path relative to the extension root. */
function normalizeRelative(path: string): string {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** `"\\E001"` in theme JSON is a CSS-style escape for U+E001. */
function decodeFontCharacter(value: string): string {
  const hex = /^\\([0-9a-f]+)$/i.exec(value);
  return hex ? String.fromCodePoint(parseInt(hex[1], 16)) : value;
}

async function loadIconTheme(ext: InstalledExtension, themePath: string): Promise<ResolvedIconTheme> {
  const raw = parseJsonc(await extensionsApi.readFile(ext.id, themePath), [], {
    allowTrailingComma: true,
  }) as RawIconTheme;
  const themeDir = themePath.replace(/[^/\\]*$/, "");
  const assetUrl = (relative: string) =>
    convertFileSrc(joinPath(ext.path, normalizeRelative(themeDir + relative)));

  const families = new Map<string, string>();
  let css = "";
  for (const font of raw.fonts ?? []) {
    const family = `pc-icons-${ext.id}-${font.id}`.replace(/[^a-z0-9-]+/gi, "-");
    families.set(font.id, family);
    const src = font.src.map((s) => `url("${assetUrl(s.path)}") format("${s.format ?? "woff"}")`).join(", ");
    css += `@font-face{font-family:"${family}";src:${src};font-weight:${font.weight ?? "normal"};font-style:${font.style ?? "normal"};font-display:block}`;
  }
  let style = document.getElementById(FONT_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = FONT_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;

  const defaultFont = raw.fonts?.[0];
  const definitions = new Map<string, IconDefinition>();
  for (const [id, def] of Object.entries(raw.iconDefinitions ?? {})) {
    if (def.iconPath) {
      definitions.set(id, { kind: "image", src: assetUrl(def.iconPath) });
    } else if (def.fontCharacter) {
      definitions.set(id, {
        kind: "font",
        character: decodeFontCharacter(def.fontCharacter),
        fontFamily: families.get(def.fontId ?? defaultFont?.id ?? ""),
        color: def.fontColor,
        size: def.fontSize ?? defaultFont?.size,
      });
    }
  }

  return new ResolvedIconTheme(
    {
      ...raw,
      fileExtensions: lowerKeys(raw.fileExtensions),
      fileNames: lowerKeys(raw.fileNames),
      folderNames: lowerKeys(raw.folderNames),
      folderNamesExpanded: lowerKeys(raw.folderNamesExpanded),
      rootFolderNames: lowerKeys(raw.rootFolderNames),
      rootFolderNamesExpanded: lowerKeys(raw.rootFolderNamesExpanded),
    },
    definitions,
  );
}

export interface IconThemeOption {
  id: string;
  label: string;
  /** Extension providing the theme; absent for the built-in icons. */
  extensionId?: string;
  load: () => Promise<ResolvedIconTheme | null>;
}

const BUILTIN: IconThemeOption = { id: "powercode", label: "PowerCode (built-in)", load: async () => null };

interface IconThemesState {
  options: IconThemeOption[];
  activeId: string;
  /** Null when the built-in icons are used. */
  theme: ResolvedIconTheme | null;
}

export const useIconThemes = create<IconThemesState>(() => ({
  options: [BUILTIN],
  activeId: BUILTIN.id,
  theme: null,
}));

export function setIconThemeOptions(installed: InstalledExtension[]) {
  const contributed = installed.flatMap((ext) =>
    (ext.manifest.contributes?.iconThemes ?? []).map((theme) => ({
      id: `${ext.id}:${theme.id}`,
      label: theme.label ?? theme.id,
      extensionId: ext.id,
      load: () => loadIconTheme(ext, theme.path),
    })),
  );
  useIconThemes.setState({ options: [BUILTIN, ...contributed] });
}

export async function setIconTheme(id: string) {
  const option = useIconThemes.getState().options.find((o) => o.id === id) ?? BUILTIN;
  const theme = await option.load();
  useIconThemes.setState({ activeId: option.id, theme });
  try {
    localStorage.setItem(STORAGE_KEY, option.id);
  } catch {
    // Storage may be unavailable; the choice just won't persist.
  }
}

export function storedIconThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? BUILTIN.id;
  } catch {
    return BUILTIN.id;
  }
}

export function resetIconThemeIfFrom(extensionId: string) {
  const { options, activeId } = useIconThemes.getState();
  if (options.some((o) => o.id === activeId && o.extensionId === extensionId)) {
    return setIconTheme(BUILTIN.id);
  }
}

export const BUILTIN_ICON_THEME_ID = BUILTIN.id;
