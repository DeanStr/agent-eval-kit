import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { writeJson } from "./io.js";
import { groupIsRunning, terminateProcessGroup } from "./process-tree.js";

interface ProcessRegistry {
  file: string;
  groups: Set<number>;
}

const scope = new AsyncLocalStorage<ProcessRegistry>();

/** Persist worker-owned groups so its parent can drain them even after a crash. */
export function withProcessRegistry<T>(file: string, action: () => T): T {
  const registry: ProcessRegistry = { file, groups: new Set() };
  writeJson(file, []);
  return scope.run(registry, action);
}

/** Register synchronously, before the worker can handle another signal/event. */
export function trackProcessGroup(child: ChildProcess): () => void {
  const registry = scope.getStore();
  const pid = child.pid;
  if (!registry || !pid) return () => {};
  registry.groups.add(pid);
  writeJson(registry.file, [...registry.groups]);
  return () => {
    // A closed leader may still have descendants. Retain ownership until the
    // whole group has exited; the experiment parent drains any remaining groups.
    if (groupIsRunning(pid)) return;
    registry.groups.delete(pid);
    writeJson(registry.file, [...registry.groups]);
  };
}

function readProcessGroups(file: string): number[] {
  const groups: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !Array.isArray(groups) ||
    !groups.every((pid: unknown) => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0)
  )
    throw new Error(`Invalid process group registry: ${file}`);
  return groups;
}

/** Inspect registered groups without terminating workers or changing their registry. */
export function runningProcessGroups(file: string): number[] {
  return readProcessGroups(file).filter(groupIsRunning);
}

/** Call after the worker has exited, while still holding the shared resource. */
export async function drainProcessRegistry(file: string): Promise<void> {
  const groups = readProcessGroups(file);
  const results = await Promise.allSettled(groups.map((pid: number) => terminateProcessGroup(pid)));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, `Worker process cleanup failed; see ${file}`);
  writeJson(file, []);
}
