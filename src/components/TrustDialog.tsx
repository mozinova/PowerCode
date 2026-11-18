import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { parentDir } from "../lib/paths";
import { closeTrustDialog, restrictFolder, trustFolder, untrustFolder, useTrust } from "../state/trust";
import { useWorkspace } from "../state/workspace";
import { tooltipProps } from "./Tooltip";

const RESTRICTED = [
  "Extensions run only if they support Restricted Mode",
  "Git does not run on its own (a repository's settings can run commands)",
  "Debugging is off",
];

/**
 * Asks whether the authors of a newly opened folder are trusted (as VS Code does),
 * or shows the open folder's trust and the trusted folders.
 */
export function TrustDialog() {
  const dialog = useTrust((s) => s.dialog);
  const state = useTrust((s) => s.state);
  const trusted = useTrust((s) => s.trusted);
  const root = useWorkspace((s) => s.root);
  const [includeParent, setIncludeParent] = useState(false);
  if (!dialog) return null;

  const parent = parentDir(dialog.root);
  const canTrustParent = parent !== dialog.root && parent.length > 3;
  const isTrusted = state === "trusted";

  return (
    <div
      className="fixed inset-0 z-[950] flex items-start justify-center bg-black/40 pt-[14vh]"
      onMouseDown={(e) => e.target === e.currentTarget && closeTrustDialog()}
    >
      <div role="dialog" aria-label="Workspace Trust" className="w-[540px] rounded-lg border border-line-soft bg-panel p-5 shadow-2xl shadow-black/50">
        <div className="flex items-start gap-3">
          {isTrusted ? (
            <ShieldCheck size={28} className="mt-0.5 shrink-0 text-[#5fb865]" />
          ) : (
            <ShieldAlert size={28} className="mt-0.5 shrink-0 text-[#e0b84c]" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {dialog.asking ? "Do you trust the authors of the files in this folder?" : isTrusted ? "This folder is trusted" : "This folder is in Restricted Mode"}
            </h2>
            <p className="mt-1 text-[13px] break-all text-fg-muted">{dialog.root}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeTrustDialog}
            className="flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>

        <p className="mt-4 text-[13px] leading-5 text-fg-muted">
          Code in a folder can run as soon as tools use it: extensions, Git and debuggers. If you do not trust its authors, PowerCode
          keeps it in <span className="text-fg">Restricted Mode</span>, where you can still browse and edit the files, search and use the
          terminal, but:
        </p>
        <ul className="mt-2 list-disc pl-6 text-[13px] leading-6 text-fg-muted">
          {RESTRICTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {!isTrusted && canTrustParent && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" checked={includeParent} onChange={(e) => setIncludeParent(e.target.checked)} className="size-3.5 accent-accent" />
            <span className="min-w-0 truncate">
              Trust the authors of all files in the parent folder <span className="text-fg-muted">{parent}</span>
            </span>
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {isTrusted ? (
            <button
              type="button"
              onClick={() => restrictFolder(dialog.root)}
              className="h-8 rounded-md border border-line-soft px-3 text-[13px] text-fg hover:bg-hover"
            >
              Don't Trust This Folder
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => restrictFolder(dialog.root)}
                className="h-8 rounded-md border border-line-soft px-3 text-[13px] text-fg hover:bg-hover"
              >
                No, I don't trust the authors
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => trustFolder(includeParent && canTrustParent ? parent : dialog.root, root)}
                className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
              >
                Yes, I trust the authors
              </button>
            </>
          )}
        </div>

        {!dialog.asking && trusted.length > 0 && (
          <div className="mt-5 border-t border-line-soft pt-3">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">Trusted folders</div>
            <div className="max-h-40 overflow-y-auto">
              {trusted.map((folder) => (
                <div key={folder} className="group flex h-7 items-center gap-2 rounded px-1 text-[13px] hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate">{folder}</span>
                  <button
                    type="button"
                    {...tooltipProps("Remove")}
                    aria-label={`Stop trusting ${folder}`}
                    onClick={() => untrustFolder(folder, root)}
                    className="invisible flex size-5 items-center justify-center rounded text-fg-muted group-hover:visible hover:bg-hover hover:text-fg"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
