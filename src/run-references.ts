import fs from "node:fs";
import path from "node:path";
import { loadRunState, type RunState } from "./run/state.js";
import { didYouMean } from "./suggest.js";

export interface RunEntry {
  runId: string;
  directory: string;
  state?: RunState;
  /** Why run-state.json could not be read; such runs are listed but never selected by alias. */
  error?: string;
}

/** Which runs an alias may select for the requesting command. */
export type RunRequirement =
  | "complete"
  | "report"
  | "collection"
  | "resumable-run"
  | "resumable-collection"
  | "resumable-judging";

const requirementLabels: Record<RunRequirement, string> = {
  complete: "complete runs",
  report: "complete runs with a report",
  collection: "complete evidence collections",
  "resumable-run": "incomplete runs",
  "resumable-collection": "incomplete collections",
  "resumable-judging": "incomplete judging runs",
};

export const RUN_ALIASES = ["latest", "previous"] as const;

/** Run directories directly beneath paths.runs, oldest first. */
export function listRuns(runsDir: string): RunEntry[] {
  if (!fs.existsSync(runsDir)) return [];
  const entries: RunEntry[] = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    const directory = path.join(runsDir, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(directory, "run-state.json"))) continue;
    try {
      entries.push({ runId: entry.name, directory, state: loadRunState(directory) });
    } catch (error) {
      entries.push({
        runId: entry.name,
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries.sort(
    (left, right) =>
      (left.state?.startedAt ?? "").localeCompare(right.state?.startedAt ?? "") ||
      left.runId.localeCompare(right.runId),
  );
}

export function runSatisfies(entry: RunEntry, requirement: RunRequirement): boolean {
  const state = entry.state;
  if (!state) return false;
  switch (requirement) {
    case "complete":
      return state.status === "complete";
    case "report":
      return (
        state.status === "complete" &&
        state.mode !== "collect" &&
        fs.existsSync(path.join(entry.directory, "report.json"))
      );
    case "collection":
      return state.status === "complete" && state.mode === "collect";
    case "resumable-run":
      return state.status !== "complete" && state.mode === undefined;
    case "resumable-collection":
      return state.status !== "complete" && state.mode === "collect";
    case "resumable-judging":
      return state.status !== "complete" && state.mode === "judge";
  }
}

/**
 * Resolve a run reference: an existing path, a run ID beneath paths.runs, or
 * `latest`/`previous` among the runs that satisfy the command's requirement.
 * The runs directory is computed only when the reference is not a path.
 */
export function resolveRunReference(
  input: string,
  options: { flag: string; requirement: RunRequirement; runsDir: () => string },
): string {
  if (fs.existsSync(input)) return path.resolve(input);
  const runsDir = options.runsDir();
  const runs = listRuns(runsDir);
  if ((RUN_ALIASES as readonly string[]).includes(input)) {
    const eligible = runs.filter((entry) => runSatisfies(entry, options.requirement));
    const offset = input === "latest" ? 1 : 2;
    const selected = eligible.at(-offset);
    if (!selected)
      throw new Error(
        `--${options.flag} ${input} needs ${offset === 1 ? "at least one" : "at least two"} ${requirementLabels[options.requirement]} in ${runsDir}; found ${eligible.length}.`,
      );
    return selected.directory;
  }
  const byId = runs.find((entry) => entry.runId === input);
  if (byId) return byId.directory;
  throw new Error(
    `--${options.flag}: no run directory or run ID ${input} in ${runsDir}.${didYouMean(
      input,
      runs.map((entry) => entry.runId),
    )} Pass a directory, a run ID, latest, or previous.`,
  );
}
