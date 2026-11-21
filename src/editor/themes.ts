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
  /** Whether extensions' semantic tokens are shown (VS Code's "configuredByTheme"). */
  semanticHighlighting?: boolean;
  /** Styles of semantic token types (`"parameter"`, `"variable.readonly:java"`, ...). */
  semanticTokenColors?: Record<string, unknown>;
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

/** IntelliJ New UI "Light" editor colour scheme. */
export const POWERCODE_LIGHT: EditorTheme = {
  id: "powercode-light",
  label: "PowerCode Light",
  base: "vs",
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#1F2328",
    "editorLineNumber.foreground": "#8C959F",
    "editorLineNumber.activeForeground": "#1F2328",
    "editor.lineHighlightBackground": "#F6F8FA",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#ACCEF7",
    "editor.inactiveSelectionBackground": "#ACCEF780",
    "editor.wordHighlightBackground": "#EAECEF80",
    "editor.wordHighlightStrongBackground": "#D0D7DE80",
    "editor.findMatchBackground": "#FFD33D80",
    "editor.findMatchHighlightBackground": "#FFE57F60",
    "editorCursor.foreground": "#1F2328",
    "editorWhitespace.foreground": "#D0D7DE",
    "editorIndentGuide.background1": "#EAECEF",
    "editorIndentGuide.activeBackground1": "#AFB8C1",
    "editorBracketMatch.background": "#D0D7DE",
    "editorBracketMatch.border": "#00000000",
    "editorGutter.background": "#FFFFFF",
    "editorWidget.background": "#F7F8FA",
    "editorWidget.border": "#D3D5DB",
    "editorHoverWidget.background": "#F7F8FA",
    "editorHoverWidget.border": "#D3D5DB",
    "editorSuggestWidget.background": "#F7F8FA",
    "editorSuggestWidget.border": "#D3D5DB",
    "editorSuggestWidget.selectedBackground": "#D4E2FF",
    "editorSuggestWidget.highlightForeground": "#0969DA",
    "list.hoverBackground": "#E4E6EB",
    "input.background": "#FFFFFF",
    "input.border": "#D0D7DE",
    "focusBorder": "#0969DA",
    "scrollbarSlider.background": "#8C959F40",
    "scrollbarSlider.hoverBackground": "#8C959F70",
    "scrollbarSlider.activeBackground": "#8C959F90",
    "minimap.background": "#FFFFFF",
  },
  tokenColors: [
    { settings: { foreground: "#1F2328", background: "#FFFFFF" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6E7781" } },
    {
      scope: ["comment.block.documentation", "comment.block.javadoc"],
      settings: { foreground: "#3F6E50", fontStyle: "italic" },
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
      settings: { foreground: "#CF222E" },
    },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#24292F" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#0A3069" } },
    { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#116329" } },
    { scope: ["constant.numeric"], settings: { foreground: "#0550AE" } },
    { scope: ["entity.name.function"], settings: { foreground: "#8250DF" } },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "variable.other.constant",
      ],
      settings: { foreground: "#953800" },
    },
    { scope: ["entity.name.type", "entity.name.class", "support.class"], settings: { foreground: "#0550AE" } },
    {
      scope: ["meta.decorator", "punctuation.decorator", "storage.type.annotation"],
      settings: { foreground: "#8250DF" },
    },
    { scope: ["entity.name.tag"], settings: { foreground: "#116329" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#0550AE" } },
    { scope: ["markup.heading"], settings: { foreground: "#0550AE", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#0A3069" } },
    { scope: ["markup.underline.link"], settings: { foreground: "#0969DA", fontStyle: "underline" } },
    { scope: ["invalid"], settings: { foreground: "#CF222E" } },
  ],
};

/** Matrix Cyber cyberpunk phosphor green/cyan editor colour scheme. */
export const POWERCODE_MATRIX: EditorTheme = {
  id: "powercode-matrix-cyber",
  label: "PowerCode Matrix Cyber",
  base: "vs-dark",
  colors: {
    "editor.background": "#060F08",
    "editor.foreground": "#A3F7BF",
    "editorLineNumber.foreground": "#1D4726",
    "editorLineNumber.activeForeground": "#00FF66",
    "editor.lineHighlightBackground": "#0A1F10",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#0D421E",
    "editor.inactiveSelectionBackground": "#0D421E80",
    "editor.wordHighlightBackground": "#143D1F",
    "editor.wordHighlightStrongBackground": "#1B4F2A",
    "editor.findMatchBackground": "#00FF6640",
    "editor.findMatchHighlightBackground": "#00FF6625",
    "editorCursor.foreground": "#00FF66",
    "editorWhitespace.foreground": "#1D472650",
    "editorIndentGuide.background1": "#0E2914",
    "editorIndentGuide.activeBackground1": "#1D4726",
    "editorBracketMatch.background": "#0D421E",
    "editorBracketMatch.border": "#00FF6680",
    "editorGutter.background": "#060F08",
    "editorWidget.background": "#0A170D",
    "editorWidget.border": "#14331B",
    "editorHoverWidget.background": "#0A170D",
    "editorHoverWidget.border": "#14331B",
    "editorSuggestWidget.background": "#0A170D",
    "editorSuggestWidget.border": "#14331B",
    "editorSuggestWidget.selectedBackground": "#0D421E",
    "editorSuggestWidget.highlightForeground": "#00FF66",
    "list.hoverBackground": "#102D18",
    "input.background": "#040D06",
    "input.border": "#185227",
    "focusBorder": "#00FF66",
    "scrollbarSlider.background": "#18522780",
    "scrollbarSlider.hoverBackground": "#2F6B4280",
    "scrollbarSlider.activeBackground": "#2F6B42",
    "minimap.background": "#060F08",
  },
  tokenColors: [
    { settings: { foreground: "#A3F7BF", background: "#060F08" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#2E7D46" } },
    {
      scope: ["comment.block.documentation", "comment.block.javadoc"],
      settings: { foreground: "#399955", fontStyle: "italic" },
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
      settings: { foreground: "#00FF66" },
    },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#6EE7A8" } },
    { scope: ["string", "punctuation.definition.string"], settings: { foreground: "#80FFB0" } },
    { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: "#00E5FF" } },
    { scope: ["constant.numeric"], settings: { foreground: "#39FF14" } },
    { scope: ["entity.name.function"], settings: { foreground: "#00E5FF" } },
    {
      scope: [
        "variable.other.property",
        "variable.other.object.property",
        "support.variable.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "variable.other.constant",
      ],
      settings: { foreground: "#00FFFF" },
    },
    { scope: ["entity.name.type", "entity.name.class", "support.class"], settings: { foreground: "#38EF7D" } },
    {
      scope: ["meta.decorator", "punctuation.decorator", "storage.type.annotation"],
      settings: { foreground: "#E040FB" },
    },
    { scope: ["entity.name.tag"], settings: { foreground: "#00FF66" } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#00E5FF" } },
    { scope: ["markup.heading"], settings: { foreground: "#00FF66", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.inline.raw", "markup.fenced_code"], settings: { foreground: "#80FFB0" } },
    { scope: ["markup.underline.link"], settings: { foreground: "#00E5FF", fontStyle: "underline" } },
    { scope: ["invalid"], settings: { foreground: "#FF3366" } },
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
export function resolveScope(settings: ThemeSetting[], scope: string): ThemeSetting["settings"] | null {
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
let activeBase: monaco.editor.BuiltinTheme = "vs-dark";

/** VS Code's `ColorThemeKind` of the active theme: 1 light, 2 dark, 3 high contrast, 4 high contrast light. */
export function activeThemeKind(): number {
  return { vs: 1, "vs-dark": 2, "hc-black": 3, "hc-light": 4 }[activeBase] ?? 2;
}

/** Workbench colours of the active theme (`editor.background`, ...), e.g. for webviews. */
export function activeThemeColors(): Record<string, string> {
  return activeColors;
}

/** Applies the app's CSS variables on `<html data-theme="...">` to match `themeId` and `base`. */
export function applyAppTheme(themeId: string, base: monaco.editor.BuiltinTheme = "vs-dark") {
  let appTheme = "powercode-dark";
  if (themeId === "powercode-light" || themeId === "powercode-matrix-cyber" || themeId === "powercode-dark") {
    appTheme = themeId;
  } else if (base === "vs" || base === "hc-light") {
    appTheme = "powercode-light";
  }
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", appTheme);
  }
}

/** Defines `theme` synchronously so editors can be created with it right away. */
export function defineEditorTheme(theme: EditorTheme) {
  applyAppTheme(theme.id, theme.base);
  defineMonacoTheme(theme, []);
  activeColors = theme.colors;
  activeBase = theme.base;
}

/** Makes `theme` the active editor theme for both Monarch and TextMate tokens. */
export async function applyEditorTheme(theme: EditorTheme) {
  applyAppTheme(theme.id, theme.base);
  activeColors = theme.colors;
  activeBase = theme.base;
  defineMonacoTheme(theme, []);
  monaco.editor.setTheme(theme.id);
  const isBuiltin =
    theme.id === POWERCODE_DARK.id ||
    theme.id === POWERCODE_LIGHT.id ||
    theme.id === POWERCODE_MATRIX.id;
  const textMateRules = await setTextMateTheme(
    { name: theme.label, settings: theme.tokenColors },
    // Built-in themes have semantic highlighting on, as VS Code's default themes do.
    { enabled: theme.semanticHighlighting ?? isBuiltin, rules: theme.semanticTokenColors ?? {} },
  );
  defineMonacoTheme(theme, textMateRules);
  monaco.editor.setTheme(theme.id);
}
