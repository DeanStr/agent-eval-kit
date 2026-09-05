import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sha256, stableJson } from "../io.js";
import { materializeSpecs } from "../specs.js";
import type { ArtifactReceipt, EvalConfig, EvalSpec, EvalSplit, RunReceipt } from "../types.js";

export function sourceReceipt(file: string): ArtifactReceipt {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 ** 3) throw new Error(`Collector source must be a regular file <= 1 GiB: ${file}`);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > 1024 ** 3) throw new Error(`Collector source grew beyond 1 GiB: ${file}`);
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return { bytes, sha256: hash.digest("hex") };
}

/** Enumerate declarations without reading files, including during offline rescore. */
export function collectorInputDefinitions(specs: EvalSpec[], split?: EvalSplit | "all", scenarioIds?: string[], kind: "sources" | "methods" = "sources") {
  const definitions: Record<string, string> = {};
  for (const spec of materializeSpecs(specs, split)) for (const scenario of spec.scenarios) {
    if (scenarioIds?.length && !scenarioIds.includes(scenario.id) && !(scenario.sourceScenarioId && scenarioIds.includes(scenario.sourceScenarioId))) continue;
    if (!scenario.collect) continue;
    const files = kind === "sources" ? scenario.collect.sources : Object.fromEntries(scenario.collect.methodFiles.map(file => [file, file]));
    for (const [name, configured] of Object.entries(files)) {
      definitions[`${scenario.id}/${name}`] = configured;
    }
  }
  return definitions;
}

export function collectorInputs(config: EvalConfig, specs: EvalSpec[], split?: EvalSplit | "all", scenarioIds?: string[], kind: "sources" | "methods" = "sources") {
  const inputs: Record<string, ArtifactReceipt & { file: string }> = {};
  const root = fs.realpathSync(config.project.root);
  for (const [key, configured] of Object.entries(collectorInputDefinitions(specs, split, scenarioIds, kind))) {
    let file: string;
    try { file = fs.realpathSync(path.resolve(root, configured)); }
    catch (error) { throw new Error(`Collector ${kind} input ${key} is unavailable: ${configured}. Build the artifact before running AEK.`, { cause: error }); }
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Collector ${kind} input ${key} escapes project.root`);
    inputs[key] = { file, ...sourceReceipt(file) };
  }
  return inputs;
}

export function collectorInputPath(runDir: string, key: string, kind: "sources" | "methods" = "sources"): string {
  return path.join(runDir, "inputs", `collector-${kind}`, sha256(key));
}

export function snapshotCollectorInputs(config: EvalConfig, specs: EvalSpec[], runDir: string, split: EvalSplit | "all", expected: Pick<RunReceipt["inputs"], "collectorSources" | "collectorMethods">, scenarioIds?: string[]) {
  for (const kind of ["sources", "methods"] as const) {
    const inputs = collectorInputs(config, specs, split, scenarioIds, kind);
    const expectedReceipts = kind === "sources" ? expected.collectorSources : expected.collectorMethods;
    const receipts = Object.fromEntries(Object.entries(inputs).map(([key, { bytes, sha256 }]) => [key, { bytes, sha256 }]));
    if (stableJson(receipts) !== stableJson(expectedReceipts)) throw new Error(`Collector ${kind} changed after receipt creation; start a new run`);
    for (const [key, input] of Object.entries(inputs)) {
      const file = collectorInputPath(runDir, key, kind);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(input.file, file, fs.constants.COPYFILE_EXCL);
      if (stableJson(sourceReceipt(file)) !== stableJson(expectedReceipts![key])) throw new Error(`Collector ${kind} changed during snapshot: ${key}`);
      fs.chmodSync(file, 0o444);
    }
  }
}
