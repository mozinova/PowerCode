//! `vscode.tests`: test controllers of extensions (Jest, Vitest, Python, Go, ...).
//! The UI's Testing tool window shows each controller's tree of tests, runs them
//! through the controller's run profiles, and shows each test's latest result.

import * as dto from "./dto";
import * as rpc from "./rpc";
import { CancellationTokenSource, EventEmitter, MarkdownString, TestRunProfileKind, TestRunRequest, Uri } from "./types";

interface Controller {
  handle: number;
  api: any;
  profiles: Map<number, any>;
}

const controllers = new Map<number, Controller>();
/** Every test item, by the handle the UI knows it by. */
const items = new Map<number, any>();
const handles = new WeakMap<object, number>();
let nextHandle = 1;

const pending = new Set<number>();

function schedule(controller: Controller) {
  if (pending.has(controller.handle)) return;
  pending.add(controller.handle);
  // Several changes in a row (adding a file's tests) make one update.
  setTimeout(() => {
    pending.delete(controller.handle);
    if (controllers.has(controller.handle)) send(controller);
  }, 30);
}

function itemDto(item: any): unknown {
  return {
    handle: handles.get(item),
    id: item.id,
    label: item.label,
    description: item.description,
    sortText: item.sortText,
    uri: item.uri?.toString(),
    range: item.range ? dto.range(item.range) : undefined,
    busy: item.busy === true,
    error: item.error === undefined ? undefined : item.error instanceof MarkdownString ? item.error.value : String(item.error),
    canResolveChildren: item.canResolveChildren === true,
    children: [...item.children._map.values()].map(itemDto),
  };
}

function send(controller: Controller) {
  const { api } = controller;
  rpc.notify("tests/controller", {
    handle: controller.handle,
    id: api.id,
    label: api.label,
    canRefresh: typeof api.refreshHandler === "function",
    canResolve: typeof api.resolveHandler === "function",
    profiles: [...controller.profiles.entries()].map(([id, p]) => ({ id, label: p.label, kind: p.kind, isDefault: p.isDefault === true })),
    items: [...api.items._map.values()].map(itemDto),
  });
}

/** `TestItemCollection`: children of an item (or a controller's roots), by id. */
function collection(controller: Controller, parent: any) {
  const map = new Map<string, any>();
  const attach = (item: any) => {
    item.parent = parent;
    item._controller = controller;
  };
  return {
    _map: map,
    get size() {
      return map.size;
    },
    replace(list: readonly any[]) {
      map.clear();
      for (const item of list) {
        attach(item);
        map.set(item.id, item);
      }
      schedule(controller);
    },
    forEach(callback: (item: any, collection: unknown) => unknown, thisArg?: unknown) {
      for (const item of map.values()) callback.call(thisArg, item, this);
    },
    add(item: any) {
      attach(item);
      map.set(item.id, item);
      schedule(controller);
    },
    delete(id: string) {
      if (map.delete(id)) schedule(controller);
    },
    get: (id: string) => map.get(id),
    [Symbol.iterator]: function* () {
      for (const item of map.values()) yield [item.id, item] as [string, any];
    },
  };
}

function createTestItem(controller: Controller, id: string, label: string, uri?: Uri) {
  const handle = nextHandle++;
  const state: Record<string, unknown> = {
    id,
    uri,
    label,
    description: undefined,
    sortText: undefined,
    range: undefined,
    busy: false,
    error: undefined,
    canResolveChildren: false,
    tags: [],
    parent: undefined,
    _controller: controller,
  };
  const item: any = new Proxy(state, {
    set(target, key, value) {
      target[key as string] = value;
      if (typeof key === "string" && !key.startsWith("_") && key !== "parent") schedule(target._controller as Controller);
      return true;
    },
  });
  state.children = collection(controller, item);
  handles.set(item, handle);
  items.set(handle, item);
  return item;
}

// ---- Runs -------------------------------------------------------------------------

interface Run {
  id: number;
  name?: string;
  token: CancellationTokenSource;
}

/** Cancellation of each request the UI started, by the request object. */
const requestTokens = new WeakMap<object, CancellationTokenSource>();
const runs = new Map<number, Run>();
let nextRun = 1;

function messageDto(m: any) {
  if (!m) return undefined;
  const text = m.message instanceof MarkdownString ? m.message.value : typeof m.message === "string" ? m.message : String(m.message ?? "");
  return {
    message: text,
    expected: m.expectedOutput,
    actual: m.actualOutput,
    uri: m.location?.uri?.toString(),
    range: m.location?.range ? dto.range(m.location.range) : undefined,
  };
}

function createTestRun(controller: Controller, request: any, name?: string) {
  const id = nextRun++;
  // A run the UI asked for shares its cancellation; others (e.g. watch mode) get their own.
  const token = (request && requestTokens.get(request)) ?? new CancellationTokenSource();
  const run: Run = { id, name, token };
  runs.set(id, run);
  rpc.notify("tests/runStarted", { run: id, controller: controller.handle, name: name ?? controller.api.label });
  const state = (test: any, value: string, extra: object = {}) =>
    rpc.notify("tests/state", { run: id, item: handles.get(test), state: value, ...extra });
  const onDidDispose = new EventEmitter<void>();
  let ended = false;
  return {
    name,
    token: token.token,
    isPersisted: true,
    onDidDispose: onDidDispose.event,
    enqueued: (test: any) => state(test, "queued"),
    started: (test: any) => state(test, "running"),
    skipped: (test: any) => state(test, "skipped"),
    passed: (test: any, duration?: number) => state(test, "passed", { duration }),
    failed: (test: any, message: any, duration?: number) =>
      state(test, "failed", { duration, messages: (Array.isArray(message) ? message : [message]).map(messageDto) }),
    errored: (test: any, message: any, duration?: number) =>
      state(test, "errored", { duration, messages: (Array.isArray(message) ? message : [message]).map(messageDto) }),
    appendOutput: (output: string, _location?: unknown, test?: any) =>
      rpc.notify("tests/output", { run: id, text: output, item: test ? handles.get(test) : undefined }),
    addCoverage() {},
    end() {
      if (ended) return;
      ended = true;
      runs.delete(id);
      rpc.notify("tests/runEnded", { run: id });
      onDidDispose.fire();
    },
  };
}

// ---- Controllers ---------------------------------------------------------------------

export function createTestController(id: string, label: string) {
  const handle = nextHandle++;
  const controller: Controller = { handle, api: undefined, profiles: new Map() };
  let nextProfile = 1;
  const api: any = {
    id,
    label,
    resolveHandler: undefined,
    refreshHandler: undefined,
    createTestItem: (itemId: string, itemLabel: string, uri?: Uri) => createTestItem(controller, itemId, itemLabel, uri),
    createRunProfile(profileLabel: string, kind: TestRunProfileKind, runHandler: unknown, isDefault = false, tag?: unknown, supportsContinuousRun = false) {
      const profileId = nextProfile++;
      const onDidChangeDefault = new EventEmitter<boolean>();
      const profile: any = {
        label: profileLabel,
        kind,
        runHandler,
        isDefault,
        tag,
        supportsContinuousRun,
        configureHandler: undefined,
        loadDetailedCoverage: undefined,
        onDidChangeDefault: onDidChangeDefault.event,
        dispose() {
          controller.profiles.delete(profileId);
          schedule(controller);
        },
      };
      controller.profiles.set(profileId, profile);
      schedule(controller);
      return profile;
    },
    createTestRun: (request: unknown, name?: string) => createTestRun(controller, request, name),
    invalidateTestResults() {},
    dispose() {
      controllers.delete(handle);
      rpc.notify("tests/dispose", { handle });
    },
  };
  api.items = collection(controller, undefined);
  controller.api = api;
  controllers.set(handle, controller);
  schedule(controller);
  return api;
}

/** Calls the resolve handler with `item` (undefined: the roots), marking it busy meanwhile. */
async function resolve(controller: Controller, item: any) {
  const handler = controller.api.resolveHandler;
  if (typeof handler !== "function") return;
  try {
    await handler(item);
  } catch (e) {
    rpc.notify("log", { level: "warning", message: `Discovering tests failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export function listen() {
  rpc.onRequest("tests/resolve", async (params: { controller: number; item?: number }) => {
    const controller = controllers.get(params.controller);
    if (!controller) return null;
    const item = params.item === undefined ? undefined : items.get(params.item);
    // Resolving an item's children once is enough; it reports more through its collection.
    if (item) item.canResolveChildren = false;
    await resolve(controller, item);
    return null;
  });
  rpc.onRequest("tests/refresh", async (params: { controller: number }) => {
    const controller = controllers.get(params.controller);
    const handler = controller?.api.refreshHandler;
    if (typeof handler === "function") await handler(new CancellationTokenSource().token);
    else if (controller) await resolve(controller, undefined);
    return null;
  });
  rpc.onRequest("tests/run", async (params: { controller: number; kind: number; profile?: number; include?: number[] }) => {
    const controller = controllers.get(params.controller);
    if (!controller) throw new Error("The test controller is gone.");
    const profiles = [...controller.profiles.entries()].filter(([, p]) => p.kind === params.kind);
    const profile =
      (params.profile !== undefined ? controller.profiles.get(params.profile) : undefined) ??
      profiles.find(([, p]) => p.isDefault)?.[1] ??
      profiles[0]?.[1];
    if (!profile) {
      const what = params.kind === TestRunProfileKind.Debug ? "debug tests" : params.kind === TestRunProfileKind.Coverage ? "measure test coverage" : "run tests";
      throw new Error(`${controller.api.label} cannot ${what}.`);
    }
    const include = params.include?.map((h) => items.get(h)).filter(Boolean);
    const request = new TestRunRequest(include?.length ? include : undefined, undefined, profile);
    const token = new CancellationTokenSource();
    requestTokens.set(request, token);
    pendingRequests.add(token);
    try {
      await profile.runHandler(request, token.token);
    } finally {
      pendingRequests.delete(token);
    }
    return null;
  });
  rpc.onRequest("tests/cancel", async () => {
    // Stops everything under way: the requests the UI made and the runs they created.
    for (const token of pendingRequests) token.cancel();
    for (const run of runs.values()) run.token.cancel();
    return null;
  });
}

const pendingRequests = new Set<CancellationTokenSource>();
