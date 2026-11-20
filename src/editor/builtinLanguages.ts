//! Monaco's own language services (TypeScript/JavaScript, JSON, CSS, HTML) give way
//! to an extension that serves the same language, as VS Code has only the
//! extension's. Otherwise both run: duplicate suggestions and hovers, and Monaco's
//! TypeScript errors, which know nothing of the project (its tsconfig, node_modules),
//! next to the real ones from the extension's language server.

import { monaco } from "./monaco";

interface Defaults {
  readonly modeConfiguration: object;
  setModeConfiguration(configuration: object): void;
}

/** Monaco's built-in service for each language it has one for. */
const BUILTIN: Record<string, () => Defaults> = {
  typescript: () => monaco.typescript.typescriptDefaults,
  javascript: () => monaco.typescript.javascriptDefaults,
  json: () => monaco.json.jsonDefaults,
  css: () => monaco.css.cssDefaults,
  scss: () => monaco.css.scssDefaults,
  less: () => monaco.css.lessDefaults,
  html: () => monaco.html.htmlDefaults,
  handlebars: () => monaco.html.handlebarDefaults,
  razor: () => monaco.html.razorDefaults,
};

/** The configuration each turned-off service had, to give it back. */
const saved = new Map<string, object>();
/** Extension providers serving each language, by handle. */
const serving = new Map<string, Set<number>>();

/** Every feature off; tokens and brackets come from Monarch and stay. */
function allOff(configuration: object): object {
  return Object.fromEntries(Object.keys(configuration).map((key) => [key, false]));
}

function update(language: string) {
  const defaults = BUILTIN[language]?.();
  if (!defaults) return;
  const served = (serving.get(language)?.size ?? 0) > 0;
  if (served && !saved.has(language)) {
    saved.set(language, defaults.modeConfiguration);
    defaults.setModeConfiguration(allOff(defaults.modeConfiguration));
    // Errors the built-in service already reported go with it.
    for (const model of monaco.editor.getModels()) {
      if (model.getLanguageId() === language) monaco.editor.setModelMarkers(model, language, []);
    }
  } else if (!served && saved.has(language)) {
    defaults.setModeConfiguration(saved.get(language)!);
    saved.delete(language);
  }
}

/**
 * Completion and hover providers are what a language server registers: their
 * languages lose the built-in service while they are there. `*` providers do not count.
 */
export function extensionServes(handle: number, kind: string, languages: string[]) {
  if (kind !== "completion" && kind !== "hover") return;
  for (const language of languages) {
    if (!BUILTIN[language]) continue;
    const set = serving.get(language) ?? new Set();
    set.add(handle);
    serving.set(language, set);
    update(language);
  }
}

export function extensionStopsServing(handle: number) {
  for (const [language, set] of serving) {
    if (set.delete(handle)) update(language);
  }
}
