import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { assertEvaluationPlatform } from "./platform.js";

function groupIsRunning(pid: number): boolean {
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
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  assertEvaluationPlatform();
  const pid = child.pid;
  if (!pid) return;
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
    await waitForExit(isRunning, 5_000);
    if (isRunning()) {
      await send(true);
      await waitForExit(isRunning, 1_000);
    }
  }
  if (isRunning()) throw new Error(`Process tree ${pid} is still running after forced termination`);
}
