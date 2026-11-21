//! Applies the declarative contributions of installed VS Code extensions:
//! languages, language configuration, TextMate grammars, snippets and themes.

import { convertFileSrc } from "@tauri-apps/api/core";
import { parse as parseJsonc } from "jsonc-parser";
import { create } from "zustand";
import { monaco } from "../editor/monaco";
import { attachGrammar, registerGrammar } from "../editor/textmate";
import {
  POWERCODE_DARK,
  POWERCODE_LIGHT,
  POWERCODE_MATRIX,
  applyAppTheme,
  applyEditorTheme,
  type EditorTheme,
} from "../editor/themes";
import { updateTerminalThemes } from "../terminal/sessions";
import { useUserSettings } from "../settings/store";
import { forgetRemovedExtensions } from "../editor/builtinLanguages";
import { joinPath } from "../lib/paths";
import { track } from "../state/activity";
import { errorMessage, extensionsApi, INSTALL_CANCELLED, type DownloadProgress, type InstalledExtension } from "../lib/ipc";
import { ask, notify } from "../state/notifications";
import { useSettings } from "../state/settings";
import {
  BUILTIN_ICON_THEME_ID,
  resetIconThemeIfFrom,
  setIconTheme,
  setIconThemeOptions,
  storedIconThemeId,
  useIconThemes,
} from "./iconThemes";

const THEME_STORAGE_KEY = "powercode.editorTheme";

export interface ThemeOption {
  id: string;
  label: string;
  /** Extension providing the theme; absent for the built-in theme. */
  extensionId?: string;
  load: () => Promise<EditorTheme>;
}

export const BUILTIN_THEMES: ThemeOption[] = [
  {
    id: POWERCODE_DARK.id,
    label: POWERCODE_DARK.label,
    load: async () => POWERCODE_DARK,
  },
  {
    id: POWERCODE_LIGHT.id,
    label: POWERCODE_LIGHT.label,
    load: async () => POWERCODE_LIGHT,
  },
  {
    id: POWERCODE_MATRIX.id,
    label: POWERCODE_MATRIX.label,
    load: async () => POWERCODE_MATRIX,
  },
];

/** Download progress of an install; `downloaded === total` means it is being unpacked. */
export type InstallProgress = DownloadProgress;

interface ExtensionsState {
  /** Installed and enabled: what the editor, the extension host and the views use. */
  installed: InstalledExtension[];
  /** Installed but disabled by the user: nothing of them is loaded. */
  disabled: InstalledExtension[];
  themes: ThemeOption[];
  activeThemeId: string;
  /** Installs in flight, by lower-case `namespace.name`. */
  installing: Record<string, InstallProgress>;
  /** Newer versions on Open VSX, by installed extension id. */
  updates: Record<string, string>;
  /** Installed extensions whose package is for another platform (they need reinstalling). */
  wrongPlatform: Record<string, boolean>;
  /** Several extensions are being installed: the extension host restarts once, when they are done. */
  batchInstalling: boolean;
}

export const useExtensions = create<ExtensionsState>(() => ({
  installed: [],
  disabled: [],
  themes: [...BUILTIN_THEMES],
  activeThemeId: BUILTIN_THEMES[0].id,
  installing: {},
  updates: {},
  wrongPlatform: {},
  batchInstalling: false,
}));

/** Disposables of each activated extension, for uninstalling without a restart. */
const activations = new Map<string, monaco.IDisposable[]>();

async function readJsonc<T>(extensionId: string, path: string): Promise<T> {
  return parseJsonc(await extensionsApi.readFile(extensionId, path), [], {
    allowTrailingComma: true,
  }) as T;
}

function dirname(path: string) {
  return path.replace(/[^/\\]*$/, "");
}

type RawRegExp = string | { pattern: string; flags?: string } | undefined;

function toRegExp(value: RawRegExp): RegExp | undefined {
  if (!value) return undefined;
  try {
    return typeof value === "string" ? new RegExp(value) : new RegExp(value.pattern, value.flags);
  } catch {
    // Some VS Code patterns use Oniguruma-only syntax.
    return undefined;
  }
}

type RawPair = [string, string] | { open: string; close: string; notIn?: string[] };

function toPairs(pairs: RawPair[] | undefined) {
  return pairs?.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p));
}

const INDENT_ACTIONS: Record<string, monaco.languages.IndentAction> = {
  none: monaco.languages.IndentAction.None,
  indent: monaco.languages.IndentAction.Indent,
  indentOutdent: monaco.languages.IndentAction.IndentOutdent,
  outdent: monaco.languages.IndentAction.Outdent,
};

// The raw VS Code JSON below is loosely typed on purpose.
function toLanguageConfiguration(raw: any): monaco.languages.LanguageConfiguration {
  const lineComment = raw.comments?.lineComment;
  return {
    comments: raw.comments && {
      lineComment: typeof lineComment === "object" ? lineComment?.comment : lineComment,
      blockComment: raw.comments.blockComment,
    },
    brackets: raw.brackets,
    autoClosingPairs: toPairs(raw.autoClosingPairs),
    surroundingPairs: toPairs(raw.surroundingPairs),
    wordPattern: toRegExp(raw.wordPattern),
    indentationRules: raw.indentationRules && {
      increaseIndentPattern: toRegExp(raw.indentationRules.increaseIndentPattern) ?? /^$/,
      decreaseIndentPattern: toRegExp(raw.indentationRules.decreaseIndentPattern) ?? /^$/,
      indentNextLinePattern: toRegExp(raw.indentationRules.indentNextLinePattern),
      unIndentedLinePattern: toRegExp(raw.indentationRules.unIndentedLinePattern),
    },
    folding: raw.folding && {
      offSide: raw.folding.offSide,
      markers: raw.folding.markers && {
        start: toRegExp(raw.folding.markers.start) ?? /^$/,
        end: toRegExp(raw.folding.markers.end) ?? /^$/,
      },
    },
    onEnterRules: raw.onEnterRules
      ?.map((rule: any) => ({
        beforeText: toRegExp(rule.beforeText),
        afterText: toRegExp(rule.afterText),
        previousLineText: toRegExp(rule.previousLineText),
        action: {
          indentAction: INDENT_ACTIONS[rule.action?.indent] ?? monaco.languages.IndentAction.None,
          appendText: rule.action?.appendText,
          removeText: rule.action?.removeText,
        },
      }))
      .filter((rule: any) => rule.beforeText),
  };
}

interface RawSnippet {
  prefix: string | string[];
  body: string | string[];
  description?: string | string[];
  /** Comma-separated languages, in a contribution without a `language`. */
  scope?: string;
}

/** The languages a snippet names in its `scope`; none means every language. */
function snippetScopes(snippet: RawSnippet): string[] {
  return typeof snippet.scope === "string"
    ? snippet.scope.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}

/**
 * A contribution with a `language` gives every snippet of its file to that language.
 * One without (usually a `.code-snippets` file) leaves it to each snippet's `scope`,
 * and a snippet without a scope is for every language, as in VS Code. Those are
 * registered per scoped language once the file is read: a `*` registration ranks
 * below a language's own providers, and Monaco stops at the first group that suggests.
 */
function registerSnippets(extensionId: string, language: unknown, path: string): monaco.IDisposable {
  let snippets: Promise<RawSnippet[]> | null = null;
  const load = () =>
    (snippets ??= readJsonc<Record<string, RawSnippet>>(extensionId, path).then((file) =>
      Object.values(file ?? {}).filter((s) => s && s.prefix && s.body),
    ));
  if (typeof language === "string" && language) {
    return monaco.languages.registerCompletionItemProvider(language, snippetProvider(load, () => true));
  }
  const registrations: monaco.IDisposable[] = [];
  let disposed = false;
  load()
    .then((list) => {
      if (disposed) return;
      const languages = new Set(list.flatMap((s) => {
        const scopes = snippetScopes(s);
        return scopes.length ? scopes : ["*"];
      }));
      for (const id of languages) {
        const applies = id === "*" ? (s: RawSnippet) => snippetScopes(s).length === 0 : (s: RawSnippet) => snippetScopes(s).includes(id);
        registrations.push(monaco.languages.registerCompletionItemProvider(id, snippetProvider(load, applies)));
      }
    })
    .catch((e) => console.warn(`[${extensionId}] invalid snippets ${path}`, e));
  return {
    dispose() {
      disposed = true;
      registrations.forEach((r) => r.dispose());
    },
  };
}

function snippetProvider(
  load: () => Promise<RawSnippet[]>,
  applies: (snippet: RawSnippet) => boolean,
): monaco.languages.CompletionItemProvider {
  return {
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const suggestions = (await load()).filter(applies).flatMap((snippet) => {
        const body = Array.isArray(snippet.body) ? snippet.body.join("\n") : snippet.body;
        const description = Array.isArray(snippet.description)
          ? snippet.description.join("\n")
          : snippet.description;
        const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
        return prefixes.map((prefix) => ({
          label: prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: description,
          range,
        }));
      });
      return { suggestions };
    },
  };
}

async function loadThemeFile(
  extensionId: string,
  path: string,
): Promise<Pick<EditorTheme, "colors" | "tokenColors" | "semanticHighlighting" | "semanticTokenColors">> {
  const raw = await readJsonc<any>(extensionId, path);
  const base: Pick<EditorTheme, "colors" | "tokenColors" | "semanticHighlighting" | "semanticTokenColors"> = raw.include
    ? await loadThemeFile(extensionId, dirname(path) + raw.include)
    : { colors: {}, tokenColors: [] };
  return {
    colors: { ...base.colors, ...raw.colors },
    semanticHighlighting: typeof raw.semanticHighlighting === "boolean" ? raw.semanticHighlighting : base.semanticHighlighting,
    semanticTokenColors: { ...base.semanticTokenColors, ...(raw.semanticTokenColors && typeof raw.semanticTokenColors === "object" ? raw.semanticTokenColors : {}) },
    // `tokenColors` may also point to a .tmTheme file, which is not supported yet.
    tokenColors: [
      ...base.tokenColors,
      ...(Array.isArray(raw.tokenColors) ? raw.tokenColors : []).filter(
        (s: any) => s && typeof s === "object" && s.settings && typeof s.settings === "object",
      ),
    ],
  };
}

const MONACO_BASES: Record<string, monaco.editor.BuiltinTheme> = {
  vs: "vs",
  "vs-dark": "vs-dark",
  "hc-black": "hc-black",
  "hc-light": "hc-light",
};

function themeOptions(ext: InstalledExtension): ThemeOption[] {
  return (ext.manifest.contributes?.themes ?? []).map((theme) => {
    // Monaco theme names may only contain letters, digits and dashes.
    const id = `${ext.id}-${theme.id ?? theme.label}`.replace(/[^a-z0-9-]+/gi, "-");
    return {
      id,
      label: theme.label,
      extensionId: ext.id,
      load: async () => ({
        id,
        label: theme.label,
        base: MONACO_BASES[theme.uiTheme] ?? "vs-dark",
        ...(await loadThemeFile(ext.id, theme.path)),
      }),
    };
  });
}

async function activate(ext: InstalledExtension) {
  const contributes = ext.manifest.contributes ?? {};
  const disposables: monaco.IDisposable[] = [];
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));

  for (const language of contributes.languages ?? []) {
    monaco.languages.register({
      id: language.id,
      extensions: language.extensions,
      filenames: language.filenames,
      aliases: language.aliases,
    });
    known.add(language.id);
    if (language.configuration) {
      try {
        const raw = await readJsonc(ext.id, language.configuration);
        disposables.push(
          monaco.languages.setLanguageConfiguration(language.id, toLanguageConfiguration(raw)),
        );
      } catch (e) {
        console.warn(`[${ext.id}] invalid language configuration`, e);
      }
    }
  }

  for (const grammar of contributes.grammars ?? []) {
    registerGrammar(
      grammar.scopeName,
      async () => ({ content: await extensionsApi.readFile(ext.id, grammar.path), path: grammar.path }),
      grammar.injectTo,
    );
    if (grammar.language && known.has(grammar.language)) {
      disposables.push(attachGrammar(grammar.language, grammar.scopeName));
    }
  }

  for (const snippet of contributes.snippets ?? []) {
    disposables.push(registerSnippets(ext.id, snippet.language, snippet.path));
  }

  activations.set(ext.id, disposables);
}

function deactivate(id: string) {
  activations.get(id)?.forEach((d) => d.dispose());
  activations.delete(id);
}

function setInstalled(installed: InstalledExtension[]) {
  useExtensions.setState({
    installed,
    themes: [...BUILTIN_THEMES, ...installed.flatMap(themeOptions)],
  });
  setIconThemeOptions(installed);
}

export async function setEditorTheme(id: string) {
  const option = useExtensions.getState().themes.find((t) => t.id === id) ?? BUILTIN_THEMES[0];
  const theme = await option.load();
  await applyEditorTheme(theme);
  updateTerminalThemes(option.id);
  useExtensions.setState({ activeThemeId: option.id });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, option.id);
  } catch {
    // Storage may be unavailable; the theme just won't persist.
  }
}

function storedThemeId(): string {
  try {
    const fromSettings = useUserSettings.getState().values["workbench.colorTheme"];
    if (typeof fromSettings === "string" && fromSettings) return fromSettings;
    return localStorage.getItem(THEME_STORAGE_KEY) ?? BUILTIN_THEMES[0].id;
  } catch {
    return BUILTIN_THEMES[0].id;
  }
}

// Apply the theme to the workbench immediately so the window never flashes the wrong colours.
applyAppTheme(storedThemeId());

export function initExtensions() {
  return track("Loading extensions…", loadExtensions);
}

async function loadExtensions() {
  let all: InstalledExtension[] = [];
  try {
    all = await extensionsApi.list();
  } catch (e) {
    console.error("Failed to list extensions", e);
  }
  const installed = all.filter((ext) => !ext.disabled);
  for (const ext of installed) {
    await activate(ext).catch((e) => console.error(`Failed to activate ${ext.id}`, e));
  }
  useExtensions.setState({ disabled: all.filter((ext) => ext.disabled) });
  setInstalled(installed);
  forgetRemovedExtensions(installed.map((e) => e.id));
  await setEditorTheme(storedThemeId()).catch(() => setEditorTheme(BUILTIN_THEMES[0].id));
  await setIconTheme(storedIconThemeId()).catch(() => setIconTheme(BUILTIN_ICON_THEME_ID));
  offerMissingDependencies();
  // Imported here, not at the top: builtinExtensions.ts imports this module.
  void import("./builtinExtensions").then((m) => m.installBuiltinExtensions());
}

/** Extensions installed without what they depend on (e.g. before PowerCode installed dependencies): offer them. */
function offerMissingDependencies() {
  const missing = missingDependencies();
  if (missing.length === 0) return;
  const details = missing.map((m) => `${m.id} (needed by ${m.neededBy.join(", ")})`).join(", ");
  void ask("info", "Some extensions need others that are not installed", details, ["Install"]).then(async (choice) => {
    if (choice !== 0) return;
    for (const { id } of missing) {
      const dot = id.indexOf(".");
      if (dot <= 0 || isInstalled(id)) continue;
      await installExtension(id.slice(0, dot), id.slice(dot + 1)).catch((e) => notify("error", `Could not install ${id}`, errorMessage(e)));
    }
  });
}

function setInstalling(id: string, progress: InstallProgress | null) {
  useExtensions.setState(({ installing }) => {
    const next = { ...installing };
    if (progress) next[id] = progress;
    else delete next[id];
    return { installing: next };
  });
}

/** Installs (or updates) from Open VSX; null when the user cancelled the download. */
export async function installExtension(namespace: string, name: string, dependencyOf?: Set<string>): Promise<InstalledExtension | null> {
  const key = `${namespace}.${name}`.toLowerCase();
  setInstalling(key, { downloaded: 0, total: null });
  let ext: InstalledExtension;
  try {
    ext = await track(`Installing ${name}…`, () =>
      extensionsApi.install(namespace, name, (progress) => setInstalling(key, progress)),
    );
  } catch (e) {
    if (errorMessage(e) === INSTALL_CANCELLED) return null;
    throw e;
  } finally {
    setInstalling(key, null);
  }
  await finishInstall(ext);
  // While installing another extension's dependencies, that installation goes on through them.
  if (dependencyOf) await installDependencies(ext, dependencyOf);
  else await installDependencies(ext);
  return ext;
}

/** The extensions `ext` needs (`extensionDependencies`) or bundles (`extensionPack`), by id. */
function dependenciesOf(ext: InstalledExtension): string[] {
  const manifest = ext.manifest as InstalledExtension["manifest"] & { extensionDependencies?: unknown; extensionPack?: unknown };
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  return [...new Set([...list(manifest.extensionDependencies), ...list(manifest.extensionPack)].map((id) => id.toLowerCase()))];
}

/** Extensions PowerCode provides itself (the Git API and the GitHub sign-in, in the extension host): never missing. */
const BUILTIN_EXTENSION_IDS = ["vscode.git", "vscode.git-base", "vscode.github-authentication"];

const isInstalled = (id: string) => {
  const { installed, disabled } = useExtensions.getState();
  return BUILTIN_EXTENSION_IDS.includes(id) || installed.some((e) => e.id === id) || disabled.some((e) => e.id === id);
};

/** Dependencies of the installed extensions that are not installed, with who needs them. */
export function missingDependencies(): { id: string; neededBy: string[] }[] {
  const missing = new Map<string, string[]>();
  for (const ext of useExtensions.getState().installed) {
    for (const id of dependenciesOf(ext)) {
      if (!isInstalled(id)) missing.set(id, [...(missing.get(id) ?? []), ext.manifest.displayName ?? ext.manifest.name]);
    }
  }
  return [...missing].map(([id, neededBy]) => ({ id, neededBy }));
}

/**
 * Installs from Open VSX what `ext` depends on and is not installed yet (and their own
 * dependencies), as VS Code does. Reports what was installed and what could not be.
 */
export async function installDependencies(ext: InstalledExtension, seen = new Set<string>([ext.id])) {
  const installed: string[] = [];
  const failed: string[] = [];
  const visit = async (from: InstalledExtension) => {
    for (const id of dependenciesOf(from)) {
      if (seen.has(id) || isInstalled(id)) continue;
      seen.add(id);
      const dot = id.indexOf(".");
      if (dot <= 0) continue;
      try {
        const dependency = await installExtension(id.slice(0, dot), id.slice(dot + 1), seen);
        if (dependency) installed.push(dependency.manifest.displayName ?? dependency.manifest.name);
      } catch (e) {
        failed.push(`${id}: ${errorMessage(e)}`);
      }
    }
  };
  await visit(ext);
  const name = ext.manifest.displayName ?? ext.manifest.name;
  if (installed.length) notify("success", `Installed what ${name} needs`, installed.join(", "));
  if (failed.length) notify("error", `${name} is missing extensions it needs`, failed.join("\n"));
}

/** Stops the download of an install in flight; what was installed before stays. */
export function cancelInstall(namespace: string, name: string) {
  return extensionsApi.cancelInstall(`${namespace}.${name}`.toLowerCase());
}

/**
 * Installs extensions from .vsix files on this computer, one after another; reports
 * each result. Returns the ones installed.
 */
export async function installVsixFiles(paths: string[]): Promise<InstalledExtension[]> {
  const installed: InstalledExtension[] = [];
  for (const path of paths) {
    const file = path.split(/[\\/]/).pop() ?? path;
    try {
      const ext = await track(`Installing ${file}…`, () => extensionsApi.installVsix(path));
      await finishInstall(ext);
      await installDependencies(ext);
      installed.push(ext);
      notify("success", `Installed ${ext.manifest.displayName ?? ext.manifest.name} ${ext.manifest.version}`, `From ${file}`);
    } catch (e) {
      notify("error", `Could not install ${file}`, errorMessage(e));
    }
  }
  return installed;
}

/** Applies a just-installed (or reinstalled) extension: contributions, the list, themes. */
async function finishInstall(ext: InstalledExtension) {
  // An update of a disabled extension stays disabled.
  if (ext.disabled) {
    useExtensions.setState(({ disabled }) => ({ disabled: sortById([...disabled.filter((e) => e.id !== ext.id), ext]) }));
  } else {
    deactivate(ext.id);
    await activate(ext);
    const others = useExtensions.getState().installed.filter((e) => e.id !== ext.id);
    setInstalled(sortById([...others, ext]));
  }
  useExtensions.setState(({ updates, wrongPlatform }) => {
    const { [ext.id]: _installed, ...rest } = updates;
    const { [ext.id]: _fixed, ...otherPlatforms } = wrongPlatform;
    return { updates: rest, wrongPlatform: otherPlatforms };
  });
  await reapplyThemesFrom(ext.id);
}

const sortById = (list: InstalledExtension[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Turns an installed extension off or on. Off, nothing of it is loaded: its
 * grammars, snippets, themes and icon themes go, and the extension host restarts
 * without it. (Languages it registered stay known to the editor until a restart.)
 */
export async function setExtensionEnabled(id: string, enabled: boolean) {
  const { installed, disabled, themes, activeThemeId } = useExtensions.getState();
  if (enabled) {
    const ext = disabled.find((e) => e.id === id);
    if (!ext) return;
    await extensionsApi.setEnabled(id, true);
    const turnedOn = { ...ext, disabled: false };
    useExtensions.setState({ disabled: disabled.filter((e) => e.id !== id) });
    await activate(turnedOn);
    setInstalled(sortById([...useExtensions.getState().installed, turnedOn]));
    return;
  }
  const ext = installed.find((e) => e.id === id);
  if (!ext) return;
  await extensionsApi.setEnabled(id, false);
  deactivate(id);
  const usedActiveTheme = themes.some((t) => t.id === activeThemeId && t.extensionId === id);
  // Before its options are dropped, while its active icon theme is still recognisable.
  await resetIconThemeIfFrom(id);
  useExtensions.setState({ disabled: sortById([...disabled, { ...ext, disabled: true }]) });
  setInstalled(installed.filter((e) => e.id !== id));
  if (usedActiveTheme) await setEditorTheme(BUILTIN_THEMES[0].id);
}

/** After an update, themes from the extension are reloaded so their new colours show. */
async function reapplyThemesFrom(extensionId: string) {
  const { themes, activeThemeId } = useExtensions.getState();
  if (themes.some((t) => t.id === activeThemeId && t.extensionId === extensionId)) {
    await setEditorTheme(activeThemeId).catch(() => {});
  }
  const icons = useIconThemes.getState();
  if (icons.options.some((o) => o.id === icons.activeId && o.extensionId === extensionId)) {
    await setIconTheme(icons.activeId).catch(() => {});
  }
}

/** Compares dotted versions numerically; a pre-release (`1.2.0-beta`) is older than its release. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true;
  if (b.pre === null) return false;
  return a.pre > b.pre;
}

const openVsxId = (ext: InstalledExtension) => `${ext.manifest.publisher}.${ext.manifest.name}`;

/**
 * Looks up newer versions of the installed extensions; with `install`, also
 * installs them. Returns the ids that have (or had) an update.
 */
export async function checkForUpdates(install: boolean): Promise<string[]> {
  // Disabled extensions are kept up to date too, ready for when they are enabled.
  const installed = [...useExtensions.getState().installed, ...useExtensions.getState().disabled];
  if (installed.length === 0) return [];
  const latest = await track("Checking for extension updates…", () =>
    extensionsApi.latestVersions(installed.map(openVsxId)),
  );
  // A package for another platform (e.g. Linux binaries on Windows) is replaced like an update.
  const outdated = installed.filter((ext) => {
    const info = latest[openVsxId(ext)];
    return info !== undefined && (info.wrongPlatform || isNewerVersion(info.version, ext.manifest.version));
  });
  useExtensions.setState({
    updates: Object.fromEntries(outdated.map((ext) => [ext.id, latest[openVsxId(ext)].version])),
    wrongPlatform: Object.fromEntries(outdated.filter((ext) => latest[openVsxId(ext)].wrongPlatform).map((ext) => [ext.id, true])),
  });
  if (install) {
    const updated: string[] = [];
    for (const ext of outdated) {
      try {
        if (await installExtension(ext.manifest.publisher, ext.manifest.name)) updated.push(ext.manifest.displayName ?? ext.manifest.name);
      } catch (e) {
        notify("error", `Could not update ${ext.manifest.displayName ?? ext.manifest.name}`, errorMessage(e));
      }
    }
    if (updated.length > 0) notify("success", `Updated ${updated.length} ${updated.length === 1 ? "extension" : "extensions"}`, updated.join(", "));
  }
  return outdated.map((ext) => ext.id);
}

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

/** Checks shortly after startup and every 6 hours, installing updates when auto update is on. */
export function startExtensionUpdates() {
  const run = () =>
    void checkForUpdates(useSettings.getState().autoUpdateExtensions).catch(() => {
      // Offline or Open VSX unreachable: try again next time.
    });
  window.setTimeout(run, FIRST_CHECK_DELAY_MS);
  window.setInterval(run, UPDATE_INTERVAL_MS);
}

export async function uninstallExtension(id: string) {
  await extensionsApi.uninstall(id);
  deactivate(id);
  const { installed, themes, activeThemeId } = useExtensions.getState();
  const removedActiveTheme = themes.some((t) => t.id === activeThemeId && t.extensionId === id);
  // Before the extension's options are dropped, while its active theme is still recognisable.
  await resetIconThemeIfFrom(id);
  useExtensions.setState(({ disabled }) => ({ disabled: disabled.filter((e) => e.id !== id) }));
  setInstalled(installed.filter((e) => e.id !== id));
  if (removedActiveTheme) await setEditorTheme(BUILTIN_THEMES[0].id);
}

/** URL of an installed extension's own icon, if it declares one. */
export function installedIconUrl(ext: InstalledExtension): string | undefined {
  return ext.manifest.icon ? convertFileSrc(joinPath(ext.path, ext.manifest.icon)) : undefined;
}
