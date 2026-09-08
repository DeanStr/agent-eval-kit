import { omitUndefinedDeep } from "../invariants.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { ConfigOverrides } from "../config.js";
import type { EvalSplit } from "../types.js";

export interface RunState {
  schemaVersion: 1;
  status: "running" | "complete" | "failed";
  runId: string;
  pid: number;
  configFile: string;
  startedAt: string;
  selectedAreas: string[];
  selectedScenarios?: string[];
  selectedTextCases?: string[];
  selectedSplit?: EvalSplit | "all";
  specHashes: Record<string, string>;
  inputFingerprint: string;
  configOverrides?: ConfigOverrides;
  lastError?: string;
  mode?: "collect" | "judge";
  evidenceSource?: string;
}

export const configOverridesSchema = z
  .object({
    suite: z.string().optional(),
    targetUrl: z.string().optional(),
    agentProvider: z.enum(["codex", "claude", "grok", "mock"]).optional(),
    judgeProvider: z.enum(["codex", "claude", "grok", "mock"]).optional(),
    agentModel: z.string().optional(),
    judgeModel: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    headed: z.boolean().optional(),
  })
  .strict();

const runStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["running", "complete", "failed"]),
    runId: z.string().min(1),
    pid: z.number().int().nonnegative(),
    configFile: z.string().min(1),
    startedAt: z.string().min(1),
    selectedAreas: z.array(z.string().min(1)),
    selectedTextCases: z.array(z.string().min(1)).optional(),
    selectedScenarios: z.array(z.string().min(1)).optional(),
    selectedSplit: z.enum(["development", "evaluation", "all"]).optional(),
    specHashes: z.record(z.string(), z.string()),
    inputFingerprint: z.string().min(1),
    configOverrides: configOverridesSchema.optional(),
    lastError: z.string().optional(),
    mode: z.enum(["collect", "judge"]).optional(),
    evidenceSource: z.string().optional(),
  })
  .strict();

export function loadRunState(runDir: string): RunState {
  const file = path.join(path.resolve(runDir), "run-state.json");
  if (!fs.existsSync(file)) throw new Error(`Run state does not exist: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid run state ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = runStateSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(`Invalid run state ${file}: ${z.prettifyError(result.error)}`);
  if (result.data.runId !== path.basename(path.resolve(runDir))) {
    throw new Error(`Invalid run state ${file}: runId does not match its directory`);
  }
  return omitUndefinedDeep(result.data);
}

export function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireRunLock(runDir: string): () => void {
  // Serialize acquisition, including stale-owner recovery. Without this guard,
  // a contender that read an old lock can unlink another contender's new lock.
  // Never reclaim this guard automatically: a crash during this very short
  // section requires explicit cleanup, rather than another stale-lock race.
  const guard = path.join(runDir, ".run.lock-acquisition");
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Run lock acquisition is in progress: ${guard}. Retry after the other process exits. If acquisition was interrupted, remove this empty directory only after confirming no process is acquiring this run.`,
    );
  }
  try {
    return acquireGuardedRunLock(runDir);
  } finally {
    fs.rmdirSync(guard);
  }
}

function acquireGuardedRunLock(runDir: string): () => void {
  const file = path.join(runDir, ".run.lock");
  const token = crypto.randomUUID();
  for (;;) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
      } catch {
        throw new Error(
          `Run lock is unreadable: ${file}. Refusing to modify a possibly active run.`,
        );
      }
      if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
        throw new Error(
          `Run lock has no valid owner PID: ${file}. Refusing to modify a possibly active run.`,
        );
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(`Run is locked by active process ${owner.pid}: ${runDir}`);
      }
      try {
        fs.unlinkSync(file);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`,
      );
    } catch (error) {
      fs.closeSync(descriptor);
      fs.unlinkSync(file);
      throw error;
    }
    fs.closeSync(descriptor);
    return () => {
      let active: { token?: unknown };
      try {
        active = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
      } catch {
        throw new Error(`Run lock disappeared or became unreadable while evaluating: ${file}`);
      }
      if (active.token !== token) {
        throw new Error(`Run lock ownership changed while evaluating: ${file}`);
      }
      fs.unlinkSync(file);
    };
  }
}

export async function withRunLock<T>(runDir: string, action: () => T | Promise<T>): Promise<T> {
  const release = acquireRunLock(path.resolve(runDir));
  try {
    return await action();
  } finally {
    release();
  }
}
