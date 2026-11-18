import { convertFileSrc } from "@tauri-apps/api/core";
import { Fragment } from "react";
import type { IconRef } from "../exthost/contributions";
import { pathFromUri } from "../exthost/languages";
import type { TreeNode } from "../exthost/views";
import { activeThemeColors } from "../editor/themes";
import { basename } from "../lib/paths";
import { FileIcon } from "./FileIcon";

/** `ThemeColor` ids extensions commonly use that themes often leave out. */
const CHART_COLORS: Record<string, string> = {
  "charts.red": "#db5c5c",
  "charts.orange": "#e08855",
  "charts.yellow": "#e0b84c",
  "charts.green": "#5fb865",
  "charts.blue": "#3574f0",
  "charts.purple": "#a67bd9",
  "charts.foreground": "#dfe1e5",
  "errorForeground": "#db5c5c",
  "testing.iconPassed": "#5fb865",
  "testing.iconFailed": "#db5c5c",
};

export function themeColor(id?: string): string | undefined {
  return id ? (activeThemeColors()[id] ?? CHART_COLORS[id]) : undefined;
}

/** A codicon; `name~spin` spins, as in VS Code. */
export function Codicon({ name, size = 16, color, className = "" }: { name: string; size?: number; color?: string; className?: string }) {
  const [id, modifier] = name.split("~");
  return (
    <span
      aria-hidden
      className={`codicon codicon-${id} ${modifier ? `codicon-modifier-${modifier}` : ""} shrink-0 ${className}`}
      style={{ fontSize: size, color }}
    />
  );
}

/**
 * An extension-provided icon. With `mono`, images take the text colour (a mask),
 * which suits the monochrome SVGs of view containers.
 */
export function ExtIcon({ icon, size = 16, mono = false, className = "" }: { icon: IconRef; size?: number; mono?: boolean; className?: string }) {
  if ("codicon" in icon) return <Codicon name={icon.codicon} size={size} color={themeColor(icon.color)} className={className} />;
  if (mono) {
    return (
      <span
        aria-hidden
        className={`shrink-0 bg-current ${className}`}
        style={{
          width: size,
          height: size,
          maskImage: `url("${icon.url}")`,
          WebkitMaskImage: `url("${icon.url}")`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    );
  }
  return <img src={icon.url} alt="" width={size} height={size} draggable={false} className={`shrink-0 object-contain ${className}`} />;
}

/** The icon of a tree item: its own, else a file icon for its resource. */
export function TreeNodeIcon({ node, expanded }: { node: TreeNode; expanded: boolean }) {
  const icon = node.icon;
  const resourceName = node.resourceUri ? basename(pathFromUri(node.resourceUri)) : undefined;
  if (icon && "themeIcon" in icon) {
    // ThemeIcon.File / ThemeIcon.Folder mean "the icon theme's icon for this resource".
    if ((icon.themeIcon === "file" || icon.themeIcon === "folder") && resourceName) {
      return <FileIcon name={resourceName} isDir={icon.themeIcon === "folder"} expanded={expanded} size={16} />;
    }
    return <Codicon name={icon.themeIcon} color={themeColor(icon.color)} />;
  }
  if (icon && "uri" in icon) {
    const url = icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
    return <img src={url} alt="" width={16} height={16} draggable={false} className="size-4 shrink-0 object-contain" />;
  }
  if (resourceName) return <FileIcon name={resourceName} isDir={node.collapsible !== 0} expanded={expanded} size={16} />;
  return null;
}

/** Text with `$(name)` codicon references rendered as icons, as in status bar items. */
export function CodiconText({ text, size = 14 }: { text: string; size?: number }) {
  const parts = text.split(/\$\(([\w~-]+)\)/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Codicon key={i} name={part} size={size} className="mx-0.5 align-[-2px]" />
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
