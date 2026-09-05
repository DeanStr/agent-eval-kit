import fs from "node:fs";
import path from "node:path";
import { collectionManifestSchema } from "./contracts.js";
import { collectorInputPath, sourceReceipt } from "./inputs.js";
import { stableJson, writeJson } from "../io.js";
import { shellInvocation, spawnCaptured } from "../providers/process.js";
import { imageBytes, sourceImage } from "../visual/images.js";
import type { EvalConfig, RunReceipt, Scenario, ScenarioEvidence } from "../types.js";

function outputFile(root: string, relative: string): string {
  if (relative.includes("\\") || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../"))
    throw new Error(`Collector image path must be relative to its output directory: ${relative}`);
  const file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(file).isFile())
    throw new Error(`Collector image escapes output directory or is not a file: ${relative}`);
  return file;
}

export async function collectCommand(config: EvalConfig, scenario: Scenario, directory: string): Promise<ScenarioEvidence> {
  const collect = scenario.collect!;
  const runDir = path.dirname(directory);
  const startedAt = new Date().toISOString();
  const evidence: ScenarioEvidence = {
    scenarioId: scenario.id, scenarioName: scenario.name, kind: "command", collector: "command",
    sourceScenarioId: scenario.sourceScenarioId, caseId: scenario.caseId, strata: scenario.strata, split: scenario.split,
    outcome: "agent_error", summary: "Command collection did not complete.", observations: [], evidenceRefs: [], transcript: [], screenshots: [],
    artifacts: { context: "collector-context.json", manifest: "collector.stdout.json", stderr: "collector.stderr.log", process: "collector-run.json" },
    provider: "mock", startedAt, finishedAt: startedAt, durationMs: 0,
  };
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8")) as RunReceipt;
    const verifyMethods = () => {
      for (const configured of collect.methodFiles) {
        const key = `${scenario.id}/${configured}`;
        const expected = receipt.inputs.collectorMethods?.[key];
        if (!expected) throw new Error(`Missing collector method receipt: ${key}`);
        for (const file of [path.resolve(config.project.root, configured), collectorInputPath(runDir, key, "methods")]) {
          if (stableJson(sourceReceipt(file)) !== stableJson(expected)) throw new Error(`Collector method changed: ${key}; start a new run`);
        }
      }
    };
    verifyMethods();
    const sources = Object.fromEntries(Object.keys(collect.sources).map(name => {
      const key = `${scenario.id}/${name}`;
      const expected = receipt.inputs.collectorSources?.[key];
      const file = collectorInputPath(runDir, key);
      if (!expected || stableJson(sourceReceipt(file)) !== stableJson(expected)) throw new Error(`Collector source snapshot mismatch: ${key}`);
      return [name, { path: file, ...expected }];
    }));
    const outputDir = path.join(directory, "collector-output");
    fs.mkdirSync(outputDir, { recursive: true });
    const contextFile = path.join(directory, "collector-context.json");
    writeJson(contextFile, { version: 1, scenarioId: scenario.id, sources, outputDir, images: collect.images, variables: { ...config.variables, ...scenario.caseVariables } });
    const shell = shellInvocation(collect.command);
    const result = await spawnCaptured({
      command: shell.command, args: shell.args, cwd: config.project.root,
      env: { ...process.env, AEK_COLLECT_CONTEXT: contextFile },
      timeoutSeconds: collect.timeoutSeconds,
      stdoutFile: path.join(directory, "collector.stdout.json"), stderrFile: path.join(directory, "collector.stderr.log"),
    });
    writeJson(path.join(directory, "collector-run.json"), { command: collect.command, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut });
    verifyMethods();
    for (const [name, source] of Object.entries(sources)) {
      const { path: file, ...expected } = source;
      if (stableJson(sourceReceipt(file)) !== stableJson(expected)) throw new Error(`Collector modified source snapshot: ${name}`);
    }
    if (result.timedOut) throw new Error(`Collector ${scenario.id} timed out after ${collect.timeoutSeconds}s`);
    if (result.exitCode !== 0) throw new Error(`Collector ${scenario.id} exited ${result.exitCode ?? result.signal}; see collector.stderr.log`);
    if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error("Collector manifest exceeds 1 MiB");
    const manifest = collectionManifestSchema.parse(JSON.parse(result.stdout));
    const labels = manifest.images.map(image => image.label);
    if (new Set(labels).size !== labels.length) throw new Error("Collector returned duplicate image labels");
    if (manifest.outcome === "blocked") {
      if (labels.length) throw new Error("Blocked collector must return no images");
    } else if (stableJson([...labels].sort()) !== stableJson([...collect.images].sort())) {
      throw new Error(`Collector must return every declared image exactly once: ${collect.images.join(", ")}`);
    }
    fs.mkdirSync(path.join(directory, "screenshots"), { recursive: true });
    for (const image of manifest.images) {
      if (!Object.hasOwn(sources, image.source)) throw new Error(`Unknown collector source: ${image.source}`);
      const bytes = imageBytes(outputFile(outputDir, image.path));
      const relative = `screenshots/${image.label}.png`;
      fs.writeFileSync(path.join(directory, relative), await sourceImage(bytes));
      evidence.screenshots.push({ path: relative, label: image.label, step: 0, timeSeconds: image.timeSeconds, source: image.source, extraction: image.extraction });
    }
    evidence.outcome = manifest.outcome;
    evidence.summary = manifest.summary;
    evidence.observations = ["Command-collected evidence: source hashes are verified; extraction descriptions and observations are supplied by the project collector, not independently verified runtime behavior.", ...manifest.observations];
    evidence.evidenceRefs = evidence.screenshots.map(image => `${scenario.id}/${image.path}`);
    return evidence;
  } catch (error) {
    evidence.outcome = "agent_error";
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.summary = evidence.error;
    throw new Error(`Command collection ${scenario.id}: ${evidence.error}. See ${directory} for retained diagnostics.`, { cause: error });
  } finally {
    evidence.finishedAt = new Date().toISOString();
    evidence.durationMs = Date.now() - Date.parse(startedAt);
    writeJson(path.join(directory, "evidence.json"), evidence);
  }
}
