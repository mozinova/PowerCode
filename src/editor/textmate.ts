//! Tokenizes languages contributed by extensions with their TextMate grammars,
//! coloured by the active theme's `tokenColors` exactly as VS Code does.

import * as monaco from "monaco-editor";
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IRawTheme,
  type StateStack,
} from "vscode-textmate";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { ruleColor } from "./colors";

type GrammarSource = () => Promise<{ content: string; path: string }>;

const grammarSources = new Map<string, GrammarSource>();
/** Target scope -> scopes injected into it. */
const injections = new Map<string, string[]>();

let registry: Promise<Registry> | null = null;
let rawTheme: IRawTheme = { settings: [] };

function getRegistry(): Promise<Registry> {
  registry ??= (async () => {
    const wasm: ArrayBuffer = await (await fetch(onigWasmUrl)).arrayBuffer();
    await loadWASM(wasm);
    const reg = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async (scopeName) => {
        const source = grammarSources.get(scopeName);
        if (!source) return null;
        const { content, path } = await source();
        return parseRawGrammar(content, path);
      },
      getInjections: (scopeName) => injections.get(scopeName),
    });
    reg.setTheme(rawTheme);
    return reg;
  })();
  return registry;
}

export function registerGrammar(scopeName: string, source: GrammarSource, injectTo?: string[]) {
  grammarSources.set(scopeName, source);
  for (const target of injectTo ?? []) {
    injections.set(target, [...(injections.get(target) ?? []), scopeName]);
  }
}

class TmState implements monaco.languages.IState {
  constructor(readonly stack: StateStack) {}
  clone() {
    return new TmState(this.stack);
  }
  equals(other: monaco.languages.IState) {
    return other instanceof TmState && other.stack.equals(this.stack);
  }
}

// Bit layout of vscode-textmate's EncodedTokenAttributes.
const FONT_STYLE_MASK = 0x00007800;
const FONT_STYLE_OFFSET = 11;
const FOREGROUND_MASK = 0x00ff8000;
const FOREGROUND_OFFSET = 15;

/** Monaco token type for a colour-map index and TextMate font style bits. */
function tokenType(foreground: number, fontStyle: number) {
  return fontStyle ? `tm${foreground}.s${fontStyle}` : `tm${foreground}`;
}

function createTokensProvider(grammar: IGrammar): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TmState(INITIAL),
    tokenize(line, state) {
      const result = grammar.tokenizeLine2(line, (state as TmState).stack, 500);
      const tokens: monaco.languages.IToken[] = [];
      for (let i = 0; i < result.tokens.length; i += 2) {
        const meta = result.tokens[i + 1];
        tokens.push({
          startIndex: result.tokens[i],
          scopes: tokenType(
            (meta & FOREGROUND_MASK) >>> FOREGROUND_OFFSET,
            (meta & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET,
          ),
        });
      }
      return { tokens, endState: new TmState(result.ruleStack) };
    },
  };
}

/**
 * Uses the grammar for `languageId`. Replacing the tokens provider factory also
 * disposes Monaco's built-in Monarch tokenizer for that language.
 */
export function attachGrammar(languageId: string, scopeName: string): monaco.IDisposable {
  return monaco.languages.registerTokensProviderFactory(languageId, {
    create: async () => {
      const grammar = await (await getRegistry()).loadGrammar(scopeName);
      if (!grammar) throw new Error(`Grammar not found: ${scopeName}`);
      return createTokensProvider(grammar);
    },
  });
}

const FONT_STYLES = ["italic", "bold", "underline", "strikethrough"];

/**
 * Applies a TextMate theme to grammar tokenization and returns the Monaco rules
 * that map our `tm<color>.s<style>` token types to its colours.
 */
export async function setTextMateTheme(theme: IRawTheme): Promise<monaco.editor.ITokenThemeRule[]> {
  rawTheme = theme;
  const reg = await getRegistry();
  reg.setTheme(theme);

  const rules: monaco.editor.ITokenThemeRule[] = [];
  reg.getColorMap().forEach((color, index) => {
    const foreground = ruleColor(color);
    if (!foreground) return;
    for (let fontStyle = 0; fontStyle < 16; fontStyle++) {
      rules.push({
        token: tokenType(index, fontStyle),
        foreground,
        fontStyle: FONT_STYLES.filter((_, bit) => fontStyle & (1 << bit)).join(" "),
      });
    }
  });
  return rules;
}
