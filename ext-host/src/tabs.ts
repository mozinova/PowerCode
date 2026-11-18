//! `window.tabGroups`: the editor groups and tabs of the UI, which sends them on
//! every change (`tabs/changed`). Tab and group objects keep their identity while
//! they stay open, so extensions can compare and hold on to them.

import * as rpc from "./rpc";
import { EventEmitter, TabInputCustom, TabInputText, TabInputTextDiff, TabInputWebview, Uri } from "./types";

type InputDto =
  | { kind: "text"; uri: string }
  | { kind: "diff"; original: string; modified: string }
  | { kind: "custom"; uri: string; viewType: string }
  | { kind: "webview"; viewType: string }
  | { kind: "other" };

interface TabDto {
  /** The UI's tab path, unique within its group. */
  id: string;
  label: string;
  isActive: boolean;
  isDirty: boolean;
  input: InputDto;
}

interface GroupDto {
  id: number;
  isActive: boolean;
  tabs: TabDto[];
}

/** Where each tab and group is in the UI, for `close`. */
const tabRefs = new WeakMap<object, { group: number; id: string }>();
const groupRefs = new WeakMap<object, number>();

let groups: any[] = [];
let tabsByKey = new Map<string, any>();
let groupsById = new Map<number, any>();

const onDidChangeTabs = new EventEmitter<{ opened: any[]; closed: any[]; changed: any[] }>();
const onDidChangeTabGroups = new EventEmitter<{ opened: any[]; closed: any[]; changed: any[] }>();

function input(dto: InputDto) {
  switch (dto.kind) {
    case "text":
      return new TabInputText(Uri.parse(dto.uri));
    case "diff":
      return new TabInputTextDiff(Uri.parse(dto.original), Uri.parse(dto.modified));
    case "custom":
      return new TabInputCustom(Uri.parse(dto.uri), dto.viewType);
    case "webview":
      return new TabInputWebview(dto.viewType);
    default:
      return undefined;
  }
}

function update(dtos: GroupDto[]) {
  const tabs = { opened: [] as any[], closed: [] as any[], changed: [] as any[] };
  const changedGroups = { opened: [] as any[], closed: [] as any[], changed: [] as any[] };
  const nextTabs = new Map<string, any>();
  const nextGroups = new Map<number, any>();

  groups = dtos.map((dto, index) => {
    let group = groupsById.get(dto.id);
    if (!group) {
      group = { isActive: dto.isActive, viewColumn: index + 1, activeTab: undefined, tabs: [] };
      groupRefs.set(group, dto.id);
      changedGroups.opened.push(group);
    } else if (group.isActive !== dto.isActive || group.viewColumn !== index + 1) {
      group.isActive = dto.isActive;
      group.viewColumn = index + 1;
      changedGroups.changed.push(group);
    }
    nextGroups.set(dto.id, group);

    group.tabs = dto.tabs.map((t) => {
      const key = `${dto.id}\u0000${t.id}`;
      let tab = tabsByKey.get(key);
      if (!tab) {
        tab = { label: t.label, group, input: input(t.input), isActive: t.isActive, isDirty: t.isDirty, isPinned: false, isPreview: false };
        tabRefs.set(tab, { group: dto.id, id: t.id });
        tabs.opened.push(tab);
      } else if (tab.label !== t.label || tab.isActive !== t.isActive || tab.isDirty !== t.isDirty) {
        Object.assign(tab, { label: t.label, isActive: t.isActive, isDirty: t.isDirty });
        tabs.changed.push(tab);
      }
      nextTabs.set(key, tab);
      return tab;
    });
    group.activeTab = group.tabs.find((t: any) => t.isActive);
    return group;
  });

  for (const [key, tab] of tabsByKey) if (!nextTabs.has(key)) tabs.closed.push(tab);
  for (const [id, group] of groupsById) if (!nextGroups.has(id)) changedGroups.closed.push(group);
  tabsByKey = nextTabs;
  groupsById = nextGroups;

  if (changedGroups.opened.length || changedGroups.closed.length || changedGroups.changed.length) onDidChangeTabGroups.fire(changedGroups);
  if (tabs.opened.length || tabs.closed.length || tabs.changed.length) onDidChangeTabs.fire(tabs);
}

async function close(target: any, preserveFocus?: boolean): Promise<boolean> {
  const list = Array.isArray(target) ? target : [target];
  const refs: { group: number; id: string }[] = [];
  for (const item of list) {
    const groupId = groupRefs.get(item);
    if (groupId !== undefined) refs.push(...item.tabs.map((tab: any) => tabRefs.get(tab)).filter(Boolean));
    else if (tabRefs.has(item)) refs.push(tabRefs.get(item)!);
  }
  if (refs.length === 0) return false;
  return rpc.request<boolean>("tabs/close", { tabs: refs, preserveFocus: preserveFocus ?? false });
}

const NO_GROUP = { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] };

export const tabGroups = {
  get all() {
    return groups;
  },
  get activeTabGroup() {
    return groups.find((g) => g.isActive) ?? groups[0] ?? NO_GROUP;
  },
  onDidChangeTabs: onDidChangeTabs.event,
  onDidChangeTabGroups: onDidChangeTabGroups.event,
  close,
};

export function listen() {
  rpc.onNotification("tabs/changed", (params: { groups: GroupDto[] }) => update(params.groups ?? []));
}
