//! `vscode.lm`: language models extensions provide (`registerLanguageModelChatProvider`)
//! and use (`selectChatModels`, `sendRequest`), tools (`registerTool`, `invokeTool`,
//! `tools`) and MCP server definitions. An extension using another's models needs
//! the user's consent once, as in VS Code.

import * as fs from "node:fs";
import * as path from "node:path";
import * as rpc from "./rpc";
import { host } from "./state";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  LanguageModelError,
  LanguageModelTextPart,
  LanguageModelToolResult,
  MarkdownString,
} from "./types";

let activate: (event: string) => Promise<void> = async () => {};
export function setLmActivator(fn: (event: string) => Promise<void>) {
  activate = fn;
}

// ---- Models -------------------------------------------------------------------------

interface Provider {
  vendor: string;
  extensionId: string;
  provider: any;
}

const providers = new Map<string, Provider>();
export const onDidChangeChatModels = new EventEmitter<void>();

export function registerLanguageModelChatProvider(extensionId: string, vendor: string, provider: any) {
  const entry = { vendor, extensionId, provider };
  providers.set(vendor, entry);
  const subscription = provider.onDidChangeLanguageModelChatInformation?.(() => changed());
  changed();
  return new Disposable(() => {
    subscription?.dispose?.();
    if (providers.get(vendor) === entry) providers.delete(vendor);
    changed();
  });
}

function changed() {
  onDidChangeChatModels.fire();
  rpc.notify("lm/changed", {});
}

/** Extensions allowed to use other extensions' models (asked once, remembered). */
const accessFile = () => path.join(host.globalStoragePath, "language-model-access.json");

function allowed(): string[] {
  try {
    return JSON.parse(fs.readFileSync(accessFile(), "utf8"));
  } catch {
    return [];
  }
}

const askedThisSession = new Map<string, Promise<boolean>>();

async function consent(extensionId: string, justification?: string): Promise<boolean> {
  if (allowed().includes(extensionId)) return true;
  let asking = askedThisSession.get(extensionId);
  if (!asking) {
    const ext = host.extensions.find((e) => e.id === extensionId);
    const name = ext?.manifest.displayName ?? ext?.manifest.name ?? extensionId;
    asking = rpc
      .request<number | null>("window/showMessage", {
        severity: "info",
        message: `The extension '${name}' wants to use the language models available in PowerCode.`,
        detail: justification,
        modal: true,
        items: ["Allow", "Don't Allow"],
      })
      .then((choice) => {
        if (choice !== 0) return false;
        try {
          fs.mkdirSync(path.dirname(accessFile()), { recursive: true });
          fs.writeFileSync(accessFile(), JSON.stringify([...allowed(), extensionId]));
        } catch {
          // Asked again next session.
        }
        return true;
      });
    askedThisSession.set(extensionId, asking);
  }
  return asking;
}

/** Async iterable fed by a producer: what `LanguageModelChatResponse.stream` is. */
function channel<T>() {
  const queue: T[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(value: T) {
      queue.push(value);
      notify();
    },
    end(error?: unknown) {
      done = true;
      failure = error;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) yield queue.shift()!;
        else if (done) {
          if (failure) throw failure;
          return;
        } else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

interface ModelInfo {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  vendor: string;
}

function modelApi(entry: Provider, info: any, callerId: string) {
  const model = {
    id: info.id,
    name: info.name ?? info.id,
    vendor: entry.vendor,
    family: info.family ?? info.id,
    version: info.version ?? "",
    maxInputTokens: info.maxInputTokens ?? 0,
    capabilities: info.capabilities ?? {},
    sendRequest(messages: unknown[], options: any = {}, token?: any) {
      return sendRequest(entry, info, callerId, messages, options, token);
    },
    async countTokens(text: unknown, token?: any) {
      if (typeof entry.provider.provideTokenCount === "function") {
        return entry.provider.provideTokenCount(info, text, token ?? new CancellationTokenSource().token);
      }
      // A rough estimate: about four characters per token.
      return Math.ceil((typeof text === "string" ? text : JSON.stringify(text)).length / 4);
    },
  };
  return model;
}

async function sendRequest(entry: Provider, info: any, callerId: string, messages: unknown[], options: any, token: any) {
  // `""`: a chat request, whose model the user picked in the Chat view.
  if (callerId !== "" && callerId !== entry.extensionId && !(await consent(callerId, options?.justification))) {
    throw LanguageModelError.NoPermissions("The user did not allow the use of language models.");
  }
  const stream = channel<unknown>();
  const text = channel<string>();
  const source = new CancellationTokenSource();
  token?.onCancellationRequested?.(() => source.cancel());
  const progress = {
    report(part: any) {
      stream.push(part);
      if (part instanceof LanguageModelTextPart || typeof part?.value === "string") text.push(part.value);
    },
  };
  const done = Promise.resolve()
    .then(() => entry.provider.provideLanguageModelChatResponse(info, messages, options ?? {}, progress, source.token))
    .then(
      () => {
        stream.end();
        text.end();
      },
      (e) => {
        stream.end(e);
        text.end(e);
      },
    );
  void done;
  return { stream, text };
}

/** The models of every provider (asking each one), as the API objects `callerId` uses. */
async function allModels(callerId: string) {
  const token = new CancellationTokenSource().token;
  const lists = await Promise.all(
    [...providers.values()].map(async (entry) => {
      try {
        const infos = (await entry.provider.provideLanguageModelChatInformation({ silent: true }, token)) ?? [];
        return infos.map((info: any) => ({ entry, info, api: modelApi(entry, info, callerId) }));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat();
}

async function activateProviders() {
  const vendors = new Set<string>();
  for (const ext of host.extensions) for (const p of ext.manifest.contributes?.languageModelChatProviders ?? []) if (p?.vendor) vendors.add(p.vendor);
  await Promise.all([...vendors].map((v) => activate(`onLanguageModelChatProvider:${v}`)));
}

export async function selectChatModels(callerId: string, selector: { vendor?: string; family?: string; version?: string; id?: string } = {}) {
  await activateProviders();
  return (await allModels(callerId))
    .filter(({ api }) => (!selector.vendor || api.vendor === selector.vendor) && (!selector.family || api.family === selector.family))
    .filter(({ api }) => (!selector.version || api.version === selector.version) && (!selector.id || api.id === selector.id))
    .map(({ api }) => api);
}

/** The model the user picked in the Chat view (else the first one), for a chat request. */
export async function chatModel(wanted?: { vendor: string; id: string }) {
  const models = await selectChatModels("");
  return models.find((m) => wanted && m.vendor === wanted.vendor && m.id === wanted.id) ?? models[0];
}

// ---- Tools ----------------------------------------------------------------------------

const tools = new Map<string, { extensionId: string; tool: any }>();

/** `lm.tools`: the tools extensions declare (`contributes.languageModelTools`). */
export function toolInfos() {
  return host.extensions.flatMap((ext) =>
    (ext.manifest.contributes?.languageModelTools ?? [])
      .filter((t: any) => t?.name)
      .map((t: any) => ({
        name: t.name,
        description: t.modelDescription ?? t.userDescription ?? "",
        inputSchema: t.inputSchema,
        tags: t.tags ?? [],
      })),
  );
}

export function registerTool(extensionId: string, name: string, tool: any) {
  tools.set(name, { extensionId, tool });
  return new Disposable(() => {
    if (tools.get(name)?.tool === tool) tools.delete(name);
  });
}

export async function invokeTool(name: string, options: any = {}, token?: any) {
  await activate(`onLanguageModelTool:${name}`);
  const entry = tools.get(name);
  if (!entry) throw new Error(`Tool '${name}' was not found.`);
  const cancel = token ?? new CancellationTokenSource().token;
  // Tools may ask the user first (`prepareInvocation` → `confirmationMessages`).
  const prepared = await entry.tool.prepareInvocation?.({ input: options.input }, cancel);
  const confirm = prepared?.confirmationMessages;
  if (confirm) {
    const message = confirm.message instanceof MarkdownString ? confirm.message.value : String(confirm.message ?? "");
    const choice = await rpc.request<number | null>("window/showMessage", { severity: "info", message: confirm.title ?? `Run ${name}?`, detail: message, modal: true, items: ["Continue", "Cancel"] });
    if (choice !== 0) throw new Error("The user cancelled the tool call.");
  }
  const result = await entry.tool.invoke({ input: options.input, toolInvocationToken: options.toolInvocationToken }, cancel);
  return result ?? new LanguageModelToolResult([]);
}

// ---- MCP servers ------------------------------------------------------------------------

const mcpProviders = new Map<string, any>();

/** Accepted and listed for the UI; PowerCode does not start MCP servers itself yet. */
export function registerMcpServerDefinitionProvider(id: string, provider: any) {
  mcpProviders.set(id, provider);
  return new Disposable(() => mcpProviders.delete(id));
}

export function listen() {
  rpc.onRequest("lm/models", async () => {
    await activateProviders();
    const models = await allModels("");
    return models.map(({ api }): ModelInfo => ({
      id: api.id,
      name: api.name,
      family: api.family,
      version: api.version,
      maxInputTokens: api.maxInputTokens,
      maxOutputTokens: 0,
      vendor: api.vendor,
    }));
  });
}
