import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { resolveCustomEditorTab, useCustomEditors } from "../exthost/customEditors";
import * as rpc from "../exthost/rpc";
import { useExtensionHost } from "../exthost/state";
import { WebviewAnchor } from "./WebviewFrame";

/** An editor tab showing a file in an extension's custom editor (a webview). */
export function CustomEditorView({ tabPath, viewType }: { tabPath: string; viewType: string }) {
  const status = useExtensionHost((s) => s.status);
  const registered = useCustomEditors((s) => s.registered[viewType] === true);
  const webview = useCustomEditors((s) => s.tabs[tabPath]);

  // Opening the editor activates the extension providing it.
  useEffect(() => {
    if (status === "running") rpc.notify("activate", { event: `onCustomEditor:${viewType}` });
  }, [status, viewType]);
  useEffect(() => {
    if (registered && !webview) void resolveCustomEditorTab(tabPath).catch(() => {});
  }, [registered, webview, tabPath]);

  if (webview) return <WebviewAnchor id={webview.id} />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted">
      {status === "running" || status === "starting" ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <span>The extension providing this editor is not running.</span>
      )}
    </div>
  );
}
