//! `vscode.authentication`: providers extensions register (GitHub, Microsoft, a
//! company's SSO, ...) and the sessions other extensions ask them for. As in VS
//! Code, an extension needs the user's consent to sign in or to use an account;
//! the extensions allowed to use each account are remembered.

import * as fs from "node:fs";
import * as path from "node:path";
import * as rpc from "./rpc";
import { host } from "./state";
import { Disposable, EventEmitter } from "./types";

interface Registered {
  id: string;
  label: string;
  provider: any;
  supportsMultipleAccounts: boolean;
  subscription?: { dispose(): unknown };
}

interface Account {
  id: string;
  label: string;
}

const providers = new Map<string, Registered>();
const registered = new EventEmitter<string>();
export const onDidChangeSessions = new EventEmitter<{ provider: { id: string; label: string } }>();

let activate: (event: string) => Promise<void> = async () => {};
export function setAuthenticationActivator(fn: (event: string) => Promise<void>) {
  activate = fn;
}

// ---- Access (which extensions may use which account) ------------------------------

type AccessFile = Record<string, string[]>;

const accessFile = () => path.join(host.globalStoragePath, "authentication-access.json");
const accessKey = (providerId: string, account: Account) => `${providerId}/${account.label}`;

function readAccess(): AccessFile {
  try {
    return JSON.parse(fs.readFileSync(accessFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeAccess(access: AccessFile) {
  try {
    fs.mkdirSync(path.dirname(accessFile()), { recursive: true });
    fs.writeFileSync(accessFile(), JSON.stringify(access, null, 2));
  } catch {
    // Consent is asked again next time.
  }
}

const isAllowed = (providerId: string, account: Account, extensionId: string) =>
  readAccess()[accessKey(providerId, account)]?.includes(extensionId) ?? false;

function allow(providerId: string, account: Account, extensionId: string) {
  const access = readAccess();
  const key = accessKey(providerId, account);
  access[key] = [...new Set([...(access[key] ?? []), extensionId])];
  writeAccess(access);
}

function forget(providerId: string, account: Account) {
  const access = readAccess();
  delete access[accessKey(providerId, account)];
  writeAccess(access);
}

// ---- Providers ---------------------------------------------------------------------

export function registerAuthenticationProvider(id: string, label: string, provider: any, options?: { supportsMultipleAccounts?: boolean }) {
  if (providers.has(id)) throw new Error(`An authentication provider with id '${id}' is already registered.`);
  const entry: Registered = { id, label, provider, supportsMultipleAccounts: options?.supportsMultipleAccounts === true };
  entry.subscription = provider.onDidChangeSessions?.(() => onDidChangeSessions.fire({ provider: { id, label } }));
  providers.set(id, entry);
  registered.fire(id);
  return new Disposable(() => {
    entry.subscription?.dispose?.();
    if (providers.get(id) === entry) providers.delete(id);
    onDidChangeSessions.fire({ provider: { id, label } });
  });
}

const PROVIDER_WAIT_MS = 5000;

/** The provider `id`, activating the extension that contributes it (and waiting a moment for it to register). */
async function providerFor(id: string): Promise<Registered> {
  const existing = providers.get(id);
  if (existing) return existing;
  const contributed = host.extensions.some((e) =>
    (e.manifest.contributes?.authentication ?? []).some((a: { id?: string }) => a?.id === id),
  );
  void activate(`onAuthenticationRequest:${id}`);
  if (contributed) {
    const found = await new Promise<Registered | undefined>((resolve) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        resolve(providers.get(id));
      }, PROVIDER_WAIT_MS);
      const subscription = registered.event((registeredId) => {
        if (registeredId !== id) return;
        clearTimeout(timer);
        subscription.dispose();
        resolve(providers.get(id));
      });
    });
    if (found) return found;
  }
  throw new Error(`No authentication provider '${id}' is currently registered.`);
}

// ---- Sessions ------------------------------------------------------------------------

function extensionName(extensionId: string) {
  const ext = host.extensions.find((e) => e.id === extensionId);
  return ext?.manifest.displayName ?? ext?.manifest.name ?? extensionId;
}

async function consent(message: string, detail?: string): Promise<boolean> {
  const choice = await rpc.request<number | null>("window/showMessage", { severity: "info", message, detail, modal: true, items: ["Allow", "Cancel"] });
  return choice === 0;
}

const sameScopes = (a: readonly string[], b: readonly string[]) => [...a].sort().join(" ") === [...b].sort().join(" ");

export async function getSession(extensionId: string, providerId: string, scopes: readonly string[], options: any = {}) {
  const provider = await providerFor(providerId);
  const name = extensionName(extensionId);
  const account: Account | undefined = options.account;
  const sessions: any[] = ((await provider.provider.getSessions(scopes, { account })) ?? []).filter(
    (s: any) => !s.scopes || sameScopes(s.scopes, scopes) || scopes.every((scope) => s.scopes.includes(scope)),
  );

  if (!options.forceNewSession && sessions.length > 0) {
    const session = (account && sessions.find((s) => s.account.id === account.id)) || sessions[0];
    if (isAllowed(providerId, session.account, extensionId)) return session;
    if (options.silent) return undefined;
    if (!options.createIfNone) return undefined;
    if (await consent(`The extension '${name}' wants to access the ${provider.label} account '${session.account.label}'.`)) {
      allow(providerId, session.account, extensionId);
      return session;
    }
    throw new Error("User did not consent to login.");
  }

  if (options.silent || (!options.createIfNone && !options.forceNewSession)) return undefined;
  const detail = typeof options.forceNewSession === "object" ? options.forceNewSession.detail : typeof options.createIfNone === "object" ? options.createIfNone.detail : undefined;
  if (!(await consent(`The extension '${name}' wants to sign in using ${provider.label}.`, detail))) {
    throw new Error("User did not consent to login.");
  }
  const session = await provider.provider.createSession(scopes, { account });
  allow(providerId, session.account, extensionId);
  return session;
}

export async function getAccounts(providerId: string): Promise<Account[]> {
  const provider = await providerFor(providerId);
  const sessions: any[] = (await provider.provider.getSessions(undefined, {})) ?? [];
  const byId = new Map(sessions.map((s) => [s.account.id, { id: s.account.id, label: s.account.label }]));
  return [...byId.values()];
}

// ---- The UI's Accounts commands -----------------------------------------------------------

export function listen() {
  rpc.onRequest("auth/accounts", async () => {
    const access = readAccess();
    const result: { providerId: string; providerLabel: string; accountId: string; accountLabel: string; extensions: string[] }[] = [];
    for (const provider of providers.values()) {
      const sessions: any[] = (await Promise.resolve(provider.provider.getSessions(undefined, {})).catch(() => [])) ?? [];
      const accounts = new Map<string, Account>();
      for (const s of sessions) accounts.set(s.account.id, s.account);
      for (const account of accounts.values()) {
        result.push({
          providerId: provider.id,
          providerLabel: provider.label,
          accountId: account.id,
          accountLabel: account.label,
          extensions: (access[accessKey(provider.id, account)] ?? []).map(extensionName),
        });
      }
    }
    return result;
  });
  rpc.onRequest("auth/signOut", async (params: { providerId: string; accountId: string }) => {
    const provider = providers.get(params.providerId);
    if (!provider) return false;
    const sessions: any[] = (await provider.provider.getSessions(undefined, {})) ?? [];
    const mine = sessions.filter((s) => s.account.id === params.accountId);
    for (const session of mine) await provider.provider.removeSession(session.id);
    if (mine[0]) forget(params.providerId, mine[0].account);
    return true;
  });
}
