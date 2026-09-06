import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadResolvedConfig, redactConfig } from "../config.js";
import { snapshotTextInputs, textInputs, validateTextInputs } from "../text/inputs.js";
import { snapshotCollectorInputs } from "../collectors/inputs.js";
import { snapshotVisualInputs, visualInputs, validateVisualInputs } from "../visual/inputs.js";
import { graderMethodInputs, snapshotGraderMethods } from "../judging/command-inputs.js";
import { sha256 } from "../io.js";
import { assertArtifactIntegrity } from "../integrity.js";
import { loadSpecFile, loadSelectedSpecs } from "../specs.js";
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

export const SCORING_DEFINITIONS = "scoring-definitions";
export const scoringConfigPath = `${SCORING_DEFINITIONS}/config.resolved.yaml`;
export function scoringSpecPath(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Invalid scoring spec ID");
  return `${SCORING_DEFINITIONS}/specs/${id}.yaml`;
}

/** Files for the same recoverable transaction as their new report and receipt. */
export function scoringDefinitionFiles(
  config: EvalConfig,
  specs: EvalSpec[],
  receipt: RunReceipt,
): Record<string, Buffer> {
  const files: Record<string, Buffer> = {
    [scoringConfigPath]: Buffer.from(YAML.stringify(redactConfig(config))),
  };
  for (const spec of specs) {
    const bytes = fs.readFileSync(spec.sourceFile);
    const expected = receipt.inputs.specs[spec.id];
    if (!expected || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
      throw new Error(`Scoring spec ${spec.id} changed before publication; reload definitions`);
    files[scoringSpecPath(spec.id)] = bytes;
  }
  return files;
}

/** Select recorded effective definitions explicitly; missing files never fall back. */
export function loadSealedDefinitions(
  runDir: string,
  receipt: RunReceipt,
): { config: EvalConfig; specs: EvalSpec[] } {
  assertArtifactIntegrity(runDir, { require: true });
  if (receipt.inputs.scoringConfig) {
    const configFile = path.join(runDir, scoringConfigPath);
    const bytes = fs.readFileSync(configFile);
    if (
      bytes.length !== receipt.inputs.scoringConfig.bytes ||
      sha256(bytes) !== receipt.inputs.scoringConfig.sha256
    )
      throw new Error("Effective scoring config does not match its receipt");
    const specs = Object.entries(receipt.inputs.specs).map(([id, expected]) => {
      const file = path.join(runDir, scoringSpecPath(id)),
        bytes = fs.readFileSync(file);
      if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
        throw new Error(`Effective scoring spec ${id} does not match its receipt`);
      const spec = loadSpecFile(file);
      if (spec.id !== id) throw new Error(`Effective scoring spec has wrong ID: ${id}`);
      return spec;
    });
    return { config: loadResolvedConfig(configFile), specs };
  }
  return {
    config: loadResolvedConfig(path.join(runDir, "inputs", "config.resolved.yaml")),
    specs: loadSelectedSpecs(
      path.join(runDir, "inputs", "specs"),
      receipt.inputs.selection.split ?? "all",
    ),
  };
}
