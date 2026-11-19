//! `vscode.scm`: source control providers of extensions (Perforce, SVN, Jujutsu,
//! ...). The UI shows each one in the Commit tool window: its input box and
//! accept button, title actions, and resource groups with their files.

import { executeCommand } from "./api";
import * as rpc from "./rpc";
import { EventEmitter, Uri } from "./types";
import { iconDto } from "./views";

interface Provider {
  handle: number;
  api: any;
  groups: Map<string, Group>;
  /** What extensions see (changes are sent to the UI) ... */
  inputBox: any;
  /** ... and the object behind it, for the user's typing (not sent back). */
  inputState: { value: string };
  /** Bumped when the extension sets the text: only then does the UI take it. */
  inputVersion: number;
  onDidChangeInput: EventEmitter<string>;
}

interface Group {
  api: any;
  resources: any[];
}

const providers = new Map<number, Provider>();
let nextHandle = 1;
/** One update per provider per tick, however many properties an extension sets. */
const pending = new Set<number>();

function schedule(handle: number) {
  if (pending.has(handle)) return;
  pending.add(handle);
  queueMicrotask(() => {
    pending.delete(handle);
    const provider = providers.get(handle);
    if (provider) send(provider);
  });
}

/** A command as the UI shows it: its arguments stay here (they are often the provider itself). */
function commandInfo(c: any) {
  return c && typeof c.command === "string" ? { command: c.command, title: c.title ?? "", tooltip: c.tooltip } : undefined;
}

function decorations(d: any) {
  if (!d) return undefined;
  const dark = { ...d, ...(d.dark ?? {}) };
  return {
    strikeThrough: dark.strikeThrough === true,
    faded: dark.faded === true,
    tooltip: typeof dark.tooltip === "string" ? dark.tooltip : undefined,
    icon: dark.iconPath ? iconDto(dark.iconPath) : undefined,
  };
}

function send(provider: Provider) {
  const { api, inputBox, handle } = provider;
  rpc.notify("scm/update", {
    handle,
    id: api.id,
    label: api.label,
    rootUri: api.rootUri?.toString(),
    count: api.count,
    inputBox: { value: inputBox.value, version: provider.inputVersion, placeholder: inputBox.placeholder, enabled: inputBox.enabled, visible: inputBox.visible },
    acceptInputCommand: commandInfo(api.acceptInputCommand),
    statusBarCommands: (api.statusBarCommands ?? []).map(commandInfo).filter(Boolean),
    groups: [...provider.groups.entries()].map(([id, group]) => ({
      id,
      label: group.api.label,
      hideWhenEmpty: group.api.hideWhenEmpty === true,
      contextValue: group.api.contextValue,
      resources: group.resources.map((r, index) => ({
        index,
        uri: r.resourceUri?.toString(),
        contextValue: r.contextValue,
        command: commandInfo(r.command),
        decorations: decorations(r.decorations),
      })),
    })),
  });
}

/** Properties that, when an extension sets them, are shown again. */
function observed<T extends object>(target: T, onChange: (key: string | symbol) => void): T {
  return new Proxy(target, {
    set(object, key, value) {
      (object as any)[key] = value;
      onChange(key);
      return true;
    },
  });
}

export function createSourceControl(id: string, label: string, rootUri?: Uri) {
  const handle = nextHandle++;
  const update = () => schedule(handle);
  const onDidChangeInput = new EventEmitter<string>();
  const inputState = { value: "", placeholder: "", enabled: true, visible: true, validateInput: undefined as unknown, onDidChange: onDidChangeInput.event };
  const provider: Provider = { handle, api: undefined, groups: new Map(), inputBox: undefined, inputState, inputVersion: 0, onDidChangeInput };
  provider.inputBox = observed(inputState, (key) => {
    if (key === "value") provider.inputVersion++;
    update();
  });
  const inputBox = provider.inputBox;
  const api = observed(
    {
      id,
      label,
      rootUri,
      inputBox,
      count: undefined as number | undefined,
      quickDiffProvider: undefined as unknown,
      commitTemplate: undefined as string | undefined,
      acceptInputCommand: undefined as unknown,
      statusBarCommands: undefined as unknown[] | undefined,
      createResourceGroup(groupId: string, groupLabel: string) {
        const group: Group = { api: undefined, resources: [] };
        group.api = observed(
          {
            id: groupId,
            label: groupLabel,
            hideWhenEmpty: undefined as boolean | undefined,
            contextValue: undefined as string | undefined,
            get resourceStates() {
              return group.resources;
            },
            set resourceStates(states: any[]) {
              group.resources = [...(states ?? [])];
              update();
            },
            dispose() {
              provider.groups.delete(groupId);
              update();
            },
          },
          update,
        );
        provider.groups.set(groupId, group);
        update();
        return group.api;
      },
      dispose() {
        providers.delete(handle);
        rpc.notify("scm/dispose", { handle });
      },
    },
    update,
  );
  provider.api = api;
  providers.set(handle, provider);
  update();
  return api;
}

/** `scm.inputBox` (deprecated): the input box of the first provider. */
export function firstInputBox() {
  return providers.values().next().value?.inputBox;
}

/** What a `{ $scm }` argument from the UI stands for: a provider, one of its groups, or a resource. */
export function scmElement(ref: { handle: number; group?: string; resource?: number }): unknown {
  const provider = providers.get(ref.handle);
  if (!provider) return undefined;
  if (ref.group === undefined) return provider.api;
  const group = provider.groups.get(ref.group);
  if (!group) return undefined;
  return ref.resource === undefined ? group.api : group.resources[ref.resource];
}

export function listen() {
  rpc.onNotification("scm/input", (params: { handle: number; value: string }) => {
    const provider = providers.get(params.handle);
    if (!provider || provider.inputState.value === params.value) return;
    // Behind the proxy: the UI already shows it, so it is not sent back.
    provider.inputState.value = params.value;
    provider.onDidChangeInput.fire(params.value);
  });
  // Commands run here, with the arguments the extension gave them (Uris, resource states, ...).
  rpc.onRequest("scm/execute", async (params: { handle: number; group: string; resource: number }) => {
    const resource: any = scmElement(params);
    if (!resource?.command) return null;
    await executeCommand(resource.command.command, ...(resource.command.arguments ?? []));
    return null;
  });
  rpc.onRequest("scm/accept", async (params: { handle: number }) => {
    const command = providers.get(params.handle)?.api.acceptInputCommand;
    if (command) await executeCommand(command.command, ...(command.arguments ?? []));
    return null;
  });
  rpc.onRequest("scm/validate",async (params: { handle: number; value: string; position: number }) => {
    const validate = providers.get(params.handle)?.inputBox.validateInput;
    if (typeof validate !== "function") return null;
    const result = await validate(params.value, params.position);
    if (!result) return null;
    return { message: typeof result.message === "string" ? result.message : String(result.message?.value ?? ""), type: result.type ?? 1 };
  });
}
