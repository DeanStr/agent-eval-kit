import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { compareBenchmarkCampaigns, writeBenchmarkComparison } from "agent-eval-kit/benchmark";
import { spawnCaptured } from "../../dist/providers/process.js";
import { withCancellation } from "../../dist/cancellation.js";

const recipeSchema = z
  .object({
    version: z.literal(1),
    baseline: z.string().min(1),
    candidate: z.string().min(1),
    repetitions: z.number().int().min(2),
    timeoutSeconds: z.number().int().positive().max(86400),
    measurement: z.object({ scenarioId: z.string().min(1), fileLabel: z.string().min(1) }).strict(),
  })
  .strict();

// Candidates are already built. Project-owned collectors run their measurement
// scripts; AEK campaign/run controls reset, evidence collection, and grading.
export async function runBenchmark(
  output,
  recipeFile,
  { cli = [fileURLToPath(new URL("../../dist/cli.js", import.meta.url))] } = {},
) {
  const recipe = recipeSchema.parse(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
  const root = path.dirname(path.resolve(recipeFile));
  const configs = Object.fromEntries(
    ["baseline", "candidate"].map((side) => [side, path.resolve(root, recipe[side])]),
  );
  for (const config of Object.values(configs)) fs.accessSync(config, fs.constants.R_OK);
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: false });
  fs.writeFileSync(
    path.join(output, "recipe.json"),
    JSON.stringify({ ...recipe, ...configs }, null, 2),
  );
  const executions = {};
  let stoppedReason;
  const controller = new AbortController();
  let interruptedSignal;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    controller.abort(new Error(`Benchmark interrupted by ${signal}`));
  };
  const onInterrupt = () => interrupt("SIGINT"),
    onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    for (const side of ["baseline", "candidate"]) {
      const started = performance.now();
      try {
        const result = await withCancellation(controller.signal, () =>
          spawnCaptured({
            command: process.execPath,
            args: [
              ...cli,
              "campaign",
              "--config",
              configs[side],
              "--repetitions",
              String(recipe.repetitions),
              "--output",
              path.join(output, side),
            ],
            stdoutFile: path.join(output, `${side}.stdout`),
            stderrFile: path.join(output, `${side}.stderr`),
            cwd: root,
            timeoutSeconds: recipe.timeoutSeconds,
          }),
        );
        executions[side] = {
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: performance.now() - started,
          ...(result.timedOut ? { error: `Campaign exceeded ${recipe.timeoutSeconds}s` } : {}),
        };
      } catch (error) {
        executions[side] = { error: error.message, durationMs: performance.now() - started };
      }
      if (interruptedSignal) executions[side].interruptedSignal = interruptedSignal;
      fs.writeFileSync(path.join(output, "executions.json"), JSON.stringify(executions, null, 2));
      if (
        controller.signal.aborted ||
        executions[side].error ||
        ![0, 2].includes(executions[side].exitCode)
      ) {
        stoppedReason = `${side} campaign execution failed or was interrupted; remaining campaigns were not started`;
        break;
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  let summary;
  try {
    if (stoppedReason) throw new Error(stoppedReason);
    const comparison = compareBenchmarkCampaigns(
      path.join(output, "baseline"),
      path.join(output, "candidate"),
      recipe.measurement,
    );
    writeBenchmarkComparison(output, comparison);
    summary = { outcome: comparison.outcome, executions };
  } catch (error) {
    summary = { outcome: "execution_error", error: error.message, executions };
  }
  if (Object.values(executions).some((result) => result.error || ![0, 2].includes(result.exitCode)))
    summary.outcome = "execution_error";
  summary.unattemptedCampaigns = ["baseline", "candidate"].filter((side) => !executions[side]);
  if (stoppedReason) summary.stoppedReason = stoppedReason;
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node run.mjs <new-output-directory> <recipe.json>");
  const summary = await runBenchmark(process.argv[2], process.argv[3]);
  process.exitCode =
    summary.outcome === "execution_error" ? 1 : summary.outcome === "compared" ? 0 : 2;
}
