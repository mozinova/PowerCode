//! Extensions' tests as the UI knows them: each controller's tree (sent whole by
//! the host when it changes, see ext-host/src/testing.ts), and the latest result
//! of every test. Run output goes to the "Test Results" output channel.

import { create } from "zustand";
import { errorMessage } from "../lib/ipc";
import { notify } from "../state/notifications";
import * as rpc from "./rpc";
import { appendOutput, useExtensionHost } from "./state";

export interface RangeDto {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface TestNode {
  handle: number;
  id: string;
  label: string;
  description?: string;
  sortText?: string;
  uri?: string;
  range?: RangeDto;
  busy: boolean;
  error?: string;
  canResolveChildren: boolean;
  children: TestNode[];
}

export interface TestProfile {
  id: number;
  label: string;
  /** `TestRunProfileKind`: 1 run, 2 debug, 3 coverage. */
  kind: number;
  isDefault: boolean;
}

export interface TestController {
  handle: number;
  id: string;
  label: string;
  canRefresh: boolean;
  canResolve: boolean;
  profiles: TestProfile[];
  items: TestNode[];
}

export type TestState = "queued" | "running" | "passed" | "failed" | "errored" | "skipped";

export interface TestMessage {
  message: string;
  expected?: string;
  actual?: string;
  uri?: string;
  range?: RangeDto;
}

export interface TestResult {
  state: TestState;
  duration?: number;
  messages?: TestMessage[];
}

interface TestingState {
  controllers: TestController[];
  /** Latest result of each test, by item handle. */
  results: Record<number, TestResult>;
  /** Runs under way. */
  running: number;
}

export const useTesting = create<TestingState>(() => ({ controllers: [], results: {}, running: 0 }));

export const RUN = 1;
export const DEBUG = 2;

const OUTPUT_ID = "test-results";

function ensureOutput() {
  useExtensionHost.setState(({ outputs }) =>
    outputs.some((o) => o.id === OUTPUT_ID) ? {} : { outputs: [...outputs, { id: OUTPUT_ID, name: "Test Results", text: "" }] },
  );
}

/** Runs (or debugs) `items` of a controller, or all its tests. */
export async function runTests(controller: number, kind: number, items?: number[]) {
  try {
    await rpc.request("tests/run", { controller, kind, include: items });
  } catch (e) {
    notify("error", kind === DEBUG ? "Could not debug the tests" : "Could not run the tests", errorMessage(e));
  }
}

/** Every controller's tests that can run (or be debugged). */
export function runAllTests(kind: number) {
  const { controllers } = useTesting.getState();
  return Promise.all(controllers.filter((c) => c.profiles.some((p) => p.kind === kind)).map((c) => runTests(c.handle, kind)));
}

export const cancelTests = () => rpc.request("tests/cancel").catch(() => {});

/** Discovers a controller's tests (`item` undefined: the top level), or an item's children. */
export const resolveTests = (controller: number, item?: number) => rpc.request("tests/resolve", { controller, item }).catch(() => {});

/** Controllers whose top-level tests were asked for: discovery runs once per controller. */
const discovered = new Set<number>();

export function discoverTests(controller: number) {
  if (discovered.has(controller)) return;
  discovered.add(controller);
  void resolveTests(controller);
}

export const refreshTests = (controller: number) => rpc.request("tests/refresh", { controller }).catch(() => {});

export function clearTestResults() {
  useTesting.setState({ results: {} });
}

export function registerTestingHandlers(onNotification: (method: string, handler: (params: any) => void) => void) {
  onNotification("tests/controller", (controller: TestController) =>
    useTesting.setState(({ controllers }) => {
      const index = controllers.findIndex((c) => c.handle === controller.handle);
      return { controllers: index < 0 ? [...controllers, controller] : controllers.map((c, i) => (i === index ? controller : c)) };
    }),
  );
  onNotification("tests/dispose", ({ handle }) =>
    useTesting.setState(({ controllers }) => ({ controllers: controllers.filter((c) => c.handle !== handle) })),
  );
  onNotification("tests/runStarted", ({ name }) => {
    ensureOutput();
    appendOutput(OUTPUT_ID, `\n--- ${name} (${new Date().toLocaleTimeString()}) ---\n`);
    useTesting.setState(({ running }) => ({ running: running + 1 }));
  });
  onNotification("tests/runEnded", () => useTesting.setState(({ running }) => ({ running: Math.max(0, running - 1) })));
  onNotification("tests/state", ({ item, state, duration, messages }) => {
    if (item === undefined) return;
    useTesting.setState(({ results }) => ({ results: { ...results, [item]: { state, duration, messages } } }));
  });
  onNotification("tests/output", ({ text }) => {
    ensureOutput();
    // Test output uses terminal line endings.
    appendOutput(OUTPUT_ID, String(text).replace(/\r\n/g, "\n"));
  });
}

export function resetTesting() {
  discovered.clear();
  useTesting.setState({ controllers: [], results: {}, running: 0 });
}

// ---- Tree helpers ---------------------------------------------------------------------

const WORST: TestState[] = ["errored", "failed", "running", "queued", "passed", "skipped"];

/** The state a parent shows: its own result, or the worst among its tests'. */
export function aggregateState(node: TestNode, results: Record<number, TestResult>): TestState | undefined {
  const own = results[node.handle]?.state;
  const states = node.children.map((c) => aggregateState(c, results)).filter((s): s is TestState => s !== undefined);
  if (own) states.push(own);
  if (states.length === 0) return undefined;
  return WORST.find((s) => states.includes(s));
}

export function countResults(controllers: TestController[], results: Record<number, TestResult>) {
  let passed = 0;
  let failed = 0;
  let total = 0;
  const visit = (node: TestNode) => {
    if (node.children.length === 0) {
      total++;
      const state = results[node.handle]?.state;
      if (state === "passed") passed++;
      if (state === "failed" || state === "errored") failed++;
    }
    node.children.forEach(visit);
  };
  controllers.forEach((c) => c.items.forEach(visit));
  return { passed, failed, total };
}
