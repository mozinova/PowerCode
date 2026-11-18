//! Host-wide state: the workspace, settings, known languages and extensions.

import { EventEmitter, Uri } from "./types";

export interface ExtensionDescription {
  /** Lower-case `publisher.name`, also its folder name. */
  id: string;
  path: string;
  manifest: any;
}

export const host = {
  appRoot: "",
  workspaceFolders: [] as { uri: Uri; name: string; index: number }[],
  /** User settings, flat dotted keys as in VS Code's settings.json. */
  settings: {} as Record<string, unknown>,
  /** Defaults from the extensions' `contributes.configuration`. */
  defaults: {} as Record<string, unknown>,
  languages: [] as string[],
  extensions: [] as ExtensionDescription[],
  storagePath: "",
  globalStoragePath: "",
  logPath: "",
  /** Origin of the UI's webview protocol, for `asWebviewUri` and `cspSource`. */
  webviewOrigin: "",
  /** `ColorThemeKind` of the editor theme: 1 light, 2 dark, 3 high contrast, 4 high contrast light. */
  colorThemeKind: 2,
};

export const onDidChangeColorTheme = new EventEmitter<{ kind: number }>();

export const onDidChangeConfiguration = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

/** Collects `contributes.configuration` defaults (one object or an array of them). */
export function collectDefaults(extensions: ExtensionDescription[]) {
  const defaults: Record<string, unknown> = {};
  for (const ext of extensions) {
    const configuration = ext.manifest.contributes?.configuration;
    const blocks = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
    for (const block of blocks) {
      for (const [key, schema] of Object.entries<any>(block.properties ?? {})) {
        if (schema && "default" in schema) defaults[key] = schema.default;
      }
    }
  }
  return defaults;
}

/** The value at `key`, or an object assembled from all keys under it. */
export function lookup(key: string): unknown {
  const sources = [host.defaults, host.settings];
  let value: unknown;
  for (const source of sources) {
    if (key in source) value = merge(value, source[key]);
  }
  // Settings may also be stored per section (`"a.b": { "c": 1 }` or nested keys `"a.b.c"`).
  const prefix = `${key}.`;
  for (const source of sources) {
    for (const [k, v] of Object.entries(source)) {
      if (!k.startsWith(prefix)) continue;
      const path = k.slice(prefix.length).split(".");
      value = typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
      let target = value as Record<string, unknown>;
      for (const part of path.slice(0, -1)) {
        target[part] = typeof target[part] === "object" && target[part] !== null ? { ...(target[part] as object) } : {};
        target = target[part] as Record<string, unknown>;
      }
      target[path[path.length - 1]] = v;
    }
  }
  return value;
}

function merge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) result[k] = merge(result[k], v);
    return result;
  }
  return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
