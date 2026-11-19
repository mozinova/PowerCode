import { X } from "lucide-react";
import { cancelInstall, useExtensions, type InstallProgress } from "../extensions/runtime";
import { formatBytes } from "../lib/format";
import { tooltipProps } from "./Tooltip";

/** Progress of an in-flight install of `namespace.name`, if any. */
export function useInstallProgress(namespace: string, name: string): InstallProgress | undefined {
  const key = `${namespace}.${name}`.toLowerCase();
  return useExtensions((s) => s.installing[key]);
}

const SIZE = 16;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A ring filling up with `percent`; without one (size unknown, unpacking), a spinning arc. */
function Ring({ percent }: { percent: number | null }) {
  const filled = percent === null ? CIRCUMFERENCE * 0.25 : (CIRCUMFERENCE * percent) / 100;
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={`shrink-0 -rotate-90 ${percent === null ? "animate-spin" : ""}`}
      aria-hidden
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-line-soft" />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
        className="stroke-accent transition-[stroke-dasharray] duration-150"
      />
    </svg>
  );
}

export function InstallProgressRing({
  progress,
  namespace,
  name,
  className = "",
}: {
  progress: InstallProgress;
  /** The extension being installed, so its download can be cancelled. */
  namespace: string;
  name: string;
  className?: string;
}) {
  const { downloaded, total } = progress;
  const unpacking = total !== null && total > 0 && downloaded >= total;
  const percent = total ? Math.min(100, (downloaded / total) * 100) : null;
  const sizes = unpacking
    ? "Installing…"
    : total
      ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
      : downloaded > 0
        ? formatBytes(downloaded)
        : "Connecting…";

  return (
    // One line even in a narrow row: the sizes shorten, the ring and percentage always show.
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null || unpacking ? undefined : Math.round(percent)}
      className={`flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-fg-subtle ${className}`}
    >
      <Ring percent={unpacking ? null : percent} />
      {percent !== null && !unpacking && <span className="shrink-0 font-medium text-fg-muted tabular-nums">{Math.round(percent)}%</span>}
      <span className="min-w-0 truncate">{sizes}</span>
      {/* Once downloaded, the package is being unpacked: too late to cancel. */}
      {!unpacking && (
        <button
          type="button"
          {...tooltipProps("Cancel Download")}
          aria-label="Cancel download"
          onClick={(e) => {
            e.stopPropagation();
            void cancelInstall(namespace, name);
          }}
          className="ml-auto flex size-4 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-danger"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
