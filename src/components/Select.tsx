import { ChevronDown, Loader2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { DropdownMenu } from "./Menu";

export interface SelectOption {
  id: string;
  label: string;
  /** Shown before the label, in the button and the list. */
  icon?: ReactNode;
}

/** A select styled like the app's menus, instead of the WebView's native popup. */
export function Select({
  options,
  value,
  onChange,
  busy = false,
  ariaLabel,
}: {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  busy?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const current = options.find((o) => o.id === value);

  return (
    <div ref={anchorRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={busy}
        onClick={() => setOpen(!open)}
        className={`flex h-7 w-full items-center gap-2 rounded-md border bg-input px-2 text-left text-fg outline-none disabled:opacity-70 ${
          open ? "border-accent" : "border-input-border hover:border-fg-subtle focus-visible:border-accent"
        }`}
      >
        {current?.icon}
        <span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
        {busy ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-fg-muted" />
        )}
      </button>
      {open && (
        <DropdownMenu
          align="stretch"
          anchorRef={anchorRef}
          onClose={close}
          items={[]}
          // Long lists (e.g. branches) scroll, opened at the current option.
          scrollItems={options.map((option) => ({
            label: option.label,
            icon: option.icon,
            checked: option.id === value,
            action: () => option.id !== value && onChange(option.id),
          }))}
        />
      )}
    </div>
  );
}
