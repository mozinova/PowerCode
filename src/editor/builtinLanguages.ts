//! Monaco's own language services (TypeScript/JavaScript, JSON, CSS, HTML) give way
//! to an extension that serves the same language, as VS Code has only the
//! extension's. Otherwise both run: duplicate suggestions and hovers, and Monaco's
//! TypeScript errors, which know nothing of the project (its tsconfig, node_modules:
//! "Cannot find module" on every import), next to the real ones from the extension.
//!
//! Monaco's TypeScript, CSS and HTML modes read their feature switches once, when
//! the first file of the language opens; later changes are ignored. So the
//! languages extensions served are remembered, and their built-in services are off
//! from the start of the next session. In the session an extension first serves a
//! language, the built-in diagnostics (which Monaco does re-read) are turned off.
//!
//! Imports `monaco-editor` directly, not ./monaco, so ./monaco can run this before
//! any editor model exists.

import * as monaco from "monaco-editor";

interface Defaults {
  readonly modeConfiguration: object;
  setModeConfiguration(configuration: object): void;
}

interface Service {
  defaults: () => Defaults;
  /** Turns its diagnostics off now (they are re-read on change); returns how to turn them back on. */
  quiet?: () => () => void;
}

function quietTypeScript(defaults: typeof monaco.typescript.typescriptDefaults) {
  const before = defaults.getDiagnosticsOptions();
  defaults.setDiagnosticsOptions({ ...before, noSyntaxValidation: true, noSemanticValidation: true, noSuggestionDiagnostics: true });
  return () => defaults.setDiagnosticsOptions(before);
}

function quietCss(defaults: typeof monaco.css.cssDefaults) {
  const before = defaults.options;
  defaults.setOptions({ ...before, validate: false });
  return () => defaults.setOptions(before);
}

/** Monaco's built-in service for each language it has one for. */
const SERVICES: Record<string, Service> = {
  typescript: { defaults: () => monaco.typescript.typescriptDefaults, quiet: () => quietTypeScript(monaco.typescript.typescriptDefaults) },
  javascript: { defaults: () => monaco.typescript.javascriptDefaults, quiet: () => quietTypeScript(monaco.typescript.javascriptDefaults) },
  // JSON re-reads its feature switches: turning them off is enough.
  json: { defaults: () => monaco.json.jsonDefaults },
  css: { defaults: () => monaco.css.cssDefaults, quiet: () => quietCss(monaco.css.cssDefaults) },
  scss: { defaults: () => monaco.css.scssDefaults, quiet: () => quietCss(monaco.css.scssDefaults) },
  less: { defaults: () => monaco.css.lessDefaults, quiet: () => quietCss(monaco.css.lessDefaults) },
  // HTML reports no diagnostics.
  html: { defaults: () => monaco.html.htmlDefaults },
  handlebars: { defaults: () => monaco.html.handlebarDefaults },
  razor: { defaults: () => monaco.html.razorDefaults },
};

const STORAGE_KEY = "powercode.extensionLanguages";

/** Languages an extension served, with the extension: their built-in services start off. */
function remembered(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function remember(language: string, extension: string | null) {
  const all = remembered();
  if (extension) all[language] = extension;
  else delete all[language];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // The built-in service then runs until the extension serves the language again.
  }
}

/** Every feature off; tokens and brackets come from Monarch and stay. */
function allOff(configuration: object): object {
  return Object.fromEntries(Object.keys(configuration).map((key) => [key, false]));
}

/** How each turned-off service was, to give it back. */
const saved = new Map<string, { configuration: object; unquiet?: () => void }>();

function turnOff(language: string) {
  const service = SERVICES[language];
  if (!service || saved.has(language)) return;
  const defaults = service.defaults();
  const configuration = defaults.modeConfiguration;
  defaults.setModeConfiguration(allOff(configuration));
  saved.set(language, { configuration, unquiet: service.quiet?.() });
  // Errors the built-in service already reported go with it.
  for (const model of monaco.editor.getModels()) {
    if (model.getLanguageId() === language) monaco.editor.setModelMarkers(model, language, []);
  }
}

function turnOn(language: string) {
  const state = saved.get(language);
  if (!state) return;
  saved.delete(language);
  SERVICES[language].defaults().setModeConfiguration(state.configuration);
  state.unquiet?.();
}

/** Turns off the built-in services of the languages extensions served last time; call before any model exists. */
export function applyRememberedLanguages() {
  for (const language of Object.keys(remembered())) turnOff(language);
}

/**
 * Once the enabled extensions are known: a remembered language whose extension is
 * gone gets its built-in service back (fully on the next start, if a file of the
 * language was already open).
 */
export function forgetRemovedExtensions(enabledIds: string[]) {
  for (const [language, extension] of Object.entries(remembered())) {
    if (enabledIds.includes(extension)) continue;
    remember(language, null);
    if (!serving.has(language) || serving.get(language)!.size === 0) turnOn(language);
  }
}

/** Extension providers serving each language, by handle. */
const serving = new Map<string, Set<number>>();

/**
 * Completion and hover providers are what a language server registers: their
 * languages lose the built-in service. `*` providers do not count.
 */
export function extensionServes(handle: number, kind: string, languages: string[], extension: string) {
  if (kind !== "completion" && kind !== "hover") return;
  for (const language of languages) {
    if (!SERVICES[language]) continue;
    const set = serving.get(language) ?? new Set();
    set.add(handle);
    serving.set(language, set);
    remember(language, extension);
    turnOff(language);
  }
}

/**
 * A provider went away. The built-in service stays off: this happens on every
 * extension host restart, and the extension's providers come back with it. An
 * uninstalled extension's languages are given back by `forgetRemovedExtensions`.
 */
export function extensionStopsServing(handle: number) {
  for (const set of serving.values()) set.delete(handle);
}
