//! TextMate tokenization off the UI thread. The main thread sends documents'
//! text; this worker answers with Monaco semantic tokens whose types encode
//! colours of the active theme (see `textmate.ts`).

import { Registry, parseRawGrammar, type IGrammar } from "vscode-textmate";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import type { FromWorker, ToWorker } from "./textmate.protocol";
import { emptyDocument, encode, update, type Document } from "./textmate.tokens";

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

let injections: Record<string, string[]> = {};
let nextRequest = 1;
const grammarRequests = new Map<number, (grammar: { content: string | null; path: string }) => void>();

const registry: Promise<Registry> = (async () => {
  await loadWASM(await (await fetch(onigWasmUrl)).arrayBuffer());
  return new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    // Grammar files are read by the main thread (through the app's IPC).
    loadGrammar: (scope) =>
      new Promise((resolve) => {
        const requestId = nextRequest++;
        grammarRequests.set(requestId, ({ content, path }) =>
          resolve(content === null ? null : parseRawGrammar(content, path)),
        );
        post({ type: "loadGrammar", requestId, scope });
      }),
    getInjections: (scope) => injections[scope],
  });
})();

const documents = new Map<string, Document>();
const grammars = new Map<string, Promise<IGrammar | null>>();

function grammarFor(scope: string) {
  let grammar = grammars.get(scope);
  if (!grammar) {
    grammar = registry.then((r) => r.loadGrammar(scope));
    grammars.set(scope, grammar);
  }
  return grammar;
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "grammar":
      grammarRequests.get(message.requestId)?.(message);
      grammarRequests.delete(message.requestId);
      break;
    case "injections":
      injections = message.injections;
      break;
    case "theme": {
      const r = await registry;
      r.setTheme(message.theme);
      // Colours changed meaning: every cached tokenization is stale.
      for (const doc of documents.values()) Object.assign(doc, { lines: [], states: [], tokens: [] });
      post({ type: "theme", id: message.id, colorMap: r.getColorMap() });
      break;
    }
    case "tokenize": {
      const grammar = await grammarFor(message.scope);
      if (!grammar) {
        post({ type: "tokens", id: message.id, data: null });
        break;
      }
      let doc = documents.get(message.doc);
      if (!doc || doc.scope !== message.scope) {
        doc = emptyDocument(message.scope);
        documents.set(message.doc, doc);
      }
      update(doc, grammar, message.text);
      const data = encode(doc);
      post({ type: "tokens", id: message.id, data }, [data.buffer]);
      break;
    }
    case "close":
      documents.delete(message.doc);
      break;
  }
};
