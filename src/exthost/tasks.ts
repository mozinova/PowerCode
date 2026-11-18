//! "Tasks: Run Task" and friends: the tasks of `.vscode/tasks.json` and of
//! extensions, listed and run by the extension host (ext-host/src/tasks.ts).

import { errorMessage, fsApi } from "../lib/ipc";
import { joinPath } from "../lib/paths";
import { track } from "../state/activity";
import { notify } from "../state/notifications";
import { useWorkspace } from "../state/workspace";
import { showQuickPick } from "./dialogs";
import { ensureExtensionHost } from "./host";
import * as rpc from "./rpc";

interface TaskItem {
  id: number;
  label: string;
  source: string;
  detail?: string;
  isDefault: boolean;
}

const TASKS_TEMPLATE = `{
  // Tasks run in the terminal: "Tasks: Run Task", or Ctrl+Shift+B for the default build task.
  // See https://code.visualstudio.com/docs/editor/tasks
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "echo Building",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": []
    }
  ]
}
`;

async function run(task: TaskItem) {
  try {
    await rpc.request("tasks/run", { id: task.id });
  } catch (e) {
    notify("error", `Could not run the task '${task.label}'`, errorMessage(e));
  }
}

/** Lists the tasks (or only the build group's) and runs the one picked. */
export async function runTask(group?: "build" | "test") {
  if (!useWorkspace.getState().root || !(await ensureExtensionHost())) return;
  const tasks = await track("Fetching tasks…", () => rpc.request<TaskItem[]>("tasks/list", { group })).catch((e) => {
    notify("error", "Could not list the tasks", errorMessage(e));
    return null;
  });
  if (!tasks) return;
  // Ctrl+Shift+B runs the default build task straight away, as in VS Code.
  const preferred = group ? tasks.filter((t) => t.isDefault) : [];
  if (preferred.length === 1) return run(preferred[0]);
  if (tasks.length === 0) {
    notify("info", group ? "No build task" : "No tasks", "Add tasks to .vscode/tasks.json (Tasks: Configure Tasks) or install an extension that provides them.");
    return;
  }
  const picked = await showQuickPick({
    title: group === "build" ? "Run Build Task" : "Run Task",
    placeHolder: "Select the task to run",
    canPickMany: false,
    items: tasks.map((t) => ({ label: t.label, description: t.source === "Workspace" ? "tasks.json" : t.source, detail: t.detail })),
  });
  if (picked?.length) await run(tasks[picked[0]]);
}

export async function terminateTask() {
  if (!rpc.isRunning()) return;
  const running = await rpc.request<{ id: number; label: string }[]>("tasks/running");
  if (running.length === 0) {
    notify("info", "No task is running");
    return;
  }
  const picked =
    running.length === 1
      ? [0]
      : await showQuickPick({ title: "Terminate Task", placeHolder: "Select the task to terminate", canPickMany: false, items: running.map((t) => ({ label: t.label })) });
  if (picked?.length) await rpc.request("tasks/terminate", { id: running[picked[0]].id });
}

/** Opens `.vscode/tasks.json`, creating it with an example task when missing. */
export async function configureTasks() {
  const root = useWorkspace.getState().root;
  if (!root) return;
  const dir = joinPath(root, ".vscode");
  const path = joinPath(dir, "tasks.json");
  const exists = await fsApi.readTextFile(path).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await fsApi.createDir(dir).catch(() => {});
    await fsApi.writeTextFile(path, TASKS_TEMPLATE);
    useWorkspace.getState().filesChanged();
  }
  useWorkspace.getState().openFile(path);
}
