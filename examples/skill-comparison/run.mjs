import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { capture, runCandidate, validateControls } from "./docker-runner.mjs";

const methods = path.dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const fixtureFiles = ["TASK.md", "cart.mjs", "cart.test.mjs"];

// Injection is for adapter/orchestration tests, never an alternative candidate
// provider or a source of published candidate-quality results.
export async function runComparison(
  output,
  controls,
  {
    candidate = runCandidate,
    cli = [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))],
  } = {},
) {
  validateControls(controls);
  fs.accessSync(controls.authFile, fs.constants.R_OK);
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite experiment: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const fixture = Object.fromEntries(
    fixtureFiles.map((file) => [file, fs.readFileSync(path.join(methods, "fixture", file))]),
  );
  const variants = Object.fromEntries(
    ["plain", "reviewed"].map((id) => [
      id,
      fs.readFileSync(path.join(methods, "variants", `${id}.md`), "utf8"),
    ]),
  );
  // The evaluator root/path and bytes remain fixed across every artifact.
  const project = path.join(output, "evaluation");
  fs.mkdirSync(path.join(project, "artifact"), { recursive: true });
  fs.mkdirSync(path.join(project, "evals"));
  for (const file of ["collect.mjs", "check.mjs", "docker-runner.mjs"])
    fs.copyFileSync(path.join(methods, file), path.join(project, "evals", file));
  fs.copyFileSync(path.join(methods, "spec.yaml"), path.join(project, "evals/spec.yaml"));
  write(path.join(project, "evals/runtime.json"), { image: controls.image });
  fs.writeFileSync(
    path.join(project, "evalkit.yaml"),
    YAML.stringify({
      version: 1,
      project: { name: "Controlled skill comparison", root: "." },
      target: { kind: "command" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "evals/spec.yaml", runs: "../runs" },
      scoring: { minimumCoverage: 100 },
    }),
  );
  const plan = {
    controls: { ...controls, authFile: "<credential path omitted>" },
    fixture: Object.fromEntries(
      Object.entries(fixture).map(([file, bytes]) => [file, hash(bytes)]),
    ),
    variants: Object.fromEntries(
      Object.entries(variants).map(([id, instructions]) => [
        id,
        { instructions, sha256: hash(instructions) },
      ]),
    ),
    tools:
      "Pinned container shell and file editing; no MCP or web-search tool. Model-only proxy on a dedicated internal network.",
    budget: { wallSecondsPerCandidate: controls.timeoutSeconds, cpus: 1, memory: "1g" },
    order:
      "Alternate variant order each repetition; fresh workspace and ephemeral session every attempt.",
    evaluator: Object.fromEntries(
      fs
        .readdirSync(path.join(project, "evals"))
        .map((file) => [file, hash(fs.readFileSync(path.join(project, "evals", file)))]),
    ),
  };
  write(path.join(output, "experiment.json"), plan);
  const entries = [];
  let evaluator;
  let stoppedReason;
  const evaluate = (args, directory, prefix) =>
    capture(process.execPath, [...cli, ...args], {
      cwd: project,
      directory,
      prefix,
      timeoutSeconds: 120,
    });
  attempts: for (let repetition = 1; repetition <= controls.repetitions; repetition++) {
    const ids = repetition % 2 ? Object.keys(variants) : Object.keys(variants).reverse();
    for (const variant of ids) {
      const id = `${repetition}-${variant}`;
      const directory = path.join(output, "attempts", id);
      const workspace = path.join(directory, "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      for (const [file, bytes] of Object.entries(fixture))
        fs.writeFileSync(path.join(workspace, file), bytes);
      const entry = {
        id,
        repetition,
        variant,
        startedAt: new Date().toISOString(),
        status: "started",
      };
      const started = performance.now();
      write(path.join(directory, "attempt.json"), entry);
      try {
        entry.candidate = await candidate({
          workspace,
          directory,
          controls,
          instructions: variants[variant],
        });
        if (entry.candidate.error || entry.candidate.exitCode !== 0)
          throw new Error(
            `Candidate execution error: ${entry.candidate.error ?? entry.candidate.exitCode}`,
          );
        // Candidates cannot replace tests, add dependencies, or submit symlink artifacts.
        for (const file of ["TASK.md", "cart.test.mjs"])
          if (
            !fs.lstatSync(path.join(workspace, file)).isFile() ||
            hash(fs.readFileSync(path.join(workspace, file))) !== hash(fixture[file])
          )
            throw new Error(`Candidate changed protected fixture file: ${file}`);
        const artifact = path.join(workspace, "cart.mjs");
        if (!fs.lstatSync(artifact).isFile()) throw new Error("Artifact must be a regular file");
        const bytes = fs.readFileSync(artifact);
        entry.artifactSha256 = hash(bytes);
        fs.writeFileSync(path.join(directory, "artifact.mjs"), bytes);
        fs.writeFileSync(path.join(project, "artifact/cart.mjs"), bytes);
        const runRoot = path.join(output, "runs");
        const previous = new Set(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []);
        entry.evaluation = await evaluate(
          ["run", "--config", path.join(project, "evalkit.yaml"), "--fail-under-coverage", "100"],
          directory,
          "evaluation",
        );
        const added = (fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []).filter(
          (name) => !previous.has(name),
        );
        entry.run = added.length === 1 ? path.join(runRoot, added[0]) : null;
        if (entry.evaluation.error || ![0, 2].includes(entry.evaluation.exitCode) || !entry.run)
          throw new Error(
            "AEK execution error; inspect retained evaluation diagnostics and run state",
          );
        entry.verification = await evaluate(["verify", "--run", entry.run], directory, "verify");
        if (entry.verification.exitCode !== 0 || entry.verification.error)
          throw new Error("AEK artifact verification failed");
        const report = JSON.parse(fs.readFileSync(path.join(entry.run, "report.json"), "utf8"));
        const fingerprint = report.receipt.evaluationFingerprint;
        if (evaluator && evaluator !== fingerprint)
          throw new Error("Evaluator changed during the controlled comparison");
        evaluator = fingerprint;
        entry.result = {
          score: report.overallScorePct,
          coverage: report.overallCoveragePct,
          scoreWithheld: report.scoreWithheld,
          gatesPassed: report.gates.passed,
          evaluator: fingerprint,
          verdicts: Object.fromEntries(
            report.areas.flatMap((area) => area.items.map((item) => [item.id, item.verdict])),
          ),
        };
        entry.status = "evaluated";
      } catch (error) {
        entry.status = "error";
        entry.error = error.message;
        if (error.interruptedSignal) entry.interruptedSignal = error.interruptedSignal;
      }
      const interruption =
        entry.interruptedSignal ??
        entry.candidate?.interruptedSignal ??
        entry.evaluation?.interruptedSignal ??
        entry.verification?.interruptedSignal;
      if (interruption) entry.interruptedSignal = interruption;
      entry.finishedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      write(path.join(directory, "attempt.json"), entry);
      entries.push(entry);
      fs.appendFileSync(path.join(output, "journal.ndjson"), `${JSON.stringify(entry)}\n`);
      console.log(
        `${id}: ${entry.status}${entry.error ? `: ${entry.error}` : `; score ${entry.result.score}, coverage ${entry.result.coverage}`}`,
      );
      if (interruption) {
        stoppedReason = `Experiment interrupted by ${interruption}; active container cleanup completed or its failure was retained`;
        break attempts;
      }
      if (entry.candidate?.cleanupError) {
        stoppedReason =
          "Candidate cleanup failed; stop before launching more model calls and inspect the retained container diagnostics";
        break attempts;
      }
    }
  }
  const comparisons = [];
  for (let repetition = 1; repetition <= controls.repetitions; repetition++) {
    const pair = entries.filter((entry) => entry.repetition === repetition);
    const baseline = pair.find((entry) => entry.variant === "plain");
    const candidate = pair.find((entry) => entry.variant === "reviewed");
    if (
      pair.length !== Object.keys(variants).length ||
      pair.some((entry) => entry.status !== "evaluated")
    ) {
      comparisons.push({
        repetition,
        error: "Comparison unavailable: a candidate or evaluation execution failed",
      });
      continue;
    }
    const directory = path.join(output, "comparisons", String(repetition));
    fs.mkdirSync(directory, { recursive: true });
    const comparison = { repetition, directory };
    try {
      comparison.execution = await evaluate(
        [
          "compare",
          "--baseline",
          baseline.run,
          "--candidate",
          candidate.run,
          "--output",
          directory,
        ],
        directory,
        "compare",
      );
      if (comparison.execution.exitCode !== 0 || comparison.execution.error)
        throw new Error("Comparison execution failed");
      comparison.report = JSON.parse(
        fs.readFileSync(path.join(directory, "comparison.json"), "utf8"),
      );
      if (
        comparison.report.baseline?.runId !== path.basename(baseline.run) ||
        comparison.report.candidate?.runId !== path.basename(candidate.run) ||
        comparison.report.baseline.evaluationFingerprint !== evaluator ||
        comparison.report.candidate.evaluationFingerprint !== evaluator ||
        comparison.report.compatibility?.status !== "compatible" ||
        comparison.report.compatibility.overridden !== false
      )
        throw new Error("Comparison is incompatible or does not match the evaluated runs");
    } catch (error) {
      comparison.error = error.message;
    }
    comparisons.push(comparison);
    if (comparison.execution?.interruptedSignal) {
      stoppedReason = `Experiment interrupted by ${comparison.execution.interruptedSignal} during comparison`;
      break;
    }
  }
  const summary = {
    evaluator,
    plannedAttempts: controls.repetitions * Object.keys(variants).length,
    unattempted: controls.repetitions * Object.keys(variants).length - entries.length,
    ...(stoppedReason ? { stoppedReason } : {}),
    attempts: entries,
    comparisons,
    variants: Object.fromEntries(
      Object.keys(variants).map((variant) => {
        const selected = entries.filter((entry) => entry.variant === variant);
        return [
          variant,
          {
            attempted: selected.length,
            unattempted: controls.repetitions - selected.length,
            evaluated: selected.filter((entry) => entry.status === "evaluated").length,
            errors: selected.filter((entry) => entry.status === "error").length,
            outcomes: selected.filter((entry) => entry.result).map(({ result }) => result),
            candidateDurationMs: selected.map((entry) => entry.candidate?.durationMs ?? null),
            evaluationDurationMs: selected.map((entry) => entry.evaluation?.durationMs ?? null),
            attemptDurationMs: selected.map((entry) => entry.durationMs),
            usage: selected.map((entry) => entry.candidate?.usage ?? null),
            observedCostUsd: null,
          },
        ];
      }),
    ),
    limitation:
      "Small descriptive comparison, not a general skill ranking. Repeated candidates measure variability; repeated judging alone would not. Cost is unknown when the runner supplies no monetary observations.",
  };
  write(path.join(output, "summary.json"), summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node run.mjs <new-output-directory> <controls.json>");
  const summary = await runComparison(
    path.resolve(process.argv[2]),
    JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
  );
  process.exitCode =
    summary.attempts.some((entry) => entry.status === "error") ||
    summary.comparisons.some((entry) => entry.error)
      ? 1
      : 0;
}
