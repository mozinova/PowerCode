import { convertFileSrc } from "@tauri-apps/api/core";
import { FileWarning, Music } from "lucide-react";
import { useEffect, useState } from "react";
import type { MediaKind } from "../lib/media";
import { basename } from "../lib/paths";
import { isSshPath } from "../lib/remote";

/** Transparent pixels show over a checkerboard, as in image editors. */
const CHECKERBOARD = {
  backgroundColor: "#2b2d30",
  backgroundImage:
    "linear-gradient(45deg, #333539 25%, transparent 25%), linear-gradient(-45deg, #333539 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #333539 75%), linear-gradient(-45deg, transparent 75%, #333539 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function Unsupported({ path }: { path: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-fg-muted">
      <FileWarning size={32} strokeWidth={1.5} />
      <p>Cannot preview {basename(path)}.</p>
      <p className="text-xs text-fg-subtle">The format may not be supported by the system's media codecs.</p>
    </div>
  );
}

function ImageView({ src, path }: { src: string; path: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) return <Unsupported path={path} />;
  return (
    <div className="flex h-full w-full flex-col">
      <div
        onClick={() => setActualSize(!actualSize)}
        className={`flex min-h-0 flex-1 overflow-auto p-6 ${actualSize ? "cursor-zoom-out" : "cursor-zoom-in"}`}
      >
        {/* `m-auto` centres the image while still letting it scroll at actual size. */}
        <img
          src={src}
          alt={basename(path)}
          draggable={false}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          style={CHECKERBOARD}
          className={`m-auto shadow-lg shadow-black/40 ${actualSize ? "max-w-none" : "max-h-full max-w-full object-contain"}`}
        />
      </div>
      <div className="flex h-7 shrink-0 items-center justify-center gap-3 border-t border-line text-xs text-fg-muted">
        {size && (
          <span>
            {size.width} × {size.height}
          </span>
        )}
        <span className="text-fg-subtle">Click to {actualSize ? "fit to window" : "view actual size"}</span>
      </div>
    </div>
  );
}

/** Previews images, video and audio; files are streamed by Tauri's asset protocol. */
export function MediaViewer({ path, kind }: { path: string; kind: MediaKind }) {
  const src = convertFileSrc(path);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-editor">
      {isSshPath(path) ? (
        // Media is streamed from local files; SSH files are not on this machine.
        <p className="text-fg-muted">Media preview is not available for files on SSH hosts.</p>
      ) : failed ? (
        <Unsupported path={path} />
      ) : kind === "image" ? (
        <ImageView key={path} src={src} path={path} />
      ) : kind === "video" ? (
        <video
          key={path}
          src={src}
          controls
          onError={() => setFailed(true)}
          className="max-h-full max-w-full bg-black"
        />
      ) : (
        <div className="flex w-[min(480px,80%)] flex-col items-center gap-4">
          <div className="flex size-24 items-center justify-center rounded-2xl bg-panel text-fg-muted">
            <Music size={40} strokeWidth={1.5} />
          </div>
          <div className="max-w-full truncate font-medium">{basename(path)}</div>
          <audio key={path} src={src} controls onError={() => setFailed(true)} className="w-full" />
        </div>
      )}
    </div>
  );
}
