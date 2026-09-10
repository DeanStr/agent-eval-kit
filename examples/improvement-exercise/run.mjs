import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
const exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code, signal) =>
    signal ? reject(new Error(`Evaluation terminated by ${signal}`)) : resolve(code),
  );
});
const created = (fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []).filter(
  (name) => !previous.has(name),
);
if (created.length > 1 || (created.length === 0 && exitCode !== 1))
  throw new Error(`Expected one new run; found ${created.length} after CLI exit ${exitCode}`);
const run = created.length ? path.join(runRoot, created[0]) : null;
const reportPath = run ? path.join(run, "report.json") : null;
const report =
  reportPath && fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : undefined;
if (!report && exitCode !== 1)
  throw new Error(`CLI exited ${exitCode} without a report; inspect ${run}`);
const entry = {
  variant,
  targetSha256,
  run,
  exitCode,
  ...(report
    ? {
        score: report.overallScorePct,
        coverage: report.overallCoveragePct,
        verdicts: Object.fromEntries(
          report.areas.flatMap((area) => area.items.map((item) => [item.id, item.verdict])),
        ),
        evaluator: report.receipt.evaluationFingerprint,
      }
    : {
        error: run
          ? "No report; inspect retained execution diagnostics"
          : "Evaluation failed before creating a run; see CLI diagnostics above",
      }),
};
fs.appendFileSync(path.join(experiment, "journal.ndjson"), `${JSON.stringify(entry)}\n`);
console.log(JSON.stringify(entry, null, 2));
process.exitCode = exitCode;
