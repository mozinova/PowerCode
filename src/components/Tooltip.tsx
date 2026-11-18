import { useEffect, useLayoutEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 500;
const GAP = 6;
const MARGIN = 4;

export type TooltipSide = "bottom" | "right";

/** Attributes that give any element an IntelliJ-style tooltip, shown by `TooltipLayer`. */
export function tooltipProps(text: string | undefined, shortcut?: string, side: TooltipSide = "bottom") {
  if (!text) return {};
  return {
    "data-tooltip": text,
    "data-tooltip-shortcut": shortcut,
    "data-tooltip-side": side,
  };
}

interface Tip {
  text: string;
  shortcut?: string;
  side: TooltipSide;
  anchor: DOMRect;
}

/**
 * Renders the tooltip of whichever `[data-tooltip]` element the pointer rests on.
 * One delegated listener replaces per-element state and native `title` popups.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;

    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tooltip]") ?? null;
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = window.setTimeout(() => {
        if (!el.isConnected || !el.dataset.tooltip) return;
        setTip({
          text: el.dataset.tooltip,
          shortcut: el.dataset.tooltipShortcut || undefined,
          side: el.dataset.tooltipSide === "right" ? "right" : "bottom",
          anchor: el.getBoundingClientRect(),
        });
      }, SHOW_DELAY_MS);
    };
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) hide(); // The pointer left the window.
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Measure, then place next to the anchor, flipping/clamping to stay on screen.
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPosition(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const { anchor, side } = tip;
    let left: number;
    let top: number;
    if (side === "right") {
      left = anchor.right + GAP;
      top = anchor.top + anchor.height / 2 - height / 2;
    } else {
      left = anchor.left + anchor.width / 2 - width / 2;
      top = anchor.bottom + GAP;
      if (top + height > window.innerHeight - MARGIN) top = anchor.top - GAP - height;
    }
    setPosition({
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)),
    });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      style={position ?? { left: 0, top: 0, visibility: "hidden" }}
      className="pointer-events-none fixed z-[100] flex items-center gap-3 rounded-md border border-line-soft bg-[#393b40] px-2 py-1 text-xs whitespace-nowrap text-fg shadow-lg shadow-black/40"
    >
      <span>{tip.text}</span>
      {tip.shortcut && <span className="text-fg-muted">{tip.shortcut}</span>}
    </div>
  );
}
