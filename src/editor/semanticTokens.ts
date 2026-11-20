//! Semantic tokens from extensions (`registerDocumentSemanticTokensProvider`):
//! a language server's view of what each name is (a parameter, a constant, a
//! method). They are drawn over the TextMate colouring, as in VS Code.
//!
//! The grammars already reach Monaco as semantic tokens (`tm<colour>` types, see
//! textmate.ts), and Monaco shows one provider's tokens per document. So the
//! extensions' tokens are translated to the same `tm<colour>` encoding, styled
//! the way VS Code styles them (the theme's `semanticTokenColors`, else the
//! TextMate scope the type stands for), and merged into the grammar's tokens.

import { useExtensions } from "../extensions/runtime";
import { featureProviders, onFeatureChange, provideFeature, type FeatureProvider } from "../exthost/languages";
import { useUserSettings } from "../settings/store";
import { monaco } from "./monaco";
import {
  LEGEND,
  activeSemanticTheme,
  colorIndex,
  fontStyleBits,
  hasGrammar,
  onGrammarsChanged,
  onRecolour,
  recolourAll,
  setSemanticOverlay,
  styleModifier,
  type SemanticTheme,
} from "./textmate";
import { resolveScope } from "./themes";
import { encodeTokens, type OverlayToken } from "./tokenMerge";

/** VS Code's TextMate scopes for the standard token types and modifiers (`tokenClassificationRegistry`). */
const DEFAULT_SCOPES: Record<string, string[]> = {
  comment: ["comment"],
  string: ["string"],
  keyword: ["keyword.control"],
  number: ["constant.numeric"],
  regexp: ["constant.regexp"],
  operator: ["keyword.operator"],
  namespace: ["entity.name.namespace"],
  type: ["entity.name.type", "support.type"],
  struct: ["entity.name.type.struct"],
  class: ["entity.name.type.class", "support.class"],
  interface: ["entity.name.type.interface"],
  enum: ["entity.name.type.enum"],
  typeParameter: ["entity.name.type.parameter"],
  function: ["entity.name.function", "support.function"],
  member: ["entity.name.function.member", "support.function"],
  method: ["entity.name.function.member", "support.function"],
  macro: ["entity.name.function.preprocessor"],
  variable: ["variable.other.readwrite", "entity.name.variable"],
  parameter: ["variable.parameter"],
  property: ["variable.other.property"],
  enumMember: ["variable.other.enummember"],
  event: ["variable.other.event"],
  decorator: ["entity.name.decorator", "entity.name.function"],
  "variable.readonly": ["variable.other.constant"],
  "property.readonly": ["variable.other.constant.property"],
  "type.defaultLibrary": ["support.type"],
  "class.defaultLibrary": ["support.class"],
  "interface.defaultLibrary": ["support.class"],
  "variable.defaultLibrary": ["support.variable", "support.other.variable"],
  "variable.defaultLibrary.readonly": ["support.constant"],
  "property.defaultLibrary": ["support.variable.property"],
  "property.defaultLibrary.readonly": ["support.constant.property"],
  "function.defaultLibrary": ["support.function"],
  "member.defaultLibrary": ["support.function"],
};

/** A selector key with its modifiers in a fixed order, so `a.x.y` and `a.y.x` are one. */
function selectorKey(type: string, modifiers: string[]): string {
  return [type, ...[...modifiers].sort()].join(".");
}

function normalizeKeys(scopes: Record<string, string[]>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [key, list] of Object.entries(scopes)) {
    if (!Array.isArray(list)) continue;
    const [type, ...modifiers] = key.split(".");
    map.set(selectorKey(type, modifiers), list.filter((s) => typeof s === "string"));
  }
  return map;
}

const defaultScopes = normalizeKeys(DEFAULT_SCOPES);

interface Contributions {
  /** Scopes by language (`""` for any), by selector key. */
  scopes: Map<string, Map<string, string[]>>;
  superTypes: Map<string, string>;
}

let contributions: Contributions | null = null;

/** Installed extensions' `semanticTokenScopes` and `semanticTokenTypes` (e.g. rust-analyzer's `lifetime`). */
function contributed(): Contributions {
  if (contributions) return contributions;
  const scopes = new Map<string, Map<string, string[]>>();
  const superTypes = new Map<string, string>();
  for (const ext of useExtensions.getState().installed) {
    const contributes = ext.manifest.contributes;
    for (const entry of contributes?.semanticTokenScopes ?? []) {
      const language = entry.language ?? "";
      const byKey = scopes.get(language) ?? new Map();
      for (const [key, list] of normalizeKeys(entry.scopes ?? {})) byKey.set(key, list);
      scopes.set(language, byKey);
    }
    for (const type of contributes?.semanticTokenTypes ?? []) {
      if (type.superType) superTypes.set(type.id, type.superType);
    }
  }
  contributions = { scopes, superTypes };
  return contributions;
}

function typeChain(type: string): string[] {
  const chain = [type];
  const { superTypes } = contributed();
  for (let next = superTypes.get(type); next && !chain.includes(next); next = superTypes.get(next)) chain.push(next);
  return chain;
}

/** Every subset of `modifiers`, largest first (the most specific selector wins). */
function subsets(modifiers: string[]): string[][] {
  const list = modifiers.slice(0, 6);
  const result: string[][] = [];
  for (let mask = (1 << list.length) - 1; mask >= 0; mask--) result.push(list.filter((_, i) => mask & (1 << i)));
  return result.sort((a, b) => b.length - a.length);
}

interface Style {
  color: number;
  modifiers: number;
}

interface ThemeRule {
  type: string;
  modifiers: string[];
  language?: string;
  foreground?: unknown;
  fontStyle?: string;
}

/** The theme's `semanticTokenColors`: `"type.mod:language"` selectors and their styles. */
function themeRules(theme: SemanticTheme): ThemeRule[] {
  return Object.entries(theme.rules).flatMap(([selector, value]): ThemeRule[] => {
    const [name, language] = selector.split(":");
    const [type, ...modifiers] = name.split(".");
    if (!type) return [];
    if (typeof value === "string") return [{ type, modifiers, language, foreground: value }];
    if (!value || typeof value !== "object") return [];
    const v = value as Record<string, unknown>;
    const styles = typeof v.fontStyle === "string" ? v.fontStyle : ["italic", "bold", "underline", "strikethrough"].filter((s) => v[s] === true).join(" ");
    return [{ type, modifiers, language, foreground: v.foreground, fontStyle: styles || undefined }];
  });
}

const cache = new Map<string, Style | null>();
let cachedTheme: SemanticTheme | null = null;
let cachedRules: ThemeRule[] = [];

function styleFrom(foreground: unknown, fontStyle: unknown): Style | null {
  const color = colorIndex(foreground);
  if (color === undefined) return null;
  return { color, modifiers: styleModifier(typeof fontStyle === "string" ? fontStyleBits(fontStyle) : 0) };
}

/** How the active theme styles a token type with modifiers in `language`; null leaves the grammar's colour. */
function styleOf(type: string, modifiers: string[], language: string): Style | null {
  const theme = activeSemanticTheme();
  if (theme !== cachedTheme) {
    cache.clear();
    cachedTheme = theme;
    cachedRules = themeRules(theme);
  }
  const key = `${language}|${selectorKey(type, modifiers)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: Style | null = null;
  const chain = typeChain(type);
  // The theme's own semantic colours: the most modifiers matched, then the closest type.
  let best: ThemeRule | null = null;
  let bestScore = -1;
  for (const rule of cachedRules) {
    if (rule.language && rule.language !== language) continue;
    const rank = rule.type === "*" ? 0 : chain.indexOf(rule.type) === -1 ? -1 : 10 - chain.indexOf(rule.type);
    if (rank < 0 || !rule.modifiers.every((m) => modifiers.includes(m))) continue;
    const score = rule.modifiers.length * 100 + rank * 2 + (rule.language ? 1 : 0);
    if (score > bestScore && rule.foreground !== undefined) {
      best = rule;
      bestScore = score;
    }
  }
  if (best) result = styleFrom(best.foreground, best.fontStyle);

  // Else the TextMate scopes the type stands for, coloured by the theme's `tokenColors`.
  if (!result) {
    const { scopes } = contributed();
    search: for (const t of [...chain, "*"]) {
      for (const subset of subsets(modifiers)) {
        const selector = selectorKey(t, subset);
        for (const table of [scopes.get(language), scopes.get(""), defaultScopes]) {
          for (const scope of table?.get(selector) ?? []) {
            // A scope path ("meta.x variable.y") is matched by its last scope.
            const setting = resolveScope(theme.settings, scope.trim().split(/\s+/).pop() ?? scope);
            if (setting?.foreground) {
              result = styleFrom(setting.foreground, setting.fontStyle);
              if (result) break search;
            }
          }
        }
      }
    }
  }
  cache.set(key, result);
  return result;
}

/** `editor.semanticHighlighting.enabled`: true, false or "configuredByTheme" (the default). */
function enabled(): boolean {
  const value = useUserSettings.getState().values["editor.semanticHighlighting.enabled"];
  if (value === true || value === false) return value;
  return activeSemanticTheme().enabled;
}

/** The providers to ask for `language`: whole-document ones, else range ones (asked for the whole document). */
function providersFor(language: string): FeatureProvider[] {
  const documents = featureProviders("semanticTokens", language);
  return documents.length ? documents : featureProviders("rangeSemanticTokens", language);
}

/** Extensions' tokens for `model`, styled, sorted, without overlaps; null when there are none. */
async function overlay(model: monaco.editor.ITextModel): Promise<OverlayToken[] | null> {
  const language = model.getLanguageId();
  const providers = providersFor(language);
  if (providers.length === 0 || !enabled()) return null;
  const version = model.getVersionId();
  const results = await Promise.all(
    providers.map((p) => provideFeature<{ data: number[] } | null>(p.handle, "semanticTokens", model).catch(() => null)),
  );
  // Typing on made these stale; Monaco asks again.
  if (model.isDisposed() || model.getVersionId() !== version) return null;
  const tokens: OverlayToken[] = [];
  results.forEach((result, i) => {
    const legend = providers[i].metadata?.legend as { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
    const data = result?.data;
    if (!legend || !data) return;
    let line = 0;
    let start = 0;
    for (let k = 0; k + 4 < data.length; k += 5) {
      if (data[k] > 0) start = 0;
      line += data[k];
      start += data[k + 1];
      const type = legend.tokenTypes[data[k + 3]];
      if (!type) continue;
      const bits = data[k + 4];
      const modifiers = legend.tokenModifiers.filter((_, bit) => bits & (1 << bit));
      const style = styleOf(type, modifiers, language);
      if (style) tokens.push({ line, start, length: data[k + 2], color: style.color, modifiers: style.modifiers });
    }
  });
  tokens.sort((a, b) => a.line - b.line || a.start - b.start);
  // Two providers may cover the same text: the first token there wins.
  const result: OverlayToken[] = [];
  for (const token of tokens) {
    const previous = result[result.length - 1];
    if (previous && previous.line === token.line && token.start < previous.start + previous.length) continue;
    result.push(token);
  }
  return result;
}

/** Monaco providers for languages without a grammar (their colours come from Monarch or nothing). */
const standalone = new Map<string, monaco.IDisposable>();

function updateStandaloneProviders() {
  // Languages a provider names (not just `*`) that no grammar colours.
  const wanted = new Set(
    monaco.languages
      .getLanguages()
      .map((l) => l.id)
      .filter((language) => !hasGrammar(language) && providersFor(language).some((p) => p.languages.includes(language))),
  );
  for (const [language, disposable] of standalone) {
    if (!wanted.has(language)) {
      disposable.dispose();
      standalone.delete(language);
    }
  }
  for (const language of wanted) {
    if (standalone.has(language)) continue;
    standalone.set(
      language,
      monaco.languages.registerDocumentSemanticTokensProvider(language, {
        onDidChange: onRecolour,
        getLegend: () => LEGEND,
        async provideDocumentSemanticTokens(model) {
          const tokens = await overlay(model);
          return tokens ? { data: encodeTokens(tokens) } : null;
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  }
}

let started = false;

/** Starts merging extensions' semantic tokens into the colouring; call once. */
export function startSemanticTokens() {
  if (started) return;
  started = true;
  setSemanticOverlay(overlay);
  onFeatureChange((kind) => {
    if (kind !== "semanticTokens" && kind !== "rangeSemanticTokens") return;
    updateStandaloneProviders();
    recolourAll();
  });
  onGrammarsChanged(updateStandaloneProviders);
  // New extensions may bring scopes for their token types.
  useExtensions.subscribe((s, previous) => {
    if (s.installed === previous.installed) return;
    contributions = null;
    cache.clear();
    recolourAll();
  });
  useUserSettings.subscribe((s, previous) => {
    if (s.values["editor.semanticHighlighting.enabled"] !== previous.values["editor.semanticHighlighting.enabled"]) recolourAll();
  });
}
