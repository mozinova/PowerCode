import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/ipc";

/**
 * A small modal asking for a single value, e.g. a new branch name.
 * Validation and `onSubmit` errors are shown inline so the value can be fixed.
 */
export function PromptDialog({
  title,
  initialValue = "",
  placeholder,
  validate,
  onSubmit,
  onClose,
}: {
  title: string;
  initialValue?: string;
  placeholder?: string;
  validate: (value: string) => string | null;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    const problem = validate(trimmed);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex justify-center bg-black/30 pt-[20vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className="h-fit w-[380px] rounded-lg border border-line-soft bg-panel p-3 shadow-2xl shadow-black/50"
      >
        <div className="mb-2 font-semibold">{title}</div>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
          className={`h-8 w-full rounded-md border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle ${
            error ? "border-danger" : "border-input-border focus:border-accent"
          }`}
        />
        {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
      </div>
    </div>
  );
}
