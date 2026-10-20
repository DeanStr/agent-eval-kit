import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertEvaluationPlatform } from "./platform.js";

const TERMINATION_GRACE_MS = 5_000;
const FORCED_EXIT_WAIT_MS = 1_000;
export const PROCESS_TREE_CLEANUP_MS = TERMINATION_GRACE_MS + FORCED_EXIT_WAIT_MS;

export function groupIsRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForExit(isRunning: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (isRunning() && Date.now() < deadline) {
    await delay(Math.min(50, deadline - Date.now()));
  }
}

/** Await the entire detached group, even after its original leader exits. */
export async function terminateProcessTree(
  child: ChildProcess,
  graceMilliseconds = TERMINATION_GRACE_MS,
): Promise<void> {
  const pid = child.pid;
  if (pid) await terminateProcessGroup(pid, graceMilliseconds);
}

export async function terminateProcessGroup(
  pid: number,
  graceMilliseconds = TERMINATION_GRACE_MS,
): Promise<void> {
  assertEvaluationPlatform();
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Process group PID must be a positive integer");
  if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds <= 0)
    throw new Error("Process termination grace must be a positive integer in milliseconds");
  const isRunning = () => groupIsRunning(pid);
  const send = async (force: boolean) => {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if (isRunning()) throw error;
    }
  };
  if (isRunning()) {
    await send(false);
    await waitForExit(isRunning, graceMilliseconds);
    if (isRunning()) {
      await send(true);
      await waitForExit(isRunning, FORCED_EXIT_WAIT_MS);
    }
  }
  if (isRunning()) throw new Error(`Process tree ${pid} is still running after forced termination`);
}
