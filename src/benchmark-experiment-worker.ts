// One fresh process per preparation/visit keeps project .env loading and every
// lifecycle/provider/collector subprocess in that candidate's environment.
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { loadFixtures, loadSpecs, selectSpecs } from "./specs.js";
import { buildRunReceipt } from "./receipts.js";
import { runEvaluation } from "./runner.js";
import { withCliSignals } from "./cancellation.js";
import { loadBenchmarkRun } from "./benchmark.js";
import { campaignRunRecord } from "./campaign.js";
import { sha256, stableJson, writeJson } from "./io.js";
import { withProcessRegistry } from "./process-registry.js";

const request = JSON.parse(process.argv[2]!) as {
  configFile: string;
  output: string;
  candidate: string;
  block?: number;
  fingerprint?: string;
  resultFile?: string;
  processRegistryFile?: string;
  measurement: { scenarioId: string; fileLabel: string };
};

function dotenvFingerprint(): string | null {
  const file = path.join(path.dirname(request.configFile), ".env");
  try {
    return sha256(fs.readFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function inputFingerprint(
  options: Parameters<typeof buildRunReceipt>[0],
  dotenv = dotenvFingerprint(),
): string {
  return sha256(stableJson({ inputs: buildRunReceipt(options).inputFingerprint, dotenv }));
}

function prepare() {
  // Config-adjacent dotenv files can live outside the project tree receipt.
  // Capture the input before loadConfig consumes it, including its absence.
  const dotenv = dotenvFingerprint();
  const config = loadConfig(request.configFile);
  const relative = path.relative(config.project.root, request.output);
  if (
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== ".agent-eval"
  )
    throw new Error("Experiment output inside a project must be beneath .agent-eval");
  const originalRuns = config.paths.runs;
  const managedRoot = path.dirname(originalRuns);
  config.paths.runs = path.join(request.output, "runs", request.candidate);
  const options = {
    config,
    configFile: request.configFile,
    specs: selectSpecs(loadSpecs(config.paths.specs), undefined, false),
    fixtures: loadFixtures(config.paths.fixtures),
    split: "all" as const,
    ignoredTargetPaths: [
      request.output,
      originalRuns,
      ...(path.basename(managedRoot) === ".agent-eval" ? [managedRoot] : []),
    ],
  };
  return { options, fingerprint: inputFingerprint(options, dotenv) };
}

let runDir: string | undefined;
try {
  const { options, fingerprint } = prepare();
  if (request.block === undefined) {
    console.log(JSON.stringify({ fingerprint, project: options.config.project.name }));
  } else {
    if (fingerprint !== request.fingerprint)
      throw new Error(`Candidate or evaluator inputs changed before visit: ${request.candidate}`);
    await withProcessRegistry(request.processRegistryFile!, () =>
      withCliSignals(async () => {
        const result = await runEvaluation({
          ...options,
          onRunCreated(directory) {
            runDir = directory;
            writeJson(request.resultFile!, { runDir });
            console.log(`AEK_EXPERIMENT_RUN:${JSON.stringify({ runDir })}`);
          },
        });
        if (!result.report) throw new Error("Benchmark evaluation produced no report");
        loadBenchmarkRun(result.runDir, request.measurement);
        if (inputFingerprint(options) !== fingerprint)
          throw new Error(
            `Candidate or evaluator inputs changed during visit: ${request.candidate}`,
          );
        writeJson(request.resultFile!, {
          record: campaignRunRecord(request.block!, result.runDir, result.report),
        });
      }),
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (request.resultFile)
    writeJson(request.resultFile, { error: message, ...(runDir ? { runDir } : {}) });
  else console.error(message);
  process.exitCode ||= 1;
}
