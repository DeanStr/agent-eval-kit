import fs from "node:fs";
import path from "node:path";
import { runBenchmarkExperiment } from "agent-eval-kit/benchmark/experiment";
import { withCliSignals } from "../../dist/cancellation.js";

const [output, recipe] = process.argv.slice(2);
if (!output || !recipe || process.argv.length !== 4)
  throw new Error("Usage: node experiment.mjs <new-output-directory> <recipe.json>");
await withCliSignals(async () => {
  const { cancellationSignal } = await import("../../dist/cancellation.js");
  const summary = await runBenchmarkExperiment(
    output,
    JSON.parse(fs.readFileSync(recipe, "utf8")),
    {
      baseDirectory: path.dirname(path.resolve(recipe)),
      signal: cancellationSignal(),
    },
  );
  process.exitCode =
    summary.outcome === "compared" ? 0 : summary.outcome === "execution_error" ? 1 : 2;
});
