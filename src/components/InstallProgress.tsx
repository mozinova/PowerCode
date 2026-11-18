import { X } from "lucide-react";
import { cancelInstall, useExtensions, type InstallProgress } from "../extensions/runtime";
import { formatBytes } from "../lib/format";
import { tooltipProps } from "./Tooltip";

/** Progress of an in-flight install of `namespace.name`, if any. */
export function useInstallProgress(namespace: string, name: string): InstallProgress | undefined {
  const key = `${namespace}.${name}`.toLowerCase();
  return useExtensions((s) => s.installing[key]);
}

export function InstallProgressBar({
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
  const label = unpacking
    ? "Installing…"
    : total
      ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
      : downloaded > 0
        ? formatBytes(downloaded)
        : "Connecting…";

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <div className="flex items-center gap-1.5">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : Math.round(percent)}
          className="h-1 flex-1 overflow-hidden rounded-full bg-line-soft"
        >
          {percent === null || unpacking ? (
            // Size unknown or unpacking: an indeterminate, pulsing bar.
            <div className="h-full w-full animate-pulse bg-accent/70" />
          ) : (
            <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${percent}%` }} />
          )}
        </div>
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
            className="flex size-4 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-danger"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="flex justify-between text-xs text-fg-subtle">
        <span>{label}</span>
        {percent !== null && !unpacking && <span>{Math.round(percent)}%</span>}
      </div>
    </div>
  );
}
