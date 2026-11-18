import { CircleAlert, CircleCheck, Info, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { dismiss, useNotifications, type NotificationKind } from "../state/notifications";

const ICONS: Record<NotificationKind, ReactNode> = {
  info: <Info size={16} className="shrink-0 text-accent-hover" />,
  success: <CircleCheck size={16} className="shrink-0 text-[#73bd79]" />,
  error: <CircleAlert size={16} className="shrink-0 text-danger" />,
  progress: <Loader2 size={16} className="shrink-0 animate-spin text-fg-muted" />,
};

/** Notification balloons in the bottom-right corner, as in IntelliJ. */
export function Toasts() {
  const items = useNotifications((s) => s.items);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-9 z-[900] flex w-[360px] flex-col gap-2">
      {items.map((n) => (
        <div
          key={n.id}
          role={n.kind === "error" ? "alert" : "status"}
          className="pointer-events-auto flex gap-2.5 rounded-lg border border-line-soft bg-panel px-3 py-2.5 shadow-xl shadow-black/40"
        >
          {ICONS[n.kind]}
          <div className="min-w-0 flex-1 select-text">
            <div className="font-medium">{n.title}</div>
            {n.message && (
              <div className="mt-0.5 max-h-40 overflow-y-auto text-xs break-words whitespace-pre-wrap text-fg-muted">
                {n.message}
              </div>
            )}
          </div>
          {n.kind !== "progress" && (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(n.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
            >
              <X size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
