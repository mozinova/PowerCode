//! What installed extensions contribute to the workbench, read from their
//! manifests: view containers (stripe entries), views, welcome content,
//! menus and command titles and icons.

import { convertFileSrc } from "@tauri-apps/api/core";
import type { InstalledExtension } from "../lib/ipc";
import { joinPath } from "../lib/paths";

/** An icon: a codicon name (`$(refresh)` → `refresh`) or an image URL. */
export type IconRef = { codicon: string; color?: string } | { url: string };

export interface ViewDescriptor {
  id: string;
  name: string;
  /** Tree views are the default; `webview` views come from `registerWebviewViewProvider`. */
  type: "tree" | "webview";
  when?: string;
  extensionId: string;
  initialSize?: number;
  collapsed: boolean;
}

export interface ViewContainer {
  /** `view:<id>`, also the left tool id. */
  tool: `view:${string}`;
  id: string;
  title: string;
  icon: IconRef;
  /** Shown only while this holds (and some view of it is visible). */
  when?: string;
  /** The sidebar it starts in: `secondarySidebar` containers go to the right one. */
  defaultSide: "left" | "right";
  views: ViewDescriptor[];
}

export interface WelcomeContent {
  view: string;
  contents: string;
  when?: string;
}

export interface MenuItem {
  command: string;
  when?: string;
  group?: string;
  alt?: string;
}

export interface CommandInfo {
  command: string;
  title: string;
  category?: string;
  icon?: IconRef;
  enablement?: string;
}

export interface CustomEditorInfo {
  viewType: string;
  displayName: string;
  /** Globs of the files it opens, such as `*.drawio` or `**` + `/*.md`. */
  patterns: string[];
  /** `default` editors open files by default; `option` ones only through "Reopen With". */
  priority: "default" | "option";
  extensionId: string;
}

export interface Contributions {
  containers: ViewContainer[];
  customEditors: CustomEditorInfo[];
  welcome: WelcomeContent[];
  menus: Record<string, MenuItem[]>;
  commands: Map<string, CommandInfo>;
}

/** VS Code's own containers that extensions add views to. */
const BUILTIN_CONTAINERS: Record<string, { title: string; codicon: string }> = {
  explorer: { title: "Explorer", codicon: "files" },
  scm: { title: "Source Control", codicon: "source-control" },
  debug: { title: "Run and Debug", codicon: "debug-alt" },
  test: { title: "Testing", codicon: "beaker" },
  remote: { title: "Remote Explorer", codicon: "remote-explorer" },
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "object" && value && "value" in value ? String((value as { value: unknown }).value) : "";

/** `%key%` placeholders resolve through package.nls.json, which PowerCode does not load: show the key readably. */
function localized(value: string): string {
  const match = /^%(.+)%$/.exec(value);
  if (!match) return value;
  const last = match[1].split(".").pop() ?? match[1];
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

export function iconRef(ext: InstalledExtension, icon: unknown): IconRef | undefined {
  if (!icon) return undefined;
  if (typeof icon === "string") {
    const codicon = /^\$\(([\w~-]+)\)$/.exec(icon);
    if (codicon) return { codicon: codicon[1] };
    return { url: convertFileSrc(joinPath(ext.path, icon)) };
  }
  if (typeof icon === "object") {
    const dark = (icon as { dark?: unknown }).dark;
    return typeof dark === "string" ? { url: convertFileSrc(joinPath(ext.path, dark)) } : undefined;
  }
  return undefined;
}

export function readContributions(installed: InstalledExtension[]): Contributions {
  const containers = new Map<string, ViewContainer>();
  const welcome: WelcomeContent[] = [];
  const menus: Record<string, MenuItem[]> = {};
  const commands = new Map<string, CommandInfo>();
  const customEditors: CustomEditorInfo[] = [];

  for (const ext of installed) {
    const contributes = (ext.manifest.contributes ?? {}) as Record<string, any>;
    // PowerCode has one sidebar: the secondary sidebar and the panel's containers go there too.
    for (const location of ["activitybar", "secondarySidebar", "panel"]) {
      for (const c of contributes.viewsContainers?.[location] ?? []) {
        if (!c?.id || containers.has(c.id)) continue;
        containers.set(c.id, {
          tool: `view:${c.id}`,
          id: c.id,
          title: localized(text(c.title)) || c.id,
          icon: iconRef(ext, c.icon) ?? { codicon: "extensions" },
          when: c.when,
          defaultSide: location === "secondarySidebar" ? "right" : "left",
          views: [],
        });
      }
    }
    for (const c of contributes.commands ?? []) {
      if (!c?.command) continue;
      commands.set(c.command, {
        command: c.command,
        title: localized(text(c.title)) || c.command,
        category: c.category ? localized(text(c.category)) : undefined,
        icon: iconRef(ext, c.icon),
        enablement: c.enablement,
      });
    }
    for (const [menu, items] of Object.entries<any[]>(contributes.menus ?? {})) {
      if (!Array.isArray(items)) continue;
      (menus[menu] ??= []).push(...items.filter((i) => typeof i?.command === "string"));
    }
    for (const e of contributes.customEditors ?? []) {
      if (!e?.viewType) continue;
      customEditors.push({
        viewType: e.viewType,
        displayName: localized(text(e.displayName)) || e.viewType,
        patterns: (e.selector ?? []).map((s: { filenamePattern?: string }) => s?.filenamePattern).filter(Boolean),
        priority: e.priority === "option" ? "option" : "default",
        extensionId: ext.id,
      });
    }
    for (const w of contributes.viewsWelcome ?? []) {
      if (w?.view && w.contents) welcome.push({ view: w.view, contents: localized(text(w.contents)), when: w.when });
    }
  }

  // Views go into their container; built-in containers appear once something uses them.
  for (const ext of installed) {
    const views = ((ext.manifest.contributes ?? {}) as Record<string, any>).views ?? {};
    for (const [containerId, list] of Object.entries<any[]>(views)) {
      if (!Array.isArray(list)) continue;
      let container = containers.get(containerId);
      if (!container) {
        const builtin = BUILTIN_CONTAINERS[containerId];
        if (!builtin) continue;
        container = {
          tool: `view:${containerId}`,
          id: containerId,
          title: builtin.title,
          icon: { codicon: builtin.codicon },
          defaultSide: "left",
          views: [],
        };
        containers.set(containerId, container);
      }
      for (const v of list) {
        if (!v?.id) continue;
        container.views.push({
          id: v.id,
          name: localized(text(v.name)) || v.id,
          type: v.type === "webview" ? "webview" : "tree",
          when: v.when,
          extensionId: ext.id,
          initialSize: v.initialSize,
          collapsed: v.visibility === "collapsed",
        });
      }
    }
  }

  return {
    containers: [...containers.values()].filter((c) => c.views.length > 0),
    customEditors,
    welcome,
    menus,
    commands,
  };
}

/** Menu items for `menu` whose `when` holds, ordered by group (`navigation` first) and `@order`. */
export function menuItems(
  contributions: Contributions,
  menu: string,
  isTrue: (when: string | undefined) => boolean,
): { inline: MenuItem[]; other: MenuItem[][] } {
  const items = (contributions.menus[menu] ?? []).filter((i) => isTrue(i.when));
  const groupOf = (i: MenuItem) => (i.group ?? "").split("@")[0];
  const orderOf = (i: MenuItem) => Number((i.group ?? "").split("@")[1] ?? 0);
  const sorted = [...items].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== gb) return ga === "navigation" ? -1 : gb === "navigation" ? 1 : ga.localeCompare(gb);
    return orderOf(a) - orderOf(b);
  });
  // Title bars (`view/title`, `scm/title`, ...) show `navigation` inline; items show the `inline` group.
  const inlineGroup = menu.endsWith("/title") ? "navigation" : "inline";
  const inline = sorted.filter((i) => groupOf(i) === inlineGroup);
  const groups = new Map<string, MenuItem[]>();
  for (const item of sorted.filter((i) => groupOf(i) !== inlineGroup)) {
    const group = groupOf(item);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return { inline, other: [...groups.values()] };
}
