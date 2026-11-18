import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { closeDialog, useHostDialogs, type InputBoxRequest, type QuickPickRequest } from "../exthost/dialogs";

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-[950] flex justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && closeDialog(null)}
    >
      <div
        role="dialog"
        aria-label={title ?? "Input"}
        className="flex h-fit max-h-[70vh] w-[560px] flex-col rounded-lg border border-line-soft bg-panel p-2 shadow-2xl shadow-black/50"
      >
        {title && <div className="mb-1.5 px-1 font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}

const inputClass =
  "h-8 w-full shrink-0 rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent";

function QuickPick({ request }: { request: QuickPickRequest }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState(
    () => new Set(request.items.flatMap((item, i) => (item.picked ? [i] : []))),
  );
  const listRef = useRef<HTMLDivElement>(null);

  // Indexes of the items matching the filter; separators stay while something under them matches.
  const visible = useMemo(() => {
    const needle = filter.toLowerCase();
    const matches = (i: number) => {
      const item = request.items[i];
      return [item.label, item.description, item.detail].some((t) => t?.toLowerCase().includes(needle));
    };
    const result: number[] = [];
    request.items.forEach((item, i) => {
      if (item.separator) result.push(i);
      else if (!needle || matches(i)) result.push(i);
    });
    return result.filter((i, k) => !request.items[i].separator || (k + 1 < result.length && !request.items[result[k + 1]].separator));
  }, [filter, request.items]);
  const choices = visible.filter((i) => !request.items[i].separator);

  useEffect(() => setSelected(0), [filter]);
  useEffect(() => {
    listRef.current?.querySelector("[data-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const accept = (index = choices[selected]) => {
    if (request.canPickMany) closeDialog([...checked].sort((a, b) => a - b));
    else if (index !== undefined) closeDialog([index]);
  };
  const toggle = (index: number) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <Frame title={request.title}>
      <input
        autoFocus
        value={filter}
        placeholder={request.placeHolder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, choices.length - 1));
          else if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
          else if (e.key === " " && request.canPickMany && choices[selected] !== undefined && !filter) toggle(choices[selected]);
          else if (e.key === "Enter") accept();
          else if (e.key === "Escape") closeDialog(null);
          else return;
          e.preventDefault();
        }}
        className={inputClass}
      />
      <div ref={listRef} className="mt-1.5 min-h-0 overflow-y-auto">
        {visible.length === 0 && <div className="px-2 py-1.5 text-fg-muted">No matching items</div>}
        {visible.map((i) => {
          const item = request.items[i];
          if (item.separator) {
            return (
              <div key={i} className="mt-1 border-t border-line-soft px-2 pt-1 text-xs text-fg-subtle">
                {item.label}
              </div>
            );
          }
          const isSelected = choices[selected] === i;
          return (
            <div
              key={i}
              data-selected={isSelected}
              onMouseEnter={() => setSelected(choices.indexOf(i))}
              onClick={() => (request.canPickMany ? toggle(i) : accept(i))}
              className={`flex cursor-default items-start gap-2 rounded px-2 py-1 ${isSelected ? "bg-selected" : ""}`}
            >
              {request.canPickMany && (
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-input-border">
                  {checked.has(i) && <Check size={12} />}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {item.label}
                  {item.description && <span className="ml-2 text-fg-muted">{item.description}</span>}
                </div>
                {item.detail && <div className="truncate text-xs text-fg-muted">{item.detail}</div>}
              </div>
            </div>
          );
        })}
      </div>
      {request.canPickMany && (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => accept()}
            className="h-7 rounded-md bg-accent px-3 font-medium text-white hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      )}
    </Frame>
  );
}

function InputBox({ request }: { request: InputBoxRequest }) {
  const [value, setValue] = useState(request.value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <Frame title={request.title}>
      <input
        ref={inputRef}
        type={request.password ? "password" : "text"}
        value={value}
        placeholder={request.placeHolder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") closeDialog(value);
          if (e.key === "Escape") closeDialog(null);
        }}
        className={inputClass}
      />
      <div className="mt-1.5 px-1 text-xs text-fg-muted">
        {request.prompt ? `${request.prompt} ` : ""}(Press Enter to confirm or Escape to cancel)
      </div>
    </Frame>
  );
}

/** The dialog an extension is waiting on, if any. */
export function HostDialogs() {
  const current = useHostDialogs((s) => s.queue[0]);
  if (!current) return null;
  // A key per request resets the dialog's state between consecutive requests.
  return current.kind === "quickPick" ? (
    <QuickPick key={current.id} request={current} />
  ) : (
    <InputBox key={current.id} request={current} />
  );
}
