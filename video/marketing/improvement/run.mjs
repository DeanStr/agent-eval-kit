import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertEvaluatedSnapshot, copyTarget, hashTarget } from "./snapshot.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [sessionArg, label, ...words] = process.argv.slice(2);
if (!sessionArg || !/^[-a-z0-9]+$/.test(label ?? "") || !words.length)
  throw Error("Usage: run.mjs <session> <label> <change rationale>");
const session = path.resolve(sessionArg),
  project = path.join(session, "project"),
  runs = path.join(session, "runs");
const origin = JSON.parse(fs.readFileSync(path.join(session, "origin.json"), "utf8"));
if (typeof origin.target !== "string") throw Error("Session origin does not name its target.");
const before = new Set(fs.existsSync(runs) ? fs.readdirSync(runs) : []);
const target = path.join(project, origin.target);
const snapshot = path.join(session, label + path.extname(origin.target));
// Snapshot before evaluating; an existing label is never overwritten.
copyTarget(target, snapshot);
const sha256 = hashTarget(snapshot);
const start = new Date().toISOString();
const command = spawnSync(
  process.execPath,
  [
    path.join(root, "dist/cli.js"),
    "run",
    "--config",
    path.join(project, "evalkit.yaml"),
    "--fail-under-coverage",
    "100",
  ],
  { cwd: root, encoding: "utf8", timeout: 420000 },
);
process.stdout.write(command.stdout ?? "");
process.stderr.write(command.stderr ?? "");
const added = (fs.existsSync(runs) ? fs.readdirSync(runs) : []).filter((x) => !before.has(x));
const run = added.length === 1 ? path.join(runs, added[0]) : null;
let report;
let executionError = command.error?.message;
if (!executionError && ![0, 2].includes(command.status))
  executionError = `Evaluation CLI exited ${command.status}; inspect retained diagnostics.`;
if (added.length !== 1) executionError = `Expected one new run; found ${added.length}.`;
try {
  if (run && fs.existsSync(path.join(run, "report.json"))) {
    report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    if (!report.receipt?.evaluationFingerprint || !Array.isArray(report.areas))
      throw Error("Report is missing evaluator provenance or criterion results.");
    assertEvaluatedSnapshot(origin.kind, snapshot, sha256, report);
  } else if (!executionError) executionError = "Evaluation produced no report.";
} catch (error) {
  executionError = `Invalid report: ${error.message}`;
}
const entry = {
  label,
  start,
  rationale: words.join(" "),
  snapshot: path.relative(root, snapshot),
  sha256,
  run: run ? path.relative(root, run) : null,
  exitCode: command.status,
  executionError: executionError ?? null,
  ...(report && !executionError
    ? {
        score: report.overallScorePct,
        coverage: report.overallCoveragePct,
        gates: report.gates.passed,
        fingerprint: report.receipt.evaluationFingerprint,
        items: report.areas.flatMap((a) =>
          a.items.map((i) => ({ id: i.id, verdict: i.verdict, reasoning: i.reasoning })),
        ),
      }
    : {}),
};
fs.appendFileSync(path.join(session, "journal.ndjson"), JSON.stringify(entry) + "\n");
console.log(JSON.stringify(entry, null, 2));
if (executionError)
  throw Error(
    "Evaluation execution failed; retained attempt in journal. Inspect diagnostics before continuing.",
  );
process.exitCode = command.status;
