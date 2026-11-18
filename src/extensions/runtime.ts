//! Applies the declarative contributions of installed VS Code extensions:
//! languages, language configuration, TextMate grammars, snippets and themes.

import { convertFileSrc } from "@tauri-apps/api/core";
import { parse as parseJsonc } from "jsonc-parser";
import { create } from "zustand";
import { monaco } from "../editor/monaco";
import { attachGrammar, registerGrammar } from "../editor/textmate";
import { POWERCODE_DARK, applyEditorTheme, type EditorTheme } from "../editor/themes";
import { joinPath } from "../lib/paths";
import { track } from "../state/activity";
import { extensionsApi, type DownloadProgress, type InstalledExtension } from "../lib/ipc";
import {
  BUILTIN_ICON_THEME_ID,
  resetIconThemeIfFrom,
  setIconTheme,
  setIconThemeOptions,
  storedIconThemeId,
} from "./iconThemes";

const THEME_STORAGE_KEY = "powercode.editorTheme";

export interface ThemeOption {
  id: string;
  label: string;
  /** Extension providing the theme; absent for the built-in theme. */
  extensionId?: string;
  load: () => Promise<EditorTheme>;
}

const BUILTIN_THEME: ThemeOption = {
  id: POWERCODE_DARK.id,
  label: POWERCODE_DARK.label,
  load: async () => POWERCODE_DARK,
};

/** Download progress of an install; `downloaded === total` means it is being unpacked. */
export type InstallProgress = DownloadProgress;

interface ExtensionsState {
  installed: InstalledExtension[];
  themes: ThemeOption[];
  activeThemeId: string;
  /** Installs in flight, by lower-case `namespace.name`. */
  installing: Record<string, InstallProgress>;
}

export const useExtensions = create<ExtensionsState>(() => ({
  installed: [],
  themes: [BUILTIN_THEME],
  activeThemeId: BUILTIN_THEME.id,
  installing: {},
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
}

function registerSnippets(extensionId: string, language: string, path: string) {
  let snippets: Promise<RawSnippet[]> | null = null;
  return monaco.languages.registerCompletionItemProvider(language, {
    async provideCompletionItems(model, position) {
      snippets ??= readJsonc<Record<string, RawSnippet>>(extensionId, path).then((file) =>
        Object.values(file ?? {}).filter((s) => s && s.prefix && s.body),
      );
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      const suggestions = (await snippets).flatMap((snippet) => {
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
  });
}

async function loadThemeFile(
  extensionId: string,
  path: string,
): Promise<Pick<EditorTheme, "colors" | "tokenColors">> {
  const raw = await readJsonc<any>(extensionId, path);
  const base = raw.include
    ? await loadThemeFile(extensionId, dirname(path) + raw.include)
    : { colors: {}, tokenColors: [] };
  return {
    colors: { ...base.colors, ...raw.colors },
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
    themes: [BUILTIN_THEME, ...installed.flatMap(themeOptions)],
  });
  setIconThemeOptions(installed);
}

export async function setEditorTheme(id: string) {
  const option = useExtensions.getState().themes.find((t) => t.id === id) ?? BUILTIN_THEME;
  await applyEditorTheme(await option.load());
  useExtensions.setState({ activeThemeId: option.id });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, option.id);
  } catch {
    // Storage may be unavailable; the theme just won't persist.
  }
}

function storedThemeId(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) ?? BUILTIN_THEME.id;
  } catch {
    return BUILTIN_THEME.id;
  }
}

export function initExtensions() {
  return track("Loading extensions…", loadExtensions);
}

async function loadExtensions() {
  let installed: InstalledExtension[] = [];
  try {
    installed = await extensionsApi.list();
  } catch (e) {
    console.error("Failed to list extensions", e);
  }
  for (const ext of installed) {
    await activate(ext).catch((e) => console.error(`Failed to activate ${ext.id}`, e));
  }
  setInstalled(installed);
  await setEditorTheme(storedThemeId()).catch(() => setEditorTheme(BUILTIN_THEME.id));
  await setIconTheme(storedIconThemeId()).catch(() => setIconTheme(BUILTIN_ICON_THEME_ID));
}

function setInstalling(id: string, progress: InstallProgress | null) {
  useExtensions.setState(({ installing }) => {
    const next = { ...installing };
    if (progress) next[id] = progress;
    else delete next[id];
    return { installing: next };
  });
}

export async function installExtension(namespace: string, name: string) {
  const key = `${namespace}.${name}`.toLowerCase();
  setInstalling(key, { downloaded: 0, total: null });
  let ext: InstalledExtension;
  try {
    ext = await track(`Installing ${name}…`, () =>
      extensionsApi.install(namespace, name, (progress) => setInstalling(key, progress)),
    );
  } finally {
    setInstalling(key, null);
  }
  deactivate(ext.id);
  await activate(ext);
  const others = useExtensions.getState().installed.filter((e) => e.id !== ext.id);
  setInstalled([...others, ext].sort((a, b) => a.id.localeCompare(b.id)));
  return ext;
}

export async function uninstallExtension(id: string) {
  await extensionsApi.uninstall(id);
  deactivate(id);
  const { installed, themes, activeThemeId } = useExtensions.getState();
  const removedActiveTheme = themes.some((t) => t.id === activeThemeId && t.extensionId === id);
  // Before the extension's options are dropped, while its active theme is still recognisable.
  await resetIconThemeIfFrom(id);
  setInstalled(installed.filter((e) => e.id !== id));
  if (removedActiveTheme) await setEditorTheme(BUILTIN_THEME.id);
}

/** URL of an installed extension's own icon, if it declares one. */
export function installedIconUrl(ext: InstalledExtension): string | undefined {
  return ext.manifest.icon ? convertFileSrc(joinPath(ext.path, ext.manifest.icon)) : undefined;
}
