export type MediaKind = "image" | "video" | "audio";

const EXTENSIONS: Record<MediaKind, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"],
  video: ["mp4", "webm", "ogv", "mov", "m4v"],
  audio: ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"],
};

const KIND_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind as MediaKind])),
);

/** The kind of media previewed for `path`, or null for files opened as text. */
export function mediaKind(path: string): MediaKind | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (KIND_BY_EXTENSION.get(path.slice(dot + 1).toLowerCase()) ?? null);
}
