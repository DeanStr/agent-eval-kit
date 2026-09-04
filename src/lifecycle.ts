import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { shellInvocation, spawnCaptured } from "./providers/process.js";
import { terminateWindowsTree } from "./process-tree.js";
import type { EvalConfig } from "./types.js";

export interface LifecycleHandle {
  process?: ChildProcess;
  /** Fail when a managed start command has exited unexpectedly. */
  assertRunning: () => void;
  stop: () => Promise<void>;
}

async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function processGroupIsRunning(pid: number): boolean {
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

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
}

function exitStatus(child: ChildProcess): string {
  return child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
}

async function waitUntilReady(
  config: EvalConfig,
  runDir: string,
  processHandle: ChildProcess | undefined,
  processError?: () => Error | undefined,
): Promise<void> {
  const ready = config.target.ready;
  if (!ready) {
    if (!processHandle) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (processError?.()) throw new Error(`Target start command failed: ${processError()!.message}`);
    if (processHandle && !isRunning(processHandle)) {
      throw new Error(`Target start command exited before evaluation (${exitStatus(processHandle)})`);
    }
    return;
  }
  const deadline = Date.now() + ready.timeoutSeconds * 1000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (processError?.()) throw new Error(`Target start command failed: ${processError()!.message}`);
    if (processHandle && !isRunning(processHandle)) {
      throw new Error(`Target start command exited before becoming ready (${exitStatus(processHandle)})`);
    }
    try {
      if (ready.url) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const response = await fetch(ready.url, { redirect: "manual", signal: AbortSignal.timeout(Math.min(5_000, remainingMs)) });
        const readyStatus = response.status < 500;
        await response.body?.cancel().catch(() => {});
        if (readyStatus) return;
        lastError = `HTTP ${response.status}`;
      } else if (ready.command) {
        const shell = shellInvocation(ready.command);
        const check = await spawnCaptured({
          command: shell.command,
          args: shell.args,
          cwd: config.project.root,
          timeoutSeconds: Math.min(10, Math.max(0.1, (deadline - Date.now()) / 1_000)),
          stdoutFile: path.join(runDir, "lifecycle", "ready.stdout.log"),
          stderrFile: path.join(runDir, "lifecycle", "ready.stderr.log"),
        });
        if (!check.timedOut && check.exitCode === 0) return;
        lastError = check.timedOut
          ? "readiness command timed out"
          : `readiness command exited ${check.exitCode}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ready.intervalMs, remainingMs)));
    }
  }
  throw new Error(`Target did not become ready within ${ready.timeoutSeconds}s: ${lastError}`);
}

export async function startLifecycle(
  config: EvalConfig,
  runDir: string,
  options: { skipSetup?: boolean; onSetupComplete?: () => void; onReady?: () => void } = {},
): Promise<LifecycleHandle> {
  if (config.target.setup && !options.skipSetup) {
    const setup = config.target.setup;
    const shell = shellInvocation(setup.command);
    const timeoutSeconds = setup.timeoutSeconds ?? 600;
    const result = await spawnCaptured({
      command: shell.command,
      args: shell.args,
      cwd: setup.cwd ?? config.project.root,
      env: { ...process.env, ...setup.env },
      timeoutSeconds,
      stdoutFile: path.join(runDir, "lifecycle", "setup.stdout.log"),
      stderrFile: path.join(runDir, "lifecycle", "setup.stderr.log"),
    });
    if (result.timedOut) throw new Error(`Target setup command timed out after ${timeoutSeconds}s`);
    if (result.exitCode !== 0) throw new Error(`Target setup command failed with exit ${result.exitCode}`);
    options.onSetupComplete?.();
  }

  const start = config.target.start;
  if (!start) {
    await waitUntilReady(config, runDir, undefined);
    options.onReady?.();
    return { assertRunning: () => {}, stop: async () => {} };
  }
  const directory = path.join(runDir, "lifecycle");
  fs.mkdirSync(directory, { recursive: true });
  const stdout = fs.openSync(path.join(directory, "start.stdout.log"), "w");
  const stderr = fs.openSync(path.join(directory, "start.stderr.log"), "w");
  const shell = shellInvocation(start.command);
  const child = spawn(shell.command, shell.args, {
    cwd: start.cwd ?? config.project.root,
    env: { ...process.env, ...start.env },
    stdio: ["ignore", stdout, stderr],
    detached: process.platform !== "win32",
  });
  let startError: Error | undefined;
  child.once("error", (error) => { startError = error; });

  let descriptorsClosed = false;
  const stop = async () => {
    try {
      if (child.pid) {
        if (process.platform === "win32" && isRunning(child)) {
          try {
            await terminateWindowsTree(child.pid, false);
          } catch (error) {
            if (isRunning(child)) throw error;
          }
          await waitForClose(child, 5_000);
          if (isRunning(child)) {
            try {
              await terminateWindowsTree(child.pid, true);
            } catch (error) {
              if (isRunning(child)) throw error;
            }
            await waitForClose(child, 1_000);
          }
          if (isRunning(child)) {
            throw new Error(`Target start command process ${child.pid} is still running after forced termination`);
          }
        } else if (process.platform !== "win32" && processGroupIsRunning(child.pid)) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await waitForProcessGroupExit(child.pid, 5_000);
          if (processGroupIsRunning(child.pid)) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
            await waitForProcessGroupExit(child.pid, 1_000);
          }
          await waitForClose(child, 1_000);
          if (processGroupIsRunning(child.pid)) {
            throw new Error(`Target start command process group ${child.pid} is still running after forced termination`);
          }
        }
      }
    } finally {
      if (!descriptorsClosed) {
        descriptorsClosed = true;
        fs.closeSync(stdout);
        fs.closeSync(stderr);
      }
    }
  };

  try {
    await waitUntilReady(config, runDir, child, () => startError);
    options.onReady?.();
    const assertRunning = () => {
      if (startError) throw new Error(`Target start command failed during evaluation: ${startError.message}`);
      if (!isRunning(child)) {
        throw new Error(`Target start command exited during evaluation (${exitStatus(child)})`);
      }
    };
    return { process: child, assertRunning, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
