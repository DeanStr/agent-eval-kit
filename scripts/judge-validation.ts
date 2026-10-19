import { parseArgs } from "node:util";
import { withCliSignals } from "../src/cancellation.js";
import { runJudgeValidation } from "../src/judge-validation.js";

withCliSignals(async () => {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string" },
      labels: { type: "string" },
      configurations: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.dataset || !values.labels || !values.configurations || !values.output)
    throw new Error(
      "Usage: judge-validation --dataset cases.json --labels labels.json --configurations configurations.json --output NEW_DIRECTORY",
    );
  const result = await runJudgeValidation({
    datasetFile: values.dataset,
    labelsFile: values.labels,
    configurationsFile: values.configurations,
    output: values.output,
    onProgress: console.log,
  });
  console.log(JSON.stringify(result.report.results));
  console.log(`Results: ${result.output}/validation-results.json`);
  if (result.report.observations.some((item) => item.status === "execution_error"))
    process.exitCode = 1;
}).catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
});
