//! `vscode.chat`: chat participants (`@name` in the Chat view). The UI sends each
//! request with the conversation so far; the participant's handler streams its
//! answer (markdown, buttons, references, progress) back as it writes it.

import { executeCommand } from "./api";
import * as dto from "./dto";
import { chatModel } from "./lm";
import * as rpc from "./rpc";
import { host } from "./state";
import {
  CancellationTokenSource,
  ChatRequestTurn,
  ChatResponseMarkdownPart,
  ChatResponseTurn,
  EventEmitter,
  LanguageModelError,
  Location,
  MarkdownString,
  Uri,
} from "./types";
import { iconDto } from "./views";

interface Participant {
  id: string;
  extensionId: string;
  api: any;
}

const participants = new Map<string, Participant>();

let activate: (event: string) => Promise<void> = async () => {};
export function setChatActivator(fn: (event: string) => Promise<void>) {
  activate = fn;
}

/** What the extension's manifest says about a participant (`contributes.chatParticipants`). */
function declared(extensionId: string, id: string): any {
  const ext = host.extensions.find((e) => e.id === extensionId);
  return (ext?.manifest.contributes?.chatParticipants ?? []).find((p: any) => p?.id === id) ?? {};
}

/**
 * Tells the UI about every participant: those extensions declare (they activate on
 * their first request, `onChatParticipant:<id>`) and those registered without a declaration.
 */
export function announce() {
  const ids = new Map<string, string>();
  for (const ext of host.extensions) for (const p of ext.manifest.contributes?.chatParticipants ?? []) if (p?.id) ids.set(p.id, ext.id);
  for (const p of participants.values()) if (!ids.has(p.id)) ids.set(p.id, p.extensionId);
  rpc.notify("chat/participants", {
    participants: [...ids].map(([id, extensionId]) => {
      const d = declared(extensionId, id);
      const api = participants.get(id)?.api;
      return {
        id,
        name: d.name ?? id.split(".").pop(),
        fullName: d.fullName ?? d.name ?? id,
        description: d.description ?? "",
        isDefault: d.isDefault === true,
        commands: (d.commands ?? []).filter((c: any) => c?.name).map((c: any) => ({ name: c.name, description: c.description ?? "" })),
        icon: api?.iconPath ? iconDto(api.iconPath) : undefined,
      };
    }),
  });
}

export function createChatParticipant(extensionId: string, id: string, handler: unknown) {
  const onDidReceiveFeedback = new EventEmitter<unknown>();
  const state: Record<string, unknown> = { id, requestHandler: handler, iconPath: undefined, followupProvider: undefined };
  const api: any = new Proxy(state, {
    get(target, key) {
      if (key === "onDidReceiveFeedback") return onDidReceiveFeedback.event;
      if (key === "dispose") {
        return () => {
          participants.delete(id);
          announce();
        };
      }
      return target[key as string];
    },
    set(target, key, value) {
      target[key as string] = value;
      if (key === "iconPath") announce();
      return true;
    },
  });
  participants.set(id, { id, extensionId, api });
  announce();
  return api;
}

// ---- Requests ----------------------------------------------------------------------

const running = new Map<number, CancellationTokenSource>();

/** Commands of the buttons participants showed, run here with their own arguments. */
const buttons = new Map<number, { command: string; arguments?: unknown[] }>();
let nextButton = 1;

/** `ChatResponseStream`: each call becomes a part the UI shows as it arrives. */
function responseStream(requestId: number, parts: string[]) {
  const push = (part: object) => rpc.notify("chat/part", { requestId, part });
  const text = (v: unknown) => (v instanceof MarkdownString ? v.value : typeof v === "string" ? v : String((v as { value?: unknown })?.value ?? ""));
  const location = (value: any) => {
    if (value instanceof Location) return { uri: value.uri.toString(), range: dto.range(value.range) };
    if (Uri.isUri(value)) return { uri: value.toString() };
    return undefined;
  };
  const stream = {
    markdown(value: string | MarkdownString) {
      const markdown = text(value);
      parts.push(markdown);
      push({ kind: "markdown", value: markdown });
      return stream;
    },
    anchor(value: unknown, title?: string) {
      push({ kind: "anchor", ...location(value), title });
      return stream;
    },
    button(command: any) {
      const id = nextButton++;
      buttons.set(id, { command: command.command, arguments: command.arguments });
      push({ kind: "button", id, title: command.title });
      return stream;
    },
    filetree(value: unknown[], baseUri: Uri) {
      push({ kind: "filetree", base: baseUri.toString(), tree: value });
      return stream;
    },
    progress(value: string) {
      push({ kind: "progress", value });
      return stream;
    },
    reference(value: unknown) {
      push({ kind: "reference", ...location(value) });
      return stream;
    },
    push(part: any) {
      if (part instanceof ChatResponseMarkdownPart) return stream.markdown(part.value);
      const kind = part?.constructor?.name ?? "";
      if (kind === "ChatResponseAnchorPart") return stream.anchor(part.value, part.title);
      if (kind === "ChatResponseCommandButtonPart") return stream.button(part.value);
      if (kind === "ChatResponseFileTreePart") return stream.filetree(part.value, part.baseUri);
      if (kind === "ChatResponseProgressPart") return stream.progress(part.value);
      if (kind === "ChatResponseReferencePart") return stream.reference(part.value);
      return stream;
    },
    // Proposed parts some participants call: shown as text rather than failing.
    warning: (value: string | MarkdownString) => stream.markdown(`> ⚠ ${text(value)}`),
  };
  return stream;
}

interface HistoryTurn {
  participant: string;
  prompt: string;
  command?: string;
  response?: string;
  result?: object;
}

async function handleRequest(params: {
  requestId: number;
  participant: string;
  prompt: string;
  command?: string;
  model?: { vendor: string; id: string };
  history: HistoryTurn[];
}) {
  if (!participants.has(params.participant)) await activate(`onChatParticipant:${params.participant}`);
  const participant = participants.get(params.participant);
  if (!participant) throw new Error("This chat participant is not available: its extension did not register it.");
  const handler = participant.api.requestHandler;
  const token = new CancellationTokenSource();
  running.set(params.requestId, token);
  const parts: string[] = [];
  try {
    const model =
      (await chatModel(params.model)) ??
      // No extension provides a model: participants that only stream text still work.
      {
        id: "none",
        name: "None",
        vendor: "none",
        family: "none",
        version: "",
        maxInputTokens: 0,
        sendRequest: () => Promise.reject(LanguageModelError.NotFound("No language model is available. Install an extension that provides one.")),
        countTokens: async () => 0,
      };
    const request = {
      prompt: params.prompt,
      command: params.command,
      references: [],
      toolReferences: [],
      toolInvocationToken: undefined,
      model,
    };
    const history = params.history.flatMap((turn) => [
      new ChatRequestTurn(turn.prompt, turn.command, [], turn.participant),
      ...(turn.response !== undefined
        ? [new ChatResponseTurn([new ChatResponseMarkdownPart(turn.response)], turn.result ?? {}, turn.participant, turn.command)]
        : []),
    ]);
    const result = (await handler(request, { history }, responseStream(params.requestId, parts), token.token)) ?? {};
    let followups: { prompt: string; label?: string; command?: string }[] = [];
    const provider = participant.api.followupProvider;
    if (provider?.provideFollowups) {
      followups = ((await Promise.resolve(provider.provideFollowups(result, { history }, token.token)).catch(() => [])) ?? []).map((f: any) => ({
        prompt: f.prompt,
        label: f.label,
        command: f.command,
      }));
    }
    return { errorDetails: result.errorDetails ? { message: result.errorDetails.message } : undefined, metadata: result.metadata, followups };
  } catch (e) {
    return { errorDetails: { message: e instanceof Error ? e.message : String(e) } };
  } finally {
    running.delete(params.requestId);
  }
}

export function listen() {
  rpc.onRequest("chat/request", handleRequest);
  rpc.onNotification("chat/cancel", (params: { requestId: number }) => running.get(params.requestId)?.cancel());
  rpc.onRequest("chat/button", async (params: { id: number }) => {
    const button = buttons.get(params.id);
    if (button) await executeCommand(button.command, ...(button.arguments ?? []));
    return null;
  });
}
