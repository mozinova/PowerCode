import { Check, type LucideIcon } from "lucide-react";
import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export interface MenuItem {
  label: string;
  /** Secondary text after the label, e.g. a file's folder. */
  detail?: string;
  /** A Lucide icon, or any node (e.g. a file icon) to show in the icon column. */
  icon?: LucideIcon | ReactNode;
  shortcut?: string;
  /** Shows a check mark at the end, e.g. for the current item of a list. */
  checked?: boolean;
  action: () => void;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | "separator";

/**
 * Calls `onClose` on a mouse down outside `refs`, Escape, window blur, or a
 * scroll elsewhere (menus are fixed, so they would drift from their anchor).
 */
function useDismiss(refs: RefObject<HTMLElement | null>[], onClose: () => void) {
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      refs.some((r) => r.current?.contains(target as Node));
    const onMouseDown = (e: MouseEvent) => {
      if (!inside(e.target)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
    // `refs` is a fresh array each render, but the ref objects in it are stable.
  }, [onClose]);
}

const MARGIN = 4;

/** Menus sit above everything else, including tool windows and tooltips. */
const PANEL_CLASS =
  "z-[1000] rounded-lg border border-line-soft bg-panel p-1 shadow-xl shadow-black/40";

function renderLucide(Icon: LucideIcon) {
  return <Icon size={15} strokeWidth={1.75} />;
}

function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  // Without any icons, the icon column would only indent the labels.
  const hasIcons = items.some((item) => item !== "separator" && item.icon);
  return items.map((item, i) =>
    item === "separator" ? (
      <div key={i} className="my-1 h-px bg-line-soft" />
    ) : (
      <button
        key={`${item.label}-${i}`}
        type="button"
        role="menuitem"
        disabled={item.disabled}
        onClick={() => {
          onClose();
          item.action();
        }}
        className="flex h-7 w-full items-center gap-2 rounded px-2.5 text-left hover:bg-selected disabled:text-fg-subtle disabled:hover:bg-transparent"
      >
        {hasIcons && (
          <span className="flex w-4 shrink-0 justify-center text-fg-muted">
            {item.icon && (isValidElement(item.icon) ? item.icon : renderLucide(item.icon as LucideIcon))}
          </span>
        )}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0">{item.label}</span>
          {item.detail && <span className="max-w-64 truncate text-xs text-fg-subtle">{item.detail}</span>}
        </span>
        {item.shortcut && <span className="pl-6 text-fg-subtle">{item.shortcut}</span>}
        {item.checked && <Check size={14} className="ml-2 shrink-0 text-fg-muted" />}
      </button>
    ),
  );
}

/**
 * A menu dropping down from its anchor. It is positioned against the window and
 * layered above everything, so containers around the anchor cannot clip it; it
 * flips above the anchor when there is no room below.
 * Clicks on `anchorRef` are left to the anchor, which usually toggles the menu.
 */
export function DropdownMenu({
  items,
  scrollItems,
  scrollPlacement = "before",
  anchorRef,
  align = "left",
  onClose,
}: {
  items: MenuEntry[];
  /** A long list shown first, scrolling within a bounded height (e.g. the open tabs); `items` stay below it. */
  scrollItems?: MenuEntry[];
  /** Where `scrollItems` go: above `items` (the default) or below them (e.g. branches under the Git actions). */
  scrollPlacement?: "before" | "after";
  anchorRef: RefObject<HTMLElement | null>;
  /** `stretch` matches the anchor's width, as a select list does. */
  align?: "left" | "right" | "stretch";
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Hidden until measured, to avoid a flash at the wrong position.
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  useDismiss([ref, anchorRef], onClose);

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = ref.current;
    if (!anchor || !menu) return;
    // `stretch` is at least as wide as the anchor, wider if the labels need it.
    const width = align === "stretch" ? Math.max(anchor.width, menu.offsetWidth) : menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = align === "right" ? anchor.right - width : anchor.left;

    // Open above the anchor only when the menu does not fit below but does above.
    const openAbove =
      anchor.bottom + MARGIN + height > window.innerHeight - MARGIN && anchor.top - MARGIN - height >= MARGIN;
    setStyle({
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)),
      top: openAbove ? anchor.top - MARGIN - height : anchor.bottom + MARGIN,
      minWidth: align === "stretch" ? anchor.width : undefined,
    });
  }, [align, anchorRef]);

  return (
    <div
      ref={ref}
      role="menu"
      style={style}
      className={`fixed ${align === "stretch" ? "" : "min-w-56"} ${PANEL_CLASS}`}
    >
      {scrollItems && scrollItems.length > 0 && scrollPlacement === "before" && (
        <>
          <ScrollList items={scrollItems} onClose={onClose} />
          {items.length > 0 && <div className="my-1 h-px bg-line-soft" />}
        </>
      )}
      <MenuList items={items} onClose={onClose} />
      {scrollItems && scrollItems.length > 0 && scrollPlacement === "after" && (
        <>
          {items.length > 0 && <div className="my-1 h-px bg-line-soft" />}
          <ScrollList items={scrollItems} onClose={onClose} />
        </>
      )}
    </div>
  );
}

/** Menu items in a region of bounded height that scrolls, opened at the checked item. */
function ScrollList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Buttons are rendered in order, separators aside.
    const index = items.filter((e): e is MenuItem => e !== "separator").findIndex((e) => e.checked);
    if (index >= 0) ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[index]?.scrollIntoView({ block: "nearest" });
  }, [items]);
  return (
    <div ref={ref} className="max-h-[min(320px,45vh)] overflow-y-auto overscroll-contain">
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}

/** A menu at the pointer position, kept inside the viewport. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useDismiss([ref], onClose);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      style={position}
      onContextMenu={(e) => e.preventDefault()}
      className={`fixed min-w-56 ${PANEL_CLASS}`}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
