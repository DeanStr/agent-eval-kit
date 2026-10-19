import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { capture } from "./docker-runner.mjs";
import { hash, hashes, install, loadDefinition, readTree } from "./definition.mjs";
import { validateEvaluator } from "./validate.mjs";
import { aggregateAreaMeasurements, belowPercentageThreshold } from "../../dist/score-slice.js";

const methods = path.dirname(fileURLToPath(import.meta.url));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

// Injection is for adapter/orchestration tests, never an alternative candidate
// provider or a source of published candidate-quality results.
export async function runComparison(
  output,
  controls,
  {
    candidate,
    definition = path.join(methods, "experiment.json"),
    cli = [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))],
  } = {},
) {
  if (!controls || typeof controls !== "object" || Array.isArray(controls))
    throw new Error("Controls must be a JSON object");
  output = path.resolve(output);
  const experiment = loadDefinition(definition);
  const adapter = await import(pathToFileURL(experiment.runner).href);
  if (
    typeof adapter.validateControls !== "function" ||
    typeof adapter.runCandidate !== "function" ||
    typeof adapter.publicControls !== "function"
  )
    throw new Error("Runner must export validateControls, publicControls, and runCandidate");
  adapter.validateControls(controls);
  const publicValues = adapter.publicControls(controls);
  if (!publicValues || typeof publicValues !== "object" || Array.isArray(publicValues))
    throw new Error(
      "Runner publicControls must return a JSON object describing the nonsecret execution controls",
    );
  for (const task of experiment.tasks)
    for (const [file, keys] of Object.entries(task.evaluation.controlFiles)) {
      for (const key of keys)
        if (!Object.hasOwn(publicValues, key))
          throw new Error(`Evaluator control file requests a nonpublic control: ${key}`);
      task.evaluationFiles[file] = {
        bytes: Buffer.from(
          JSON.stringify(Object.fromEntries(keys.map((key) => [key, publicValues[key]]))),
        ),
        mode: 0o644,
      };
    }
  if (!Number.isInteger(controls.repetitions) || controls.repetitions < 2)
    throw new Error("Use at least two fresh candidate repetitions per variant");
  candidate ??= adapter.runCandidate;
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite experiment: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const { variants, tasks } = experiment;
  const projects = {};
  const plan = {
    name: experiment.name,
    controls: publicValues,
    runner: { path: experiment.runner, sha256: hash(fs.readFileSync(experiment.runner)) },
    variants: Object.fromEntries(
      Object.entries(variants).map(([id, instructions]) => [
        id,
        { instructions, sha256: hash(instructions) },
      ]),
    ),
    baseline: experiment.baseline,
    order:
      "Alternate variant order each repetition; fresh workspace and runner session every attempt.",
    tasks: {},
  };
  // Freeze project-owned definitions before any candidate runs. Only the declared
  // task/starting files cross the candidate boundary; evaluator inputs stay here.
  for (const task of tasks) {
    const project = path.join(output, "evaluation", task.id);
    projects[task.id] = project;
    install(project, task.evaluationFiles);
    const config = YAML.parse(task.config.toString("utf8"));
    config.project = { ...config.project, root: "." };
    config.paths = { ...config.paths, runs: path.join(output, "runs", task.id) };
    fs.writeFileSync(path.join(project, "evalkit.yaml"), YAML.stringify(config));
    install(path.join(output, "inputs", task.id), task.startingState);
    plan.tasks[task.id] = {
      startingState: hashes(task.startingState),
      protected: task.protected,
      outputs: task.outputs,
      evaluator: hashes({
        ...task.evaluationFiles,
        "evalkit.yaml": {
          bytes: fs.readFileSync(path.join(project, "evalkit.yaml")),
          mode: fs.statSync(path.join(project, "evalkit.yaml")).mode & 0o777,
        },
      }),
    };
  }
  write(path.join(output, "experiment.json"), plan);
  const assertEvaluator = (task) => {
    for (const [file, expected] of Object.entries(plan.tasks[task.id].evaluator)) {
      try {
        const target = path.join(projects[task.id], file);
        if (
          hash(fs.readFileSync(target)) === expected.sha256 &&
          (fs.statSync(target).mode & 0o777) === expected.mode
        )
          continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      throw Object.assign(
        new Error(`Evaluator changed during the controlled comparison: ${file}`),
        { code: "AEK_EVALUATOR_CHANGED" },
      );
    }
  };
  const entries = [];
  const evaluators = {};
  let stoppedReason;
  const evaluate = (project, timeoutSeconds, args, directory, prefix) =>
    capture(process.execPath, [...cli, ...args], {
      cwd: project,
      directory,
      prefix,
      timeoutSeconds,
    });
  // Validate every fixed evaluator before spending any candidate executions.
  // Subject artifacts are deliberately absent until candidates submit them.
  for (const task of tasks) {
    const project = projects[task.id];
    const started = performance.now();
    try {
      const validation = await validateEvaluator(path.join(project, "evalkit.yaml"));
      write(path.join(project, "validation.json"), {
        exitCode: 0,
        durationMs: performance.now() - started,
        ...validation,
      });
    } catch (error) {
      write(path.join(project, "validation.json"), {
        exitCode: 1,
        durationMs: performance.now() - started,
        error: error.message,
      });
      fs.writeFileSync(path.join(project, "validation.stderr"), `${error.stack}\n`);
      throw new Error(
        `Invalid evaluator for task ${task.id}: ${error.message}; inspect ${path.join(project, "validation.stderr")}`,
        { cause: error },
      );
    }
    assertEvaluator(task);
  }
  attempts: for (const task of tasks) {
    const project = projects[task.id];
    const fixture = task.startingState;
    const execute = (args, directory, prefix) =>
      evaluate(project, task.evaluation.timeoutSeconds, args, directory, prefix);
    for (let repetition = 1; repetition <= controls.repetitions; repetition++) {
      const ids = repetition % 2 ? Object.keys(variants) : Object.keys(variants).reverse();
      for (const variant of ids) {
        const id = `${tasks.length > 1 ? `${task.id}/` : ""}${repetition}-${variant}`;
        const directory = path.join(output, "attempts", id);
        const workspace = path.join(directory, "workspace");
        fs.mkdirSync(workspace, { recursive: true });
        install(workspace, fixture);
        const entry = {
          id,
          repetition,
          task: task.id,
          variant,
          candidateIdentity: hash(
            JSON.stringify({
              runner: plan.runner.sha256,
              controls: plan.controls,
              variant: plan.variants[variant].sha256,
              task: plan.tasks[task.id].startingState,
            }),
          ),
          startedAt: new Date().toISOString(),
          status: "started",
        };
        const started = performance.now();
        write(path.join(directory, "attempt.json"), entry);
        try {
          assertEvaluator(task);
          entry.candidate = await candidate({
            workspace,
            directory,
            controls,
            instructions: variants[variant],
          });
          if (
            !entry.candidate ||
            (!Number.isInteger(entry.candidate.exitCode) && entry.candidate.exitCode !== null) ||
            !Number.isFinite(entry.candidate.durationMs) ||
            entry.candidate.durationMs < 0
          )
            throw new Error(
              "Runner must return an integer or null exitCode and a finite nonnegative durationMs; inspect retained invocation diagnostics",
            );
          if (
            entry.candidate.error ||
            entry.candidate.cleanupError ||
            entry.candidate.interruptedSignal ||
            entry.candidate.exitCode !== 0
          )
            throw new Error(
              `Candidate execution error: ${entry.candidate.error ?? entry.candidate.cleanupError ?? entry.candidate.interruptedSignal ?? entry.candidate.exitCode}`,
            );
          assertEvaluator(task);
          for (const file of task.protected) {
            const actual = hashes(readTree(workspace, file));
            const expected = hashes(
              Object.fromEntries(
                Object.entries(fixture).filter(
                  ([name]) => name === file || name.startsWith(`${file}/`),
                ),
              ),
            );
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              throw new Error(`Candidate changed protected fixture file: ${file}`);
          }
          entry.artifacts = {};
          // Remove the previous submission, including files absent this time.
          for (const destination of Object.values(task.outputs))
            fs.rmSync(path.join(project, destination), { recursive: true, force: true });
          for (const [source, destination] of Object.entries(task.outputs)) {
            const submitted = readTree(workspace, source);
            const retained = Object.fromEntries(
              Object.entries(submitted).map(([file, bytes]) => [
                destination + file.slice(source.length),
                bytes,
              ]),
            );
            install(path.join(directory, "artifacts"), retained);
            install(project, retained);
            Object.assign(entry.artifacts, hashes(retained));
          }
          const runRoot = path.join(output, "runs", task.id);
          const previous = new Set(fs.existsSync(runRoot) ? fs.readdirSync(runRoot) : []);
          entry.evaluation = await execute(
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
          entry.verification = await execute(["verify", "--run", entry.run], directory, "verify");
          if (entry.verification.exitCode !== 0 || entry.verification.error)
            throw new Error("AEK artifact verification failed");
          const report = JSON.parse(fs.readFileSync(path.join(entry.run, "report.json"), "utf8"));
          assertEvaluator(task);
          const fingerprint = report.receipt.evaluationFingerprint;
          if (Object.hasOwn(evaluators, task.id) && evaluators[task.id] !== fingerprint)
            throw new Error("Evaluator changed during the controlled comparison");
          evaluators[task.id] = fingerprint;
          entry.result = {
            score: report.scoreWithheld ? null : report.overallScorePct,
            coverage: report.overallCoveragePct,
            scoreWithheld: report.scoreWithheld,
            gatesPassed: report.gates.passed,
            evaluator: fingerprint,
            verdicts: Object.fromEntries(
              report.areas.flatMap((area) =>
                area.items.map((item) => [
                  item.id,
                  area.unproven.includes(item.id) ? "cannot_judge" : item.verdict,
                ]),
              ),
            ),
          };
          entry.outcome =
            report.areas.some((area) => area.gates.some((gate) => gate.status === "failed")) ||
            report.areas.some((area) =>
              area.items.some(
                (item) =>
                  !area.unproven.includes(item.id) &&
                  ["fail", "partial", "not_found"].includes(item.verdict),
              ),
            )
              ? "requirement_failure"
              : report.scoreWithheld ||
                  belowPercentageThreshold(
                    aggregateAreaMeasurements(report.areas).coveragePct,
                    100,
                  ) ||
                  !report.gates.passed
                ? "inconclusive"
                : "pass";
          entry.status = "evaluated";
        } catch (error) {
          delete entry.result;
          entry.status = "error";
          entry.outcome = "execution_error";
          entry.error = error.message;
          if (error.code) entry.errorCode = error.code;
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
        if (entry.errorCode === "AEK_EVALUATOR_CHANGED") {
          stoppedReason =
            "Evaluator changed; restore the declared methods before starting a new experiment";
          break attempts;
        }
      }
    }
  }
  const comparisons = [];
  comparisonsLoop: for (const task of tasks) {
    const project = projects[task.id];
    const execute = (args, directory, prefix) =>
      evaluate(project, task.evaluation.timeoutSeconds, args, directory, prefix);
    for (let repetition = 1; repetition <= controls.repetitions; repetition++) {
      const pair = entries.filter(
        (entry) => entry.task === task.id && entry.repetition === repetition,
      );
      const baseline = pair.find((entry) => entry.variant === experiment.baseline);
      for (const variant of Object.keys(variants).filter((id) => id !== experiment.baseline)) {
        const candidate = pair.find((entry) => entry.variant === variant);
        if (
          !baseline ||
          !candidate ||
          baseline.status !== "evaluated" ||
          candidate.status !== "evaluated"
        ) {
          comparisons.push({
            task: task.id,
            repetition,
            baseline: experiment.baseline,
            candidate: variant,
            outcome:
              baseline?.status === "error" || candidate?.status === "error"
                ? "execution_error"
                : "inconclusive",
            error:
              "Comparison unavailable: a candidate or evaluation execution failed or was unattempted",
          });
          continue;
        }
        const directory = path.join(output, "comparisons", task.id, `${repetition}-${variant}`);
        fs.mkdirSync(directory, { recursive: true });
        const comparison = {
          task: task.id,
          repetition,
          baseline: experiment.baseline,
          candidate: variant,
          directory,
        };
        try {
          comparison.execution = await execute(
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
            comparison.report.baseline.evaluationFingerprint !== evaluators[task.id] ||
            comparison.report.candidate.evaluationFingerprint !== evaluators[task.id] ||
            comparison.report.compatibility.overridden !== false
          )
            throw new Error("Comparison is incompatible or does not match the evaluated runs");
          comparison.outcome =
            comparison.report.compatibility.status !== "compatible"
              ? "inconclusive"
              : [baseline.outcome, candidate.outcome].includes("requirement_failure")
                ? "requirement_failure"
                : [baseline.outcome, candidate.outcome].includes("inconclusive")
                  ? "inconclusive"
                  : "compared";
        } catch (error) {
          comparison.outcome = "execution_error";
          comparison.error = error.message;
        }
        comparisons.push(comparison);
        if (comparison.execution?.interruptedSignal) {
          stoppedReason = `Experiment interrupted by ${comparison.execution.interruptedSignal} during comparison`;
          break comparisonsLoop;
        }
      }
    }
  }
  const summary = {
    evaluators,
    plannedAttempts: tasks.length * controls.repetitions * Object.keys(variants).length,
    unattempted:
      tasks.length * controls.repetitions * Object.keys(variants).length - entries.length,
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
            unattempted: tasks.length * controls.repetitions - selected.length,
            evaluated: selected.filter((entry) => entry.status === "evaluated").length,
            errors: selected.filter((entry) => entry.status === "error").length,
            outcomeCounts: Object.fromEntries(
              ["pass", "requirement_failure", "inconclusive", "execution_error"].map((outcome) => [
                outcome,
                selected.filter((entry) => entry.outcome === outcome).length,
              ]),
            ),
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
      "Descriptive comparison, not a general skill ranking. Repeated candidates measure variability; repeated judging alone would not. Cost is unknown when the runner supplies no monetary observations.",
  };
  write(path.join(output, "summary.json"), summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (![4, 5].includes(process.argv.length))
    throw new Error("Usage: node run.mjs <new-output-directory> <controls.json> [experiment.json]");
  const summary = await runComparison(
    path.resolve(process.argv[2]),
    JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
    process.argv[4] ? { definition: path.resolve(process.argv[4]) } : {},
  );
  process.exitCode =
    summary.attempts.some((entry) => entry.status === "error") ||
    summary.comparisons.some((entry) => entry.error)
      ? 1
      : summary.unattempted ||
          summary.attempts.some((entry) => entry.outcome !== "pass") ||
          summary.comparisons.some((entry) => entry.outcome !== "compared")
        ? 2
        : 0;
}
