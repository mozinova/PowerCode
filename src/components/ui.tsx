import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { tooltipProps, type TooltipSide } from "./Tooltip";

export function IconButton({
  icon: Icon,
  title,
  shortcut,
  tooltipSide,
  badge,
  onClick,
  active = false,
  size = 16,
  className = "",
}: {
  icon: LucideIcon;
  /** Accessible name, also shown as the tooltip. */
  title: string;
  shortcut?: string;
  tooltipSide?: TooltipSide;
  /** A count shown on the icon's corner when above zero, e.g. pending changes. */
  badge?: number;
  onClick?: () => void;
  active?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      {...tooltipProps(title, shortcut, tooltipSide)}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={`relative flex shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${
        active ? "bg-selected-inactive text-fg" : ""
      } ${className}`}
    >
      <Icon size={size} strokeWidth={1.75} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

/** Header row of a tool window, as in IntelliJ's New UI. */
export function ToolWindowHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 pr-2 pl-3">
      <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="font-ui text-accent-hover">{children}</span>;
}
