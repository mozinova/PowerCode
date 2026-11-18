import * as monaco from "monaco-editor";
import type { IRawTheme } from "vscode-textmate";
import { isHexColor, ruleColor } from "./colors";
import { setTextMateTheme } from "./textmate";

type ThemeSetting = IRawTheme["settings"][number];

/** A VS Code colour theme with `include`s already resolved. */
export interface EditorTheme {
  id: string;
  label: string;
  base: monaco.editor.BuiltinTheme;
  colors: Record<string, string>;
  tokenColors: ThemeSetting[];
}

/** IntelliJ New UI "Dark" editor colour scheme, expressed as a VS Code theme. */
export const POWERCODE_DARK: EditorTheme = {
  id: "powercode-dark",
  label: "PowerCode Dark",
  base: "vs-dark",
  colors: {
    "editor.background": "#1E1F22",
    "editor.foreground": "#BCBEC4",
    "editorLineNumber.foreground": "#4B5059",
    "editorLineNumber.activeForeground": "#A1A3AB",
    "editor.lineHighlightBackground": "#26282E",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#214283",
    "editor.inactiveSelectionBackground": "#21428380",
    "editor.wordHighlightBackground": "#373B39",
    "editor.wordHighlightStrongBackground": "#3F3B4A",
    "editor.findMatchBackground": "#2D543F",
    "editor.findMatchHighlightBackground": "#32593D80",
    "editorCursor.foreground": "#CED0D6",
    "editorWhitespace.foreground": "#6F737A50",
    "editorIndentGuide.background1": "#313438",
    "editorIndentGuide.activeBackground1": "#4B5059",
    "editorBracketMatch.background": "#43454A",
    "editorBracketMatch.border": "#00000000",
    "editorGutter.background": "#1E1F22",
    "editorWidget.background": "#2B2D30",
    "editorWidget.border": "#393B40",
    "editorHoverWidget.background": "#2B2D30",
    "editorHoverWidget.border": "#393B40",
    "editorSuggestWidget.background": "#2B2D30",
    "editorSuggestWidget.border": "#393B40",
    "editorSuggestWidget.selectedBackground": "#2E436E",
    "editorSuggestWidget.highlightForeground": "#548AF7",
    "list.hoverBackground": "#393B40",
    "input.background": "#1E1F22",
    "input.border": "#4E5157",
    "focusBorder": "#3574F0",
    "scrollbarSlider.background": "#4E515780",
    "scrollbarSlider.hoverBackground": "#6F737A80",
    "scrollbarSlider.activeBackground": "#6F737A",
    "minimap.background": "#1E1F22",
  },
  tokenColors: [
    { settings: { foreground: "#BCBEC4", background: "#1E1F22" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#7A7E85" } },
    {
      scope: ["comment.block.documentation", "comment.block.javadoc"],
      settings: { foreground: "#5F826B", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage.type",
        "storage.modifier",
        "support.type.primitive",
        "constant.language",
        "variable.language.this",
        "variable.language.self",
        "variable.language.super",
        "keyword.operator.new",
        "keyword.operator.expression",
      ],
      settings: { foreground: "#CF8E6D" },
    },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#BCBEC4" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#6AAB73" } },
    { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#CF8E6D" } },
    { scope: ["constant.numeric"], settings: { foreground: "#2AACB8" } },
    { scope: ["entity.name.function"], settings: { foreground: "#56A8F5" } },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "variable.other.constant",
      ],
      settings: { foreground: "#C77DBB" },
    },
    { scope: ["entity.name.type", "entity.name.class", "support.class"], settings: { foreground: "#BCBEC4" } },
    {
      scope: ["meta.decorator", "punctuation.decorator", "storage.type.annotation"],
      settings: { foreground: "#B3AE60" },
    },
    { scope: ["entity.name.tag"], settings: { foreground: "#D5B778" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#BABABA" } },
    { scope: ["markup.heading"], settings: { foreground: "#CF8E6D", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#6AAB73" } },
    { scope: ["markup.underline.link"], settings: { foreground: "#548AF7", fontStyle: "underline" } },
    { scope: ["invalid"], settings: { foreground: "#F75464" } },
  ],
};

/**
 * Monaco's built-in Monarch tokenizers emit their own token names; each maps to
 * the first TextMate scope (in order of preference) that the theme colours.
 */
const MONARCH_SCOPES: [string, string[]][] = [
  ["comment", ["comment"]],
  ["comment.doc", ["comment.block.documentation", "comment"]],
  ["keyword", ["storage.type", "keyword"]],
  ["string", ["string.quoted", "string"]],
  ["string.escape", ["constant.character.escape"]],
  ["number", ["constant.numeric"]],
  ["regexp", ["string.regexp"]],
  ["type", ["entity.name.type", "support.type"]],
  ["type.identifier", ["entity.name.type", "support.class"]],
  ["delimiter", ["punctuation"]],
  ["annotation", ["meta.decorator", "storage.type.annotation"]],
  ["tag", ["entity.name.tag"]],
  ["metatag", ["entity.name.tag"]],
  ["attribute.name", ["entity.other.attribute-name"]],
  ["attribute.value", ["string"]],
  ["key", ["support.type.property-name", "meta.object-literal.key"]],
  ["constant", ["constant.language"]],
  ["predefined", ["support.function"]],
  ["namespace", ["entity.name.namespace"]],
];

/** Finds the colour a theme gives `scope`, matching simple selectors by prefix. */
function resolveScope(settings: ThemeSetting[], scope: string): ThemeSetting["settings"] | null {
  let best: ThemeSetting["settings"] | null = null;
  let bestLength = -1;
  for (const setting of settings) {
    const selectors = Array.isArray(setting.scope)
      ? setting.scope
      : typeof setting.scope === "string"
        ? setting.scope.split(",")
        : [];
    for (const raw of selectors) {
      if (typeof raw !== "string") continue;
      const selector = raw.trim();
      if (!selector || selector.includes(" ")) continue;
      const matches = scope === selector || scope.startsWith(`${selector}.`);
      if (matches && selector.length >= bestLength) {
        best = setting.settings;
        bestLength = selector.length;
      }
    }
  }
  return best;
}

function monarchRules(theme: EditorTheme): monaco.editor.ITokenThemeRule[] {
  const rules: monaco.editor.ITokenThemeRule[] = [];
  const defaults = theme.tokenColors.find((s) => !s.scope)?.settings;
  const foreground = ruleColor(defaults?.foreground) ?? ruleColor(theme.colors["editor.foreground"]);
  if (foreground) rules.push({ token: "", foreground });

  for (const [token, scopes] of MONARCH_SCOPES) {
    const resolved = scopes.map((s) => resolveScope(theme.tokenColors, s)).find(Boolean);
    if (!resolved) continue;
    rules.push({
      token,
      foreground: ruleColor(resolved.foreground),
      fontStyle: typeof resolved.fontStyle === "string" ? resolved.fontStyle : undefined,
    });
  }
  return rules;
}

function defineMonacoTheme(theme: EditorTheme, extraRules: monaco.editor.ITokenThemeRule[]) {
  monaco.editor.defineTheme(theme.id, {
    base: theme.base,
    inherit: true,
    rules: [...monarchRules(theme), ...extraRules],
    colors: Object.fromEntries(Object.entries(theme.colors).filter(([, value]) => isHexColor(value))),
  });
}

let activeColors: Record<string, string> = {};

/** Workbench colours of the active theme (`editor.background`, ...), e.g. for webviews. */
export function activeThemeColors(): Record<string, string> {
  return activeColors;
}

/** Defines `theme` synchronously so editors can be created with it right away. */
export function defineEditorTheme(theme: EditorTheme) {
  defineMonacoTheme(theme, []);
  activeColors = theme.colors;
}

/** Makes `theme` the active editor theme for both Monarch and TextMate tokens. */
export async function applyEditorTheme(theme: EditorTheme) {
  activeColors = theme.colors;
  defineMonacoTheme(theme, []);
  monaco.editor.setTheme(theme.id);
  const textMateRules = await setTextMateTheme({ name: theme.label, settings: theme.tokenColors });
  defineMonacoTheme(theme, textMateRules);
  monaco.editor.setTheme(theme.id);
}
