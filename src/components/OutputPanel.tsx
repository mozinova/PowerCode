import { Minus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useExtensionHost } from "../exthost/state";
import { useWorkspace } from "../state/workspace";
import { Select } from "./Select";
import { IconButton } from "./ui";

/** The Output tool window: logs of the extension host and extensions' output channels. */
export function OutputPanel() {
  const outputs = useExtensionHost((s) => s.outputs);
  const activeOutput = useExtensionHost((s) => s.activeOutput);
  const toggleBottomTool = useWorkspace((s) => s.toggleBottomTool);
  const channel = outputs.find((o) => o.id === activeOutput) ?? outputs[0];
  const textRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  // Follows new output while scrolled to the bottom, like a terminal.
  useEffect(() => {
    const el = textRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [channel?.text]);

  const clear = () =>
    useExtensionHost.setState(({ outputs }) => ({
      outputs: outputs.map((o) => (o.id === channel?.id ? { ...o, text: "" } : o)),
    }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-3">
        <span className="font-semibold">Output</span>
        <div className="w-56">
          <Select
            ariaLabel="Output channel"
            options={outputs.map((o) => ({ id: o.id, label: o.name }))}
            value={channel?.id ?? ""}
            onChange={(id) => useExtensionHost.setState({ activeOutput: id })}
          />
        </div>
        <div className="flex-1" />
        <IconButton icon={Trash2} title="Clear Output" onClick={clear} className="size-7" />
        <IconButton icon={Minus} title="Hide" onClick={() => toggleBottomTool("output")} className="size-7" />
      </div>
      <pre
        ref={textRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-xs leading-5 whitespace-pre-wrap text-fg-muted select-text"
      >
        {channel?.text || "No output yet."}
      </pre>
    </div>
  );
}
