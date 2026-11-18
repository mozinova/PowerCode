import {
  Braces,
  File,
  FileCode2,
  FileImage,
  FileMusic,
  FileVideo,
  FileText,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { useIconThemes, type IconDefinition } from "../extensions/iconThemes";

type IconSpec = [LucideIcon, string];

const BY_EXTENSION: Record<string, IconSpec> = {
  ts: [FileCode2, "#3d8ee8"],
  tsx: [FileCode2, "#3d8ee8"],
  js: [FileCode2, "#e8c547"],
  jsx: [FileCode2, "#e8c547"],
  mjs: [FileCode2, "#e8c547"],
  cjs: [FileCode2, "#e8c547"],
  rs: [FileCode2, "#e5865b"],
  py: [FileCode2, "#4c9bd6"],
  java: [FileCode2, "#e76f00"],
  kt: [FileCode2, "#a97bff"],
  go: [FileCode2, "#29beb0"],
  c: [FileCode2, "#7a9ec7"],
  h: [FileCode2, "#7a9ec7"],
  cpp: [FileCode2, "#7a9ec7"],
  cs: [FileCode2, "#9b6bdf"],
  html: [FileCode2, "#e6683c"],
  css: [FileCode2, "#56a8f5"],
  scss: [FileCode2, "#c6538c"],
  json: [Braces, "#d5b778"],
  jsonc: [Braces, "#d5b778"],
  toml: [Settings2, "#9aa0a6"],
  yaml: [Settings2, "#9aa0a6"],
  yml: [Settings2, "#9aa0a6"],
  md: [FileText, "#6aab73"],
  txt: [FileText, "#9aa0a6"],
  png: [FileImage, "#c77dbb"],
  jpg: [FileImage, "#c77dbb"],
  jpeg: [FileImage, "#c77dbb"],
  gif: [FileImage, "#c77dbb"],
  svg: [FileImage, "#c77dbb"],
  ico: [FileImage, "#c77dbb"],
  webp: [FileImage, "#c77dbb"],
  bmp: [FileImage, "#c77dbb"],
  avif: [FileImage, "#c77dbb"],
  mp4: [FileVideo, "#e5865b"],
  webm: [FileVideo, "#e5865b"],
  mov: [FileVideo, "#e5865b"],
  m4v: [FileVideo, "#e5865b"],
  ogv: [FileVideo, "#e5865b"],
  mp3: [FileMusic, "#2aacb8"],
  wav: [FileMusic, "#2aacb8"],
  ogg: [FileMusic, "#2aacb8"],
  oga: [FileMusic, "#2aacb8"],
  flac: [FileMusic, "#2aacb8"],
  m4a: [FileMusic, "#2aacb8"],
  aac: [FileMusic, "#2aacb8"],
  opus: [FileMusic, "#2aacb8"],
};

/** Outlined folder in the IntelliJ New UI style, the same whether expanded or not. */
function FolderGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden>
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.67a1 1 0 0 1 .7.3l.98.97a.5.5 0 0 0 .35.15h4.3A1.5 1.5 0 0 1 14 5.92v5.58a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
        stroke="#ced0d6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThemedIcon({ icon, size }: { icon: IconDefinition; size: number }) {
  if (icon.kind === "image") {
    return <img src={icon.src} width={size} height={size} alt="" draggable={false} className="shrink-0" />;
  }
  // Font icon sizes are relative to the icon box, e.g. "150%".
  const scale = icon.size?.endsWith("%") ? parseFloat(icon.size) / 100 : 1;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontFamily: icon.fontFamily && `"${icon.fontFamily}"`,
        fontSize: size * scale,
        color: icon.color,
      }}
      className="flex shrink-0 items-center justify-center leading-none"
    >
      {icon.character}
    </span>
  );
}

export function FileIcon({
  name,
  isDir = false,
  expanded = false,
  root = false,
  size = 16,
}: {
  name: string;
  isDir?: boolean;
  /** Folders only: themes may show open folders differently. */
  expanded?: boolean;
  /** Folders only: the project root may have its own icon. */
  root?: boolean;
  size?: number;
}) {
  const theme = useIconThemes((s) => s.theme);
  const themed = theme && (isDir ? theme.forFolder(name, expanded, root) : theme.forFile(name));
  if (themed) return <ThemedIcon icon={themed} size={size} />;

  if (isDir) {
    return <FolderGlyph size={size} />;
  }
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const [Icon, color] = BY_EXTENSION[extension] ?? [File, "#9aa0a6"];
  return <Icon size={size} strokeWidth={1.75} className="shrink-0" style={{ color }} />;
}
