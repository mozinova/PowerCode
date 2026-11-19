//! Extensions' source control providers (Perforce, SVN, Jujutsu, ...), shown in
//! the Commit tool window under the built-in Git: input box, accept button,
//! title actions, and resource groups whose files open or run their command.

import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { menuItems } from "../exthost/contributions";
import { pathFromUri } from "../exthost/languages";
import {
  acceptScmInput,
  openScmResource,
  scmArg,
  setScmInput,
  useScm,
  type ScmGroup,
  type ScmProvider,
  type ScmResource,
} from "../exthost/scm";
import { isTrue, useContributions } from "../exthost/views";
import { errorMessage } from "../lib/ipc";
import { basename, isWithin, parentDir } from "../lib/paths";
import { notify } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { ExtIcon } from "./ExtIcon";
import { ActionButton, menuEntries, MoreActions, useWhenContext } from "./ExtensionViews";
import { FileIcon } from "./FileIcon";
import { ContextMenu } from "./Menu";
import { tooltipProps } from "./Tooltip";

const report = (what: string) => (e: unknown) => notify("error", what, errorMessage(e));

function DecorationIcon({ icon }: { icon: NonNullable<ScmResource["decorations"]>["icon"] }) {
  if (!icon) return null;
  if ("themeIcon" in icon) return <ExtIcon icon={{ codicon: icon.themeIcon, color: icon.color }} size={14} />;
  const url = "localPath" in icon ? convertFileSrc(icon.localPath) : icon.uri.startsWith("file:") ? convertFileSrc(pathFromUri(icon.uri)) : icon.uri;
  return <img src={url} alt="" className="size-3.5 shrink-0" />;
}

function ResourceRow({ provider, group, resource }: { provider: ScmProvider; group: ScmGroup; resource: ScmResource }) {
  const contributions = useContributions();
  const root = useWorkspace((s) => s.root);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const path = resource.uri && /^(file|ssh):/.test(resource.uri) ? pathFromUri(resource.uri) : undefined;
  const name = path ? basename(path) : (resource.uri?.split("/").pop() ?? "");
  const dir = path && root && isWithin(parentDir(path), root) ? parentDir(path).slice(root.length + 1) : path ? parentDir(path) : "";
  const context = { scmProvider: provider.id, scmResourceGroup: group.id, scmResourceState: resource.contextValue ?? "" };
  const { inline, other } = menuItems(contributions, "scm/resourceState/context", (when) => isTrue(when, context));
  const args = [scmArg(provider.handle, group.id, resource.index)];
  const d = resource.decorations;

  return (
    <>
      <div
        role="treeitem"
        {...tooltipProps(d?.tooltip ?? path)}
        onClick={() => {
          if (resource.command) void openScmResource(provider.handle, group.id, resource.index).catch(report("Command failed"));
          else if (path) useWorkspace.getState().openFile(path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (other.length > 0) setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`group flex h-[26px] cursor-default items-center gap-1.5 pr-1.5 pl-7 hover:bg-hover ${d?.faded ? "opacity-60" : ""}`}
      >
        <FileIcon name={name} />
        <span className={`shrink-0 ${d?.strikeThrough ? "line-through" : ""}`}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">{dir}</span>
        {inline.length > 0 && (
          <span className="invisible flex shrink-0 items-center group-hover:visible">
            {inline.map((item) => (
              <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
            ))}
          </span>
        )}
        <DecorationIcon icon={d?.icon} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuEntries(contributions, other, args)} onClose={closeMenu} />}
    </>
  );
}

function GroupSection({ provider, group }: { provider: ScmProvider; group: ScmGroup }) {
  const contributions = useContributions();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  if (group.hideWhenEmpty && group.resources.length === 0) return null;
  const context = { scmProvider: provider.id, scmResourceGroup: group.id };
  const { inline, other } = menuItems(contributions, "scm/resourceGroup/context", (when) => isTrue(when, context));
  const args = [scmArg(provider.handle, group.id)];

  return (
    <div role="group">
      <div
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (other.length > 0) setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="group flex h-[26px] cursor-default items-center gap-1 pr-1.5 pl-2 hover:bg-hover"
      >
        {open ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
        <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
        {inline.length > 0 && (
          <span className="invisible flex shrink-0 items-center group-hover:visible">
            {inline.map((item) => (
              <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
            ))}
          </span>
        )}
        <span className="rounded-full bg-hover px-1.5 text-xs text-fg-muted">{group.resources.length}</span>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuEntries(contributions, other, args)} onClose={closeMenu} />}
      {open && group.resources.map((r) => <ResourceRow key={`${r.index}:${r.uri}`} provider={provider} group={group} resource={r} />)}
    </div>
  );
}

function ProviderSection({ provider }: { provider: ScmProvider }) {
  const contributions = useContributions();
  const context = { scmProvider: provider.id };
  const { inline, other } = menuItems(contributions, "scm/title", (when) => isTrue(when, context));
  const args = [scmArg(provider.handle)];
  const { inputBox, acceptInputCommand } = provider;
  const accept = () => void acceptScmInput(provider.handle).catch(report(`${acceptInputCommand?.title ?? "The command"} failed`));

  return (
    <section className="border-t border-line-soft pt-1.5">
      <div className="flex h-7 items-center gap-1 px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{provider.label}</span>
        {inline.map((item) => (
          <ActionButton key={item.command} contributions={contributions} item={item} args={args} />
        ))}
        <MoreActions entries={menuEntries(contributions, other, args)} />
      </div>
      {inputBox.visible && (
        <div className="flex flex-col gap-2 px-3 pb-2">
          <input
            value={inputBox.value}
            disabled={!inputBox.enabled}
            onChange={(e) => setScmInput(provider.handle, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && acceptInputCommand) {
                e.preventDefault();
                accept();
              }
            }}
            placeholder={inputBox.placeholder.replace("{0}", "Ctrl+Enter")}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-md border border-input-border bg-input px-2 text-fg outline-none placeholder:text-fg-subtle focus:border-accent disabled:opacity-60"
          />
          {acceptInputCommand && (
            <button
              type="button"
              {...tooltipProps(acceptInputCommand.tooltip)}
              onClick={accept}
              className="h-7 rounded-md bg-accent font-medium text-white hover:bg-accent-hover"
            >
              {acceptInputCommand.title.replace(/\$\([\w~-]+\)\s*/g, "")}
            </button>
          )}
        </div>
      )}
      {provider.groups.map((group) => (
        <GroupSection key={group.id} provider={provider} group={group} />
      ))}
    </section>
  );
}

/** Every extension's source control, one section each; nothing when there are none. */
export function ExtensionSourceControls() {
  useWhenContext();
  const providers = useScm((s) => s.providers);
  if (providers.length === 0) return null;
  return (
    <div className="max-h-[50%] shrink-0 overflow-y-auto pb-1">
      {providers.map((provider) => (
        <ProviderSection key={provider.handle} provider={provider} />
      ))}
    </div>
  );
}
