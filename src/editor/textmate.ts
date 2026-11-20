//! Colours languages contributed by extensions with their TextMate grammars,
//! as VS Code does with the active theme's `tokenColors`.
//!
//! Tokenizing runs in a web worker (`textmate.worker.ts`) so large files do not
//! stall typing. Monaco's own tokenizers must answer synchronously, so the
//! worker's results reach the editor as semantic tokens: each token's type is
//! `tm<colour index>` and its modifier `s<font style>`, matching the theme
//! rules `setTextMateTheme` returns.

import * as monaco from "monaco-editor";
import type { IRawTheme } from "vscode-textmate";
import { ruleColor } from "./colors";
import TextMateWorker from "./textmate.worker?worker";
import { MAX_COLORS, type FromWorker, type ToWorker } from "./textmate.protocol";
import { mergeTokens, type OverlayToken } from "./tokenMerge";

type GrammarSource = () => Promise<{ content: string; path: string }>;

const grammarSources = new Map<string, GrammarSource>();
/** Target scope -> scopes injected into it. */
const injections: Record<string, string[]> = {};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (message: FromWorker) => void>();
/** The theme to give a worker started later. */
let currentTheme: IRawTheme = { settings: [] };

function send(message: ToWorker) {
  getWorker().postMessage(message);
}

/** Sends a request and resolves with the worker's reply to it. */
function request<T extends FromWorker>(build: (id: number) => ToWorker): Promise<T> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve as (message: FromWorker) => void);
    send(build(id));
  });
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new TextMateWorker();
  worker = w;
  w.onmessage = async (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === "loadGrammar") {
      // Grammar files are read here, through the app's IPC, on the worker's behalf.
      const source = grammarSources.get(message.scope);
      const grammar = source ? await source().catch(() => null) : null;
      w.postMessage({
        type: "grammar",
        requestId: message.requestId,
        content: grammar?.content ?? null,
        path: grammar?.path ?? "",
      } satisfies ToWorker);
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  w.postMessage({ type: "injections", injections } satisfies ToWorker);
  w.postMessage({ type: "theme", id: 0, theme: currentTheme } satisfies ToWorker);
  // Documents the worker tokenized are forgotten with their models.
  monaco.editor.onWillDisposeModel((model) => send({ type: "close", doc: model.uri.toString() }));
  return w;
}

export function registerGrammar(scopeName: string, source: GrammarSource, injectTo?: string[]) {
  grammarSources.set(scopeName, source);
  for (const target of injectTo ?? []) {
    injections[target] = [...(injections[target] ?? []), scopeName];
  }
  if (worker) send({ type: "injections", injections });
}

/** Font style bits of a TextMate theme rule, as `s1`..`s15` modifiers. */
const STYLE_MODIFIERS = Array.from({ length: 15 }, (_, i) => `s${i + 1}`);

export const LEGEND: monaco.languages.SemanticTokensLegend = {
  tokenTypes: Array.from({ length: MAX_COLORS }, (_, i) => `tm${i}`),
  tokenModifiers: STYLE_MODIFIERS,
};

/** Tells every grammar's semantic tokens provider to recolour, e.g. after a theme change. */
const recolour = new monaco.Emitter<void>();
export const onRecolour = recolour.event;
export const recolourAll = () => recolour.fire();

/** Extensions' semantic tokens for a model (see semanticTokens.ts), drawn over the grammar's. */
let overlayFor: (model: monaco.editor.ITextModel) => Promise<OverlayToken[] | null> = async () => null;

export function setSemanticOverlay(provider: (model: monaco.editor.ITextModel) => Promise<OverlayToken[] | null>) {
  overlayFor = provider;
}

/** Languages with a grammar attached (their semantic tokens come with the grammar's). */
const grammarLanguages = new Map<string, number>();
const grammarListeners = new Set<() => void>();
export const hasGrammar = (languageId: string) => (grammarLanguages.get(languageId) ?? 0) > 0;
export function onGrammarsChanged(listener: () => void) {
  grammarListeners.add(listener);
  return () => grammarListeners.delete(listener);
}

/** A tokenizer that leaves text uncoloured; the worker's semantic tokens colour it. */
const plainTokens: monaco.languages.TokensProvider = {
  getInitialState: () => plainState,
  tokenize: () => ({ tokens: [{ startIndex: 0, scopes: "" }], endState: plainState }),
};
const plainState: monaco.languages.IState = {
  clone: () => plainState,
  equals: (other) => other === plainState,
};

/**
 * Uses the grammar for `languageId`. Replacing the tokens provider factory
 * also disposes Monaco's built-in Monarch tokenizer for that language.
 */
export function attachGrammar(languageId: string, scopeName: string): monaco.IDisposable {
  const tokens = monaco.languages.registerTokensProviderFactory(languageId, { create: () => plainTokens });
  const semantic = monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
    onDidChange: recolour.event,
    getLegend: () => LEGEND,
    async provideDocumentSemanticTokens(model) {
      const [reply, overlay] = await Promise.all([
        request<Extract<FromWorker, { type: "tokens" }>>((id) => ({
          type: "tokenize",
          id,
          doc: model.uri.toString(),
          scope: scopeName,
          text: model.getValue(),
        })),
        overlayFor(model).catch(() => null),
      ]);
      if (overlay?.length) return { data: mergeTokens(reply.data, overlay) };
      return reply.data ? { data: reply.data } : null;
    },
    releaseDocumentSemanticTokens: () => {},
  });
  grammarLanguages.set(languageId, (grammarLanguages.get(languageId) ?? 0) + 1);
  grammarListeners.forEach((l) => l());
  return {
    dispose() {
      tokens.dispose();
      semantic.dispose();
      grammarLanguages.set(languageId, (grammarLanguages.get(languageId) ?? 1) - 1);
      grammarListeners.forEach((l) => l());
    },
  };
}

const FONT_STYLES = ["italic", "bold", "underline", "strikethrough"];

/** The `fontStyle` bits `s<n>` modifiers stand for (italic 1, bold 2, underline 4, strikethrough 8). */
export function fontStyleBits(fontStyle: string): number {
  return FONT_STYLES.reduce((bits, style, bit) => (fontStyle.split(/\s+/).includes(style) ? bits | (1 << bit) : bits), 0);
}

/** The modifier bit of a font style (0 for none). */
export const styleModifier = (bits: number) => (bits > 0 ? 1 << (bits - 1) : 0);

/** How the active theme colours extensions' semantic tokens (see semanticTokens.ts). */
export interface SemanticTheme {
  /** The theme's `semanticHighlighting`: off, extensions' semantic tokens are not shown. */
  enabled: boolean;
  /** The theme's `semanticTokenColors`. */
  rules: Record<string, unknown>;
  /** The theme's `tokenColors`, for semantic token types mapped to TextMate scopes. */
  settings: IRawTheme["settings"];
}

let semanticTheme: SemanticTheme = { enabled: true, rules: {}, settings: [] };
export const activeSemanticTheme = () => semanticTheme;

/** Colour-map index of each colour (upper-case `RRGGBB`) of the active theme. */
let colorIndexes = new Map<string, number>();

/** The `tm<color>` index of a theme colour, if the theme has it. */
export function colorIndex(color: unknown): number | undefined {
  const hex = ruleColor(color)?.toUpperCase();
  return hex ? colorIndexes.get(hex) : undefined;
}

/**
 * Applies a TextMate theme to grammar tokenization and returns the Monaco rules
 * that map the `tm<color>` and `tm<color>.s<style>` token types to its colours.
 */
export async function setTextMateTheme(theme: IRawTheme, semantic?: Omit<SemanticTheme, "settings">): Promise<monaco.editor.ITokenThemeRule[]> {
  // The semantic colours join the colour map (under a scope no grammar uses), so they get `tm` indices.
  const semanticColors = Object.values(semantic?.rules ?? {})
    .map((style) => (typeof style === "string" ? style : (style as { foreground?: unknown } | null)?.foreground))
    .filter((color): color is string => typeof color === "string")
    .map((foreground) => ({ scope: "powercode.semantic", settings: { foreground } }));
  theme = { ...theme, settings: [...theme.settings, ...semanticColors] };
  currentTheme = theme;
  semanticTheme = { enabled: semantic?.enabled ?? true, rules: semantic?.rules ?? {}, settings: theme.settings };
  const reply = await request<Extract<FromWorker, { type: "theme" }>>((id) => ({ type: "theme", id, theme }));

  colorIndexes = new Map();
  reply.colorMap.forEach((color, index) => {
    const hex = ruleColor(color)?.toUpperCase();
    if (hex && index < MAX_COLORS && !colorIndexes.has(hex)) colorIndexes.set(hex, index);
  });
  const rules: monaco.editor.ITokenThemeRule[] = [];
  reply.colorMap.forEach((color, index) => {
    const foreground = ruleColor(color);
    if (!foreground || index >= MAX_COLORS) return;
    rules.push({ token: `tm${index}`, foreground });
    STYLE_MODIFIERS.forEach((modifier, i) => {
      const fontStyle = i + 1;
      rules.push({
        token: `tm${index}.${modifier}`,
        foreground,
        fontStyle: FONT_STYLES.filter((_, bit) => fontStyle & (1 << bit)).join(" "),
      });
    });
  });
  // Recolour once the caller has defined the theme with these rules.
  window.setTimeout(() => recolour.fire(), 0);
  return rules;
}
