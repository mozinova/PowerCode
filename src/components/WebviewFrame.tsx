import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { anchorOf, attachFrame, clearAnchor, setAnchor, useWebviews, webviewUrl, type WebviewState } from "../exthost/webviews";

/**
 * Marks where webview `id` is shown. The iframe itself lives in WebviewLayer
 * and is laid over this element, so it survives being hidden.
 */
export function WebviewAnchor({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const loaded = useWebviews((s) => (s.webviews[id]?.version ?? 0) > 0);
  useEffect(() => {
    const element = ref.current!;
    setAnchor(id, element);
    return () => clearAnchor(id, element);
  }, [id]);
  return (
    <div ref={ref} className="flex size-full items-center justify-center text-fg-muted">
      {!loaded && <Loader2 size={16} className="animate-spin" />}
    </div>
  );
}

function Frame({ webview }: { webview: WebviewState }) {
  const ref = useCallback((frame: HTMLIFrameElement | null) => attachFrame(webview.id, frame), [webview.id]);
  // The page comes from the `pcwebview` origin, so even with `allow-same-origin`
  // (its own origin, for storage and fetches) it cannot reach the app.
  const sandbox = webview.enableScripts
    ? `allow-scripts allow-same-origin allow-popups allow-modals allow-downloads${webview.enableForms ? " allow-forms" : ""}`
    : "allow-same-origin";
  return (
    <iframe
      ref={ref}
      title="Webview"
      src={webviewUrl(webview)}
      sandbox={sandbox}
      allow="clipboard-read; clipboard-write"
      className="block size-full border-0 bg-transparent"
    />
  );
}

/** Every live webview, each positioned over its anchor (or hidden without one). */
export function WebviewLayer() {
  const webviews = useWebviews((s) => s.webviews);
  const boxes = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    let frame = 0;
    const place = () => {
      for (const [id, box] of boxes.current) {
        const anchor = anchorOf(id);
        const rect = anchor?.getBoundingClientRect();
        const visible = rect && rect.width > 0 && rect.height > 0;
        const next = visible
          ? `visibility:visible;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
          : "visibility:hidden;left:0;top:0;width:0;height:0";
        if (box.dataset.place !== next) {
          box.dataset.place = next;
          box.style.cssText = next;
        }
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    // Iframes swallow mouse moves: while dragging elsewhere (e.g. a splitter), let them pass through.
    const down = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLIFrameElement)) document.documentElement.classList.add("pc-dragging");
    };
    const up = () => document.documentElement.classList.remove("pc-dragging");
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  return (
    <div className="webview-layer pointer-events-none fixed inset-0 z-30">
      {Object.values(webviews)
        .filter((w) => w.version > 0)
        .map((webview) => (
          <div
            key={webview.id}
            ref={(box) => {
              if (box) boxes.current.set(webview.id, box);
              else boxes.current.delete(webview.id);
            }}
            className="webview-box pointer-events-auto absolute"
            style={{ visibility: "hidden" }}
          >
            <Frame webview={webview} />
          </div>
        ))}
    </div>
  );
}
