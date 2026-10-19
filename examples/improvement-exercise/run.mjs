import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const experiment = path.resolve(process.argv[2] ?? "");
const variant = process.argv[3];
if (!process.argv[2] || !/^[a-z][a-z0-9-]*$/.test(variant ?? "")) {
  throw new Error("Usage: node run.mjs <existing-experiment> <variant|current>");
}
const project = path.join(experiment, "project");
const target = path.join(project, "site/index.html");
if (variant !== "current")
  fs.copyFileSync(path.join(experiment, "variants", `${variant}.html`), target);
const runRoot = path.join(experiment, "runs");
const previous = new Set(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []);
const targetSha256 = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
const startedAt = new Date().toISOString();
const started = performance.now();
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "src/cli.ts",
    "run",
    "--config",
    path.join(project, "evalkit.yaml"),
    "--fail-under-coverage",
    "100",
  ],
  { cwd: repository, stdio: "inherit" },
);
let executionError;
let terminationSignal;
const cliExitCode = await new Promise((resolve) => {
  child.on("error", (error) => {
    executionError = error.message;
    resolve(1);
  });
  child.on("close", (code, signal) => {
    terminationSignal = signal;
    if (signal) executionError = `Evaluation terminated by ${signal}`;
    resolve(code);
  });
});
let exitCode = [0, 2].includes(cliExitCode) ? cliExitCode : 1;
if (cliExitCode !== 1 && exitCode === 1 && !executionError)
  executionError = `Unexpected evaluation CLI exit code: ${cliExitCode}`;
const created = (fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []).filter(
  (name) => !previous.has(name),
);
if (created.length > 1 || (created.length === 0 && exitCode !== 1)) {
  executionError = `Expected one new run; found ${created.length} after CLI exit ${exitCode}`;
  exitCode = 1;
}
const run = created.length === 1 ? path.join(runRoot, created[0]) : null;
const reportPath = run ? path.join(run, "report.json") : null;
let report;
try {
  if (reportPath && fs.existsSync(reportPath)) {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    if (
      !parsed.receipt?.evaluationFingerprint ||
      typeof parsed.gates?.passed !== "boolean" ||
      typeof parsed.scoreWithheld !== "boolean" ||
      !Number.isFinite(parsed.overallCoveragePct) ||
      parsed.overallCoveragePct < 0 ||
      parsed.overallCoveragePct > 100 ||
      !(
        parsed.overallScorePct === null ||
        (Number.isFinite(parsed.overallScorePct) &&
          parsed.overallScorePct >= 0 &&
          parsed.overallScorePct <= 100)
      ) ||
      !Array.isArray(parsed.areas) ||
      parsed.areas.some(
        (area) =>
          !Array.isArray(area?.items) ||
          area.items.some(
            (item) =>
              typeof item?.id !== "string" ||
              !item.id ||
              !["pass", "partial", "fail", "not_found", "cannot_judge"].includes(item.verdict),
          ),
      )
    )
      throw new Error("Missing report provenance, coverage, gates, or item results");
    report = parsed;
  }
} catch (error) {
  executionError = `Invalid report: ${error.message}`;
  exitCode = 1;
}
if (!report && exitCode !== 1) {
  executionError = `CLI exited ${exitCode} without a report; inspect ${run}`;
  exitCode = 1;
}
const entry = {
  attemptId: randomUUID(),
  startedAt,
  durationMs: Math.round(performance.now() - started),
  variant,
  targetSha256,
  run,
  exitCode,
  cliExitCode,
  ...(terminationSignal ? { signal: terminationSignal } : {}),
  ...(report?.receipt ? { evaluator: report.receipt.evaluationFingerprint } : {}),
  ...(created.length > 1 ? { createdRuns: created.map((name) => path.join(runRoot, name)) } : {}),
  ...(report && exitCode !== 1
    ? {
        score: report.overallScorePct,
        scoreWithheld: report.scoreWithheld,
        coverage: report.overallCoveragePct,
        verdicts: Object.fromEntries(
          report.areas.flatMap((area) => area.items.map((item) => [item.id, item.verdict])),
        ),
        gatesPassed: report.gates.passed,
      }
    : {
        error:
          executionError ??
          (run
            ? "Evaluation execution failed; inspect retained diagnostics"
            : "Evaluation failed before creating a run; see CLI diagnostics above"),
      }),
};
fs.appendFileSync(path.join(experiment, "journal.ndjson"), `${JSON.stringify(entry)}\n`);
console.log(JSON.stringify(entry, null, 2));
process.exitCode = exitCode;
