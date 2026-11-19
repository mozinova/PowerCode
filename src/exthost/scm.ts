//! Extensions' source control providers (`scm.createSourceControl`) as the UI
//! knows them: sent whole by the host whenever one changes (ext-host/src/scm.ts).

import { create } from "zustand";
import * as rpc from "./rpc";

export interface ScmCommand {
  command: string;
  title: string;
  tooltip?: string;
}

export interface ScmResource {
  index: number;
  uri?: string;
  contextValue?: string;
  command?: ScmCommand;
  decorations?: {
    strikeThrough: boolean;
    faded: boolean;
    tooltip?: string;
    icon?: { themeIcon: string; color?: string } | { uri: string } | { localPath: string };
  };
}

export interface ScmGroup {
  id: string;
  label: string;
  hideWhenEmpty: boolean;
  contextValue?: string;
  resources: ScmResource[];
}

export interface ScmProvider {
  handle: number;
  id: string;
  label: string;
  rootUri?: string;
  count?: number;
  /** `version` changes only when the extension sets the text. */
  inputBox: { value: string; version: number; placeholder: string; enabled: boolean; visible: boolean };
  acceptInputCommand?: ScmCommand;
  statusBarCommands: ScmCommand[];
  groups: ScmGroup[];
}

export const useScm = create<{ providers: ScmProvider[] }>(() => ({ providers: [] }));

/** The argument menus pass for a provider, group or resource (revived by the host). */
export const scmArg = (handle: number, group?: string, resource?: number) => ({ $scm: { handle, group, resource } });

/** The user typed in a provider's input box. */
export function setScmInput(handle: number, value: string) {
  useScm.setState(({ providers }) => ({
    providers: providers.map((p) => (p.handle === handle ? { ...p, inputBox: { ...p.inputBox, value } } : p)),
  }));
  rpc.notify("scm/input", { handle, value });
}

/** Runs a resource's own command (on the host, with its original arguments). */
export function openScmResource(handle: number, group: string, resource: number) {
  return rpc.request("scm/execute", { handle, group, resource });
}

/** Runs the provider's accept command (e.g. "Commit") with its arguments. */
export function acceptScmInput(handle: number) {
  return rpc.request("scm/accept", { handle });
}

export function registerScmHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("scm/update", (provider: ScmProvider) =>
    useScm.setState(({ providers }) => {
      // The text shown is the user's, unless the extension set one since (e.g. cleared after a commit):
      // the host's copy of the user's typing may be behind what was typed meanwhile.
      const index = providers.findIndex((p) => p.handle === provider.handle);
      const current = providers[index];
      const next =
        current && current.inputBox.version === provider.inputBox.version
          ? { ...provider, inputBox: { ...provider.inputBox, value: current.inputBox.value } }
          : provider;
      return { providers: index < 0 ? [...providers, next] : providers.map((p, i) => (i === index ? next : p)) };
    }),
  );
  onNotification("scm/dispose", ({ handle }) =>
    useScm.setState(({ providers }) => ({ providers: providers.filter((p) => p.handle !== handle) })),
  );
}

export function resetScm() {
  useScm.setState({ providers: [] });
}
