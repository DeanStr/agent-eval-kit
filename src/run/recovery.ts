import fs from "node:fs";
import path from "node:path";
import { assertArtifactIntegrity } from "../integrity.js";
import { safeName, sha256 } from "../io.js";
import type { EvalSpec } from "../types.js";
import type { RunState } from "./state.js";

function indexedFileMatches(
  runDir: string,
  entry: { path: string; bytes: number; sha256: string },
): boolean {
  const file = path.join(runDir, ...entry.path.split("/"));
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const bytes = fs.readFileSync(file);
  return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
}

function removeUnsealedFiles(runDir: string, relativeRoot: string, sealedPaths: Set<string>): void {
  const absoluteRoot = path.join(runDir, ...relativeRoot.replace(/\/$/, "").split("/"));
  if (!fs.existsSync(absoluteRoot)) return;
  if (fs.lstatSync(absoluteRoot).isSymbolicLink()) {
    fs.rmSync(absoluteRoot, { force: true });
    return;
  }
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runDir, absolute).split(path.sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
        if (fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0)
          fs.rmdirSync(absolute);
      } else if (!sealedPaths.has(relative)) {
        fs.rmSync(absolute, { recursive: true, force: true });
      }
    }
  };
  visit(absoluteRoot);
}

/** Recover interrupted writes while preserving all sealed evidence and completed votes. */
export function recoverRunArtifacts(runDir: string, specs: EvalSpec[], existingState?: RunState) {
  // A process may have stopped midway through a scenario after writing new,
  // not-yet-indexed diagnostics. Verify every previously sealed artifact while
  // allowing those crash-recovery files to be replaced or sealed on resume.
  const recoverablePrefixes = [
    "lifecycle/",
    ...specs.flatMap((spec) => [
      `areas/${spec.id}/`,
      `.state/${safeName(spec.id)}/`,
      ...spec.scenarios.map((scenario) => `${scenario.id}/`),
    ]),
  ];
  const priorIndex = existingState
    ? assertArtifactIntegrity(runDir, {
        allowUnindexed: (relative) =>
          recoverablePrefixes.some((prefix) => relative.startsWith(prefix)),
        // A target mutation is sealed into run-state.json and receipt.json
        // before the next report/index transaction. If execution stops in
        // that window, the canonical receipt is expected to differ from the
        // last index and will be recomputed below before it is trusted.
        allowChangedRoles:
          existingState.status === "complete" ? [] : ["evidence", "judgement", "report", "receipt"],
      })
    : undefined;
  // Partial judge output is recoverable; completed vote journals are immutable.
  // Validate these before cleanup so corruption cannot erase a completed vote
  // and silently trigger a different model judgement on resume.
  const completedVotes =
    priorIndex?.entries.flatMap((entry) => {
      const match = entry.path.match(/^(areas\/.+\/vote-\d+\/)vote\.json$/);
      return match?.[1] === undefined ? [] : [match[1]];
    }) ?? [];
  for (const entry of priorIndex?.entries ?? []) {
    if (
      completedVotes.some((prefix) => entry.path.startsWith(prefix)) &&
      !indexedFileMatches(runDir, entry)
    )
      throw new Error(
        `Completed vote artifact changed: ${entry.path}. Restore the sealed bytes or start a new run.`,
      );
  }
  const sealedPaths = new Set(
    priorIndex?.entries
      .filter((entry) => indexedFileMatches(runDir, entry))
      .map((entry) => entry.path) ?? [],
  );
  for (const prefix of recoverablePrefixes) removeUnsealedFiles(runDir, prefix, sealedPaths);
  const prefixIsFullySealed = (prefix: string) => {
    if (!priorIndex) return false;
    const entries = priorIndex.entries.filter((entry) => entry.path.startsWith(prefix));
    return entries.every((entry) => sealedPaths.has(entry.path));
  };
  const reportEntry = priorIndex?.entries.find((entry) => entry.path === "report.json");
  const reportFile = path.join(runDir, "report.json");
  const reportIsSealed = Boolean(
    reportEntry &&
      fs.existsSync(reportFile) &&
      (() => {
        const bytes = fs.readFileSync(reportFile);
        return bytes.length === reportEntry.bytes && sha256(bytes) === reportEntry.sha256;
      })(),
  );
  return { priorIndex, sealedPaths, prefixIsFullySealed, reportIsSealed };
}
