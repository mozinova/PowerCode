import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { dap, useDebug } from "../debug/model";
import { tooltipProps } from "./Tooltip";

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  presentationHint?: { kind?: string; attributes?: string[] };
}

/** Values by kind, coloured like IntelliJ's debugger. */
function valueClass(value: string, type?: string): string {
  if (/^["'`]/.test(value) || type === "string" || type === "str") return "text-[#6aab73]";
  if (/^-?\d/.test(value) || type === "number" || type === "int" || type === "float") return "text-[#2aacb8]";
  if (/^(true|false|True|False|null|undefined|None|nil)$/.test(value)) return "text-[#cf8e6d]";
  return "text-fg";
}

/** The children of an expandable value, loaded when first shown (and again after each stop). */
export function VariableChildren({ sessionId, reference, depth }: { sessionId: string; reference: number; depth: number }) {
  const generation = useDebug((s) => s.generation);
  const [children, setChildren] = useState<Variable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    dap<{ variables: Variable[] }>(sessionId, "variables", { variablesReference: reference })
      .then((r) => !cancelled && setChildren(r?.variables ?? []))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, reference, generation]);
  if (error) return <div style={{ paddingLeft: 8 + depth * 14 }} className="py-0.5 text-xs text-danger">{error}</div>;
  if (!children) return null;
  return (
    <>
      {children.map((v, i) => (
        <VariableRow key={`${v.name}-${i}`} sessionId={sessionId} variable={v} depth={depth} />
      ))}
    </>
  );
}

export function VariableRow({ sessionId, variable, depth, label }: { sessionId: string; variable: Variable; depth: number; label?: string }) {
  const [open, setOpen] = useState(false);
  const expandable = variable.variablesReference > 0;
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        onClick={() => expandable && setOpen(!open)}
        style={{ paddingLeft: 4 + depth * 14 }}
        className="flex h-[22px] cursor-default items-center gap-1 pr-2 font-mono text-xs hover:bg-hover"
        {...tooltipProps(variable.type ? `${variable.type}: ${variable.value}` : variable.value)}
      >
        <span className="flex w-4 shrink-0 justify-center text-fg-muted">
          {expandable && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </span>
        <span className="shrink-0 text-[#c77dbb]">{label ?? variable.name}</span>
        {(label ?? variable.name) && <span className="shrink-0 text-fg-muted">=</span>}
        <span className={`min-w-0 truncate ${valueClass(variable.value, variable.type)}`}>{variable.value}</span>
      </div>
      {open && expandable && <VariableChildren sessionId={sessionId} reference={variable.variablesReference} depth={depth + 1} />}
    </>
  );
}
