import fs from "node:fs";
import path from "node:path";
import { inputFileReceipt } from "../input-files.js";
import { sha256, stableJson } from "../io.js";
import { materializeSpecs } from "../specs.js";
import type { ArtifactReceipt, EvalConfig, EvalSpec, EvalSplit, RubricItem, RunReceipt } from "../types.js";

/** Explicit evaluator files may be outside the target, e.g. a shared oracle. */
export function graderMethodDefinitions(specs: EvalSpec[], split?: EvalSplit | "all"): Record<string, string> {
  return Object.fromEntries(materializeSpecs(specs, split).flatMap(spec => spec.rubric.flatMap(item =>
    item.grader.type === "command" ? item.grader.methodFiles.map(file => [`${item.id}/${file}`, file]) : [],
  )));
}

export function graderMethodInputs(config: EvalConfig, specs: EvalSpec[], split?: EvalSplit | "all") {
  return Object.fromEntries(Object.entries(graderMethodDefinitions(specs, split)).map(([key, configured]) => {
    const file = path.resolve(config.project.root, configured);
    try { return [key, { file, ...inputFileReceipt(file) }]; }
    catch (error) { throw new Error(`Command grader method ${key} is unavailable or invalid. Save the checker and expected data before running AEK.`, { cause: error }); }
  }));
}

export function graderMethodReceipts(config: EvalConfig, specs: EvalSpec[], split?: EvalSplit | "all", provenance?: RunReceipt): Record<string, ArtifactReceipt> {
  if (!provenance) return Object.fromEntries(Object.entries(graderMethodInputs(config, specs, split)).map(([key, { bytes, sha256 }]) => [key, { bytes, sha256 }]));
  const keys = Object.keys(graderMethodDefinitions(specs, split)).sort();
  const saved = provenance.inputs.graderMethods;
  if (!saved || stableJson(keys) !== stableJson(Object.keys(saved).sort())) throw new Error("Saved command grader method provenance does not match declarations; start a new run");
  for (const [key, entry] of Object.entries(saved)) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      throw new Error(`Invalid saved command grader method provenance: ${key}; start a new run`);
  }
  return saved;
}

export function graderMethodPath(runDir: string, key: string): string {
  return path.join(runDir, "inputs", "grader-methods", sha256(key));
}

export function snapshotGraderMethods(config: EvalConfig, specs: EvalSpec[], runDir: string, split: EvalSplit | "all", expected: Record<string, ArtifactReceipt>): void {
  const inputs = graderMethodInputs(config, specs, split);
  const receipts = Object.fromEntries(Object.entries(inputs).map(([key, { bytes, sha256 }]) => [key, { bytes, sha256 }]));
  if (stableJson(receipts) !== stableJson(expected)) throw new Error("Command grader methods changed after receipt creation; start a new run");
  for (const [key, input] of Object.entries(inputs)) {
    const file = graderMethodPath(runDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(input.file, file, fs.constants.COPYFILE_EXCL);
    if (stableJson(inputFileReceipt(file)) !== stableJson(expected[key])) throw new Error(`Command grader method changed during snapshot: ${key}`);
    fs.chmodSync(file, 0o444);
  }
}

/** Verify the executed files and retained snapshots against the same receipt. */
export function assertGraderMethods(config: EvalConfig, item: RubricItem, runDir: string): void {
  if (item.grader.type !== "command") throw new Error("Expected command grader");
  if (!item.grader.methodFiles.length) return;
  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8")) as RunReceipt;
  for (const configured of item.grader.methodFiles) {
    const key = `${item.id}/${configured}`, expected = receipt.inputs.graderMethods?.[key];
    if (!expected) throw new Error(`Missing command grader method receipt: ${key}; start a new run`);
    for (const file of [path.resolve(config.project.root, configured), graderMethodPath(runDir, key)]) {
      if (stableJson(inputFileReceipt(file)) !== stableJson(expected)) throw new Error(`Command grader method changed: ${key}; start a new run`);
    }
  }
}
