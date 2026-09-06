import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { redactConfig } from "../config.js";
import { snapshotTextInputs, textInputs, validateTextInputs } from "../text/inputs.js";
import { snapshotCollectorInputs } from "../collectors/inputs.js";
import { snapshotVisualInputs, visualInputs, validateVisualInputs } from "../visual/inputs.js";
import { graderMethodInputs, snapshotGraderMethods } from "../judging/command-inputs.js";
import type { EvalConfig, EvalSpec, EvalSplit, RunReceipt } from "../types.js";

function snapshotInputs(
  runDir: string,
  config: EvalConfig,
  specs: EvalSpec[],
  fixturesFile?: string,
): void {
  const inputDir = path.join(runDir, "inputs");
  fs.mkdirSync(path.join(inputDir, "specs"), { recursive: true });
  const safeConfig = redactConfig(config);
  fs.writeFileSync(path.join(inputDir, "config.resolved.yaml"), YAML.stringify(safeConfig));
  for (const spec of specs) {
    fs.copyFileSync(spec.sourceFile, path.join(inputDir, "specs", path.basename(spec.sourceFile)));
  }
  if (fixturesFile) {
    fs.copyFileSync(
      fixturesFile,
      path.join(inputDir, `fixtures${path.extname(fixturesFile) || ".json"}`),
    );
  }
}

export async function validateEvaluationInputs(
  config: EvalConfig,
  specs: EvalSpec[],
  split: EvalSplit | "all" = "all",
  scenarioIds?: string[],
): Promise<void> {
  graderMethodInputs(config, specs, split);
  validateTextInputs(config, specs, split);
  await validateVisualInputs(config, specs, split, scenarioIds);
}

export function snapshotEvaluationInputs(
  config: EvalConfig,
  specs: EvalSpec[],
  runDir: string,
  split: EvalSplit | "all",
  receipt: RunReceipt,
  scenarioIds?: string[],
): void {
  snapshotInputs(runDir, config, specs, config.paths.fixtures);
  snapshotVisualInputs(config, specs, runDir, split, receipt.inputs.visual!);
  snapshotTextInputs(config, specs, runDir, split, receipt.inputs);
  snapshotCollectorInputs(config, specs, runDir, split, receipt.inputs, scenarioIds);
  snapshotGraderMethods(config, specs, runDir, split, receipt.inputs.graderMethods!);
}

export function evaluatorInputPaths(
  config: EvalConfig,
  specs: EvalSpec[],
  split: EvalSplit | "all",
): string[] {
  return [
    ...Object.values(graderMethodInputs(config, specs, split)),
    ...Object.values(visualInputs(config, specs, split)),
    ...Object.values(textInputs(config, specs, split)),
  ].map((input) => input.file);
}
