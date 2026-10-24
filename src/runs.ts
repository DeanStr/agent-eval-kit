import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { loadComparisonInput } from "./compare.js";
import { formatPct, formatPoints } from "./format.js";
import { loadRunState, processIsAlive, RUN_LOCK_ACQUISITION_DIRECTORY } from "./run/state.js";
import { listRuns, type RunEntry } from "./run-references.js";
import type { RunReport } from "./types.js";

export interface RunListing {
  runId: string;
  directory: string;
  status: "running" | "complete" | "failed" | "unreadable";
  mode: "run" | "collect" | "judge";
  startedAt: string | null;
  scorePct: number | null;
  coveragePct: number | null;
  scoreWithheld: boolean | null;
  gatesPassed: boolean | null;
  manualPending: number | null;
  /** Score change from the previous listed report with the same evaluator fingerprint. */
  scoreDelta: number | null;
  /** True when the evaluator changed since the previous report, so no delta is shown. */
  evaluatorChanged: boolean;
  error: string | null;
}

function readReport(entry: RunEntry): RunReport | undefined {
  const file = path.join(entry.directory, "report.json");
  if (entry.state?.status !== "complete" || entry.state.mode === "collect") return undefined;
  return loadComparisonInput(file).report;
}

/** Every run beneath paths.runs, oldest first, with score deltas between comparable reports. */
export function describeRuns(runsDir: string): RunListing[] {
  let previous: RunReport | undefined;
  return listRuns(runsDir).map((entry) => {
    let report: RunReport | undefined;
    let unreadableReport = false;
    let error = entry.error ?? entry.state?.lastError ?? null;
    try {
      report = readReport(entry);
    } catch (cause) {
      unreadableReport = true;
      error = `Unreadable report.json: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    const comparable =
      report !== undefined &&
      previous !== undefined &&
      previous.receipt.evaluationFingerprint === report.receipt.evaluationFingerprint;
    const score = (value: RunReport | undefined) =>
      value && !value.scoreWithheld ? value.overallScorePct : null;
    const delta =
      comparable && score(report) !== null && score(previous) !== null
        ? Math.round((score(report)! - score(previous)!) * 1000) / 1000
        : null;
    const listing: RunListing = {
      runId: entry.runId,
      directory: entry.directory,
      status: unreadableReport ? "unreadable" : (entry.state?.status ?? "unreadable"),
      mode: entry.state?.mode ?? "run",
      startedAt: entry.state?.startedAt ?? null,
      scorePct: report?.overallScorePct ?? null,
      coveragePct: report?.overallCoveragePct ?? null,
      scoreWithheld: report?.scoreWithheld ?? null,
      gatesPassed: report?.gates.passed ?? null,
      manualPending: report?.manualPending ?? null,
      scoreDelta: delta,
      evaluatorChanged: report !== undefined && previous !== undefined && !comparable,
      error: report ? null : error,
    };
    if (report) previous = report;
    return listing;
  });
}

const blocks = "▁▂▃▄▅▆▇█";

/** A compact score trend for reports whose scores are available. */
export function sparkline(values: Array<number | null>): string {
  return values
    .map((value) =>
      value === null ? " " : blocks[Math.min(7, Math.max(0, Math.round((value / 100) * 7)))],
    )
    .join("");
}

export function formatRunTable(runs: RunListing[]): string[] {
  const rows = runs.map((run) => [
    run.runId,
    run.mode === "run" ? run.status : `${run.status} (${run.mode})`,
    run.scorePct === null
      ? "—"
      : run.scoreWithheld
        ? `(${formatPct(run.scorePct)})`
        : formatPct(run.scorePct),
    run.scoreDelta === null
      ? run.evaluatorChanged
        ? "evaluator changed"
        : ""
      : formatPoints(run.scoreDelta).replace(/ points?$/, ""),
    run.coveragePct === null ? "—" : formatPct(run.coveragePct),
    run.gatesPassed === null ? "—" : run.gatesPassed ? "passed" : "failed",
    run.manualPending === null || run.manualPending === 0 ? "" : String(run.manualPending),
    run.error ? run.error.split("\n", 1)[0]!.slice(0, 80) : "",
  ]);
  const header = ["RUN", "STATUS", "SCORE", "Δ", "COVERAGE", "GATES", "MANUAL", "NOTE"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd(),
  );
}

function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

/** Reserve deletion with the same guard used by every run-lock acquisition. */
function pruneRun(
  entry: RunEntry,
  dryRun: boolean,
): { status: "active" | "locked" } | { status: "deleted"; bytes: number } {
  let guard = path.join(entry.directory, RUN_LOCK_ACQUISITION_DIRECTORY);
  try {
    fs.mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "locked" };
    throw error;
  }
  let staged: string | undefined;
  let bytes: number;
  try {
    // A dead owner may have left detached workers. Only explicit recovery may remove its lock.
    try {
      fs.lstatSync(path.join(entry.directory, ".run.lock"));
      return { status: "locked" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = loadRunState(entry.directory);
    if (state.status === "running" && processIsAlive(state.pid)) return { status: "active" };
    bytes = directoryBytes(entry.directory);
    if (!dryRun) {
      // Move the guard with the run before removing anything. New lock attempts at the old
      // path then fail, and the staging parent is not itself a run in history or aliases.
      const staging = path.join(path.dirname(entry.directory), ".pruning");
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      const destination = path.join(staging, crypto.randomUUID());
      fs.renameSync(entry.directory, destination);
      staged = destination;
      guard = path.join(destination, RUN_LOCK_ACQUISITION_DIRECTORY);
    }
  } finally {
    fs.rmdirSync(guard);
  }
  if (staged) {
    try {
      fs.rmSync(staged, { recursive: true });
    } catch (error) {
      throw new Error(
        `Run ${entry.runId} moved to ${staged}, but deletion failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return { status: "deleted", bytes };
}

export interface PruneResult {
  deleted: Array<{ runId: string; directory: string; bytes: number }>;
  kept: number;
  skippedActive: string[];
  skippedLocked: string[];
  bytes: number;
  dryRun: boolean;
}

/**
 * Delete runs beyond the newest `keep` and/or older than `olderThanDays`; with both, a run must
 * satisfy both. Active runs are never deleted. Promoted baselines are independent snapshots.
 */
export function pruneRuns(
  runsDir: string,
  options: { keep?: number; olderThanDays?: number; dryRun: boolean; now?: Date },
): PruneResult {
  if (options.keep === undefined && options.olderThanDays === undefined)
    throw new Error("runs prune requires --keep <n>, --older-than <days>, or both");
  const runs = listRuns(runsDir);
  const cutoff =
    options.olderThanDays === undefined
      ? undefined
      : (options.now ?? new Date()).getTime() - options.olderThanDays * 86_400_000;
  const result: PruneResult = {
    deleted: [],
    kept: 0,
    skippedActive: [],
    skippedLocked: [],
    bytes: 0,
    dryRun: options.dryRun,
  };
  runs.forEach((entry, index) => {
    const newerCount = runs.length - index - 1;
    const beyondKeep = options.keep === undefined || newerCount >= options.keep;
    const startedAt = entry.state ? Date.parse(entry.state.startedAt) : Number.NaN;
    const old =
      cutoff === undefined ||
      (Number.isFinite(startedAt)
        ? startedAt < cutoff
        : fs.statSync(entry.directory).mtimeMs < cutoff);
    if (!beyondKeep || !old) {
      result.kept++;
      return;
    }
    const pruned = pruneRun(entry, options.dryRun);
    if (pruned.status !== "deleted") {
      (pruned.status === "active" ? result.skippedActive : result.skippedLocked).push(entry.runId);
      result.kept++;
      return;
    }
    const { bytes } = pruned;
    result.deleted.push({ runId: entry.runId, directory: entry.directory, bytes });
    result.bytes += bytes;
  });
  return result;
}
