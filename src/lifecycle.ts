import { writeJson } from "./io.js";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { shellInvocation, spawnCaptured } from "./providers/process.js";
import { terminateProcessTree } from "./process-tree.js";
import { cancellableDelay, cancellationSignal, throwIfCancelled } from "./cancellation.js";
import type { EvalConfig } from "./types.js";
import { assertEvaluationPlatform } from "./platform.js";
import { z } from "zod";

const setupFields = {
  command: z.string().min(1),
  cwd: z.string().min(1),
  startedAt: z.iso.datetime(),
};
const setupRecordSchema = z.union([
  z.object({ ...setupFields, status: z.literal("running") }).strict(),
  z
    .object({
      ...setupFields,
      status: z.literal("complete"),
      finishedAt: z.iso.datetime(),
      exitCode: z.literal(0),
      signal: z.null(),
      timedOut: z.literal(false),
    })
    .strict(),
  z
    .object({
      ...setupFields,
      status: z.literal("failed"),
      finishedAt: z.iso.datetime(),
      error: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...setupFields,
      status: z.literal("failed"),
      finishedAt: z.iso.datetime(),
      exitCode: z.number().int().nullable(),
      signal: z.string().min(1).nullable(),
      timedOut: z.boolean(),
    })
    .strict()
    .refine(
      (record) => record.timedOut || record.exitCode !== 0 || record.signal !== null,
      "Failed setup must record a process failure",
    ),
]);

export function readSetupRecord(file: string): z.infer<typeof setupRecordSchema> {
  try {
    return setupRecordSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid setup record ${file}; refusing to retry or skip preparation. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export interface LifecycleHandle {
  process?: ChildProcess;
  /** Fail when a managed start command has exited unexpectedly. */
  assertRunning: () => void;
  stop: () => Promise<void>;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
  throwIfCancelled();
  const ready = config.target.ready;
  if (!ready) {
    if (!processHandle) return;
    await cancellableDelay(1_000);
    if (processError?.())
      throw new Error(`Target start command failed: ${processError()!.message}`);
    if (processHandle && !isRunning(processHandle)) {
      throw new Error(
        `Target start command exited before evaluation (${exitStatus(processHandle)})`,
      );
    }
    return;
  }
  const deadline = Date.now() + ready.timeoutSeconds * 1000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    throwIfCancelled();
    if (processError?.())
      throw new Error(`Target start command failed: ${processError()!.message}`);
    if (processHandle && !isRunning(processHandle)) {
      throw new Error(
        `Target start command exited before becoming ready (${exitStatus(processHandle)})`,
      );
    }
    try {
      if (ready.url) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const timeout = AbortSignal.timeout(Math.min(5_000, remainingMs));
        const signal = cancellationSignal();
        const response = await fetch(ready.url, {
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
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
      throwIfCancelled();
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await cancellableDelay(Math.min(ready.intervalMs, remainingMs));
    }
  }
  throw new Error(`Target did not become ready within ${ready.timeoutSeconds}s: ${lastError}`);
}

export async function startLifecycle(
  config: EvalConfig,
  runDir: string,
  options: { skipSetup?: boolean; onSetupComplete?: () => void; onReady?: () => void } = {},
): Promise<LifecycleHandle> {
  assertEvaluationPlatform();
  throwIfCancelled();
  const endpoint = config.target.url ?? config.target.ready?.url;
  let reuseExternal = false;
  if (config.target.start && endpoint) {
    const url = new URL(endpoint);
    const occupied = await new Promise<boolean>((resolve, reject) => {
      const socket = net.connect({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      });
      socket.setTimeout(2000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve(false);
        else reject(new Error(`Cannot verify target endpoint availability: ${error.message}`));
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("Target endpoint availability probe timed out"));
      });
    });
    if (occupied && config.target.allowExternalServer !== true) {
      throw new Error(
        `Target endpoint ${url.origin} is already in use. Stop the existing server or explicitly set target.allowExternalServer: true to reuse it.`,
      );
    }
    reuseExternal = occupied;
  }
  if (config.target.setup && !options.skipSetup) {
    const setup = config.target.setup;
    const shell = shellInvocation(setup.command);
    const timeoutSeconds = setup.timeoutSeconds ?? 600;
    const preparationFile = path.join(runDir, "lifecycle", "setup.json");
    const preparation = {
      command: setup.command,
      cwd: setup.cwd ?? config.project.root,
      startedAt: new Date().toISOString(),
    };
    writeJson(preparationFile, { ...preparation, status: "running" });
    let result: Awaited<ReturnType<typeof spawnCaptured>>;
    try {
      result = await spawnCaptured({
        command: shell.command,
        args: shell.args,
        cwd: setup.cwd ?? config.project.root,
        env: {
          ...process.env,
          ...setup.env,
          AEK_PROJECT_ROOT: config.project.root,
          AEK_RUN_DIR: runDir,
        },
        timeoutSeconds,
        stdoutFile: path.join(runDir, "lifecycle", "setup.stdout.log"),
        stderrFile: path.join(runDir, "lifecycle", "setup.stderr.log"),
      });
    } catch (error) {
      writeJson(preparationFile, {
        ...preparation,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    writeJson(preparationFile, {
      ...preparation,
      status: !result.timedOut && result.exitCode === 0 ? "complete" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    });
    if (result.timedOut) throw new Error(`Target setup command timed out after ${timeoutSeconds}s`);
    if (result.exitCode !== 0)
      throw new Error(`Target setup command failed with exit ${result.exitCode}`);
    options.onSetupComplete?.();
  }

  const start = reuseExternal ? undefined : config.target.start;
  if (!start) {
    await waitUntilReady(config, runDir, undefined);
    options.onReady?.();
    return { assertRunning: throwIfCancelled, stop: async () => {} };
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
    detached: true,
  });
  let startError: Error | undefined;
  child.once("error", (error) => {
    startError = error;
  });

  const signal = cancellationSignal();
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= terminateProcessTree(child).finally(() => {
      signal?.removeEventListener("abort", onAbort);
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }));
  // The runner also awaits stop(), so cleanup errors remain observable.
  const onAbort = () => {
    void stop().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await waitUntilReady(config, runDir, child, () => startError);
    options.onReady?.();
    const assertRunning = () => {
      throwIfCancelled();
      if (startError)
        throw new Error(`Target start command failed during evaluation: ${startError.message}`);
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
