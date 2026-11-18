//! "Accounts: Manage Accounts": the accounts extensions signed in with (through
//! authentication providers), which extensions use them, and signing out.

import { errorMessage } from "../lib/ipc";
import { ask, notify } from "../state/notifications";
import { showQuickPick } from "./dialogs";
import * as rpc from "./rpc";

interface AccountItem {
  providerId: string;
  providerLabel: string;
  accountId: string;
  accountLabel: string;
  /** Extensions allowed to use the account. */
  extensions: string[];
}

export async function manageAccounts() {
  const accounts = rpc.isRunning() ? await rpc.request<AccountItem[]>("auth/accounts").catch(() => []) : [];
  if (accounts.length === 0) {
    notify("info", "No accounts", "Extensions that need an account ask you to sign in when they need it.");
    return;
  }
  const picked = await showQuickPick({
    title: "Accounts",
    placeHolder: "Select an account to sign out of",
    canPickMany: false,
    items: accounts.map((a) => ({
      label: a.accountLabel,
      description: a.providerLabel,
      detail: a.extensions.length ? `Used by ${a.extensions.join(", ")}` : undefined,
    })),
  });
  const account = picked?.length ? accounts[picked[0]] : undefined;
  if (!account) return;
  const choice = await ask("info", `Sign out of ${account.accountLabel} (${account.providerLabel})?`, account.extensions.length ? `${account.extensions.join(", ")} will lose access.` : undefined, ["Sign Out", "Cancel"]);
  if (choice !== 0) return;
  try {
    await rpc.request("auth/signOut", { providerId: account.providerId, accountId: account.accountId });
    notify("success", `Signed out of ${account.accountLabel}`);
  } catch (e) {
    notify("error", "Could not sign out", errorMessage(e));
  }
}
