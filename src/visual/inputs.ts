import { collectorInputs } from "../collectors/inputs.js";
import fs from "node:fs";
import path from "node:path";
import { loadPromotedBaseline } from "../baselines.js";
import { sha256 } from "../io.js";
import { materializeSpecs } from "../specs.js";
import type { ArtifactReceipt, EvalConfig, EvalSpec, EvalSplit, Grader, ScenarioEvidence } from "../types.js";
import { controlledScreenshotLabels, type VisualReference } from "./contracts.js";
import { imageBytes, inspectImage } from "./images.js";

function referencesFor(grader: Grader): VisualReference[] {
  if (grader.type === "pairwise") return grader.references;
  if (grader.type === "image-regression") return [{ baseline: grader.baseline, label: grader.candidate }];
  return [];
}

export function visualInputs(config: EvalConfig, specs: EvalSpec[], split: EvalSplit | "all" = "all") {
  const inputs: Record<string, { file: string; sha256: string; bytes: number }> = {};
  const baselines = new Map<string, ReturnType<typeof loadPromotedBaseline>>();
  for (const spec of materializeSpecs(specs, split)) for (const item of spec.rubric) {
    for (const scenario of item.scenarios) for (const [index, reference] of referencesFor(item.grader).entries()) {
      let file: string;
      if (reference.file) {
        if (/^[a-z]+:\/\//i.test(reference.file)) throw new Error("Visual references must be pinned local files; download and review remote images first");
        file = path.resolve(config.project.root, reference.file);
      } else {
        const name = reference.baseline!;
        if (!baselines.has(name)) baselines.set(name, loadPromotedBaseline(config, name));
        const baseline = baselines.get(name)!;
        const matches = Object.values(baseline.promotion.images ?? {}).filter(image => image.scenario === (reference.scenario ?? scenario) && image.label === reference.label);
        if (matches.length > 1) throw new Error(`Ambiguous baseline image label: ${reference.label}`);
        const image = matches[0];
        if (!image) throw new Error(`Baseline ${name} lacks image ${reference.scenario ?? scenario}/${reference.label}; promote a complete run with --include-images`);
        file = path.join(baseline.directory, image.file);
      }
      const bytes = imageBytes(file);
      inputs[`${item.id}/${scenario}/${index}`] = { file, sha256: sha256(bytes), bytes: bytes.length };
    }
  }
  return inputs;
}

export function visualInputPath(runDir: string, key: string): string {
  return path.join(runDir, "inputs", "visual", `${sha256(key)}.image`);
}

export function snapshotVisualInputs(config: EvalConfig, specs: EvalSpec[], runDir: string, split: EvalSplit | "all", expected: Record<string, ArtifactReceipt>) {
  const inputs = visualInputs(config, specs, split);
  if (Object.keys(inputs).length !== Object.keys(expected).length) throw new Error("Visual reference selection changed during snapshot; start a new run");
  for (const [key, input] of Object.entries(inputs)) {
    if (expected[key]?.sha256 !== input.sha256 || expected[key]?.bytes !== input.bytes)
      throw new Error(`Visual reference changed after receipt creation: ${key}; start a new run`);
  }
  for (const [key, input] of Object.entries(inputs)) {
    const file = visualInputPath(runDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = imageBytes(input.file);
    if (sha256(bytes) !== input.sha256) throw new Error(`Visual reference changed during snapshot: ${input.file}`);
    fs.writeFileSync(file, bytes);
  }
}

export async function validateVisualInputs(config: EvalConfig, specs: EvalSpec[], split: EvalSplit | "all" = "all", scenarioIds?: string[]): Promise<void> {
  collectorInputs(config, specs, split, scenarioIds);
  collectorInputs(config, specs, split, scenarioIds, "methods");
  for (const spec of specs) for (const item of spec.rubric) {
    if (!["pairwise", "capture", "image-distinctness", "image-regression"].includes(item.grader.type)) continue;
    if (!item.scenarios.length) throw new Error(`${item.id} requires scenarios`);
    for (const id of item.scenarios) {
      const scenario = spec.scenarios.find(s => s.id === id);
      if (!scenario || !["browser", "command"].includes(scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")))
        throw new Error(`${item.id} requires browser or command-collector scenarios`);
      if (item.grader.type === "capture" && (scenario.collect || (!scenario.capture && !config.browser.diagnostics?.failOn.length)))
        throw new Error(`${item.id} requires controlled capture or browser.diagnostics.failOn checks`);
      if (scenario.collect && "candidate" in item.grader && !scenario.collect.images.includes(item.grader.candidate))
        throw new Error(`${item.id}: undeclared collector image label ${item.grader.candidate} for ${id}`);
      if (scenario.capture && "candidate" in item.grader) {
        const labels = controlledScreenshotLabels(scenario.capture);
        if (!labels.includes(item.grader.candidate)) throw new Error(`${item.id}: invalid controlled screenshot label ${item.grader.candidate} for ${id}. Available labels: ${labels.join(", ")}`);
      }
    }
  }
  const files = [...new Set(Object.values(visualInputs(config, specs, split)).map(input => input.file))];
  for (const file of files) await inspectImage(file);
}

/** All deterministic and model visual graders consume the same sealed evidence. */
export function visualEvidenceReader(runDir: string) {
  const receipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"));
  const sealed = JSON.parse(fs.readFileSync(path.join(runDir, "artifact-index.json"), "utf8")) as { entries: Array<{ path: string; sha256: string; bytes: number }> };
  const entries = new Map(sealed.entries.map(entry => [entry.path, entry]));
  return {
    candidate(scenario: ScenarioEvidence | undefined, label: string) {
      if (!scenario || scenario.outcome !== "completed") return undefined;
      const shots = scenario.screenshots.filter(shot => shot.label === label);
      if (shots.length > 1) throw new Error(`Ambiguous candidate label ${label} in ${scenario.scenarioId}`);
      if (!shots.length) {
        if (scenario.collector === "controlled" || scenario.collector === "command") throw new Error(`Completed ${scenario.collector === "controlled" ? "controlled capture" : "command collection"} ${scenario.scenarioId} is missing required screenshot ${label}`);
        return undefined;
      }
      const ref = `${scenario.scenarioId}/${shots[0].path}`;
      const file = path.resolve(runDir, ref);
      if (!file.startsWith(path.resolve(runDir) + path.sep)) throw new Error("Candidate path escapes run");
      const bytes = imageBytes(file), indexed = entries.get(ref);
      if (!indexed || indexed.sha256 !== sha256(bytes) || indexed.bytes !== bytes.length) throw new Error(`Candidate screenshot is not intact sealed evidence: ${ref}`);
      return { ref, file, bytes };
    },
    reference(key: string) {
      const file = visualInputPath(runDir, key), bytes = imageBytes(file), expected = receipt.inputs.visual?.[key];
      if (!expected || expected.sha256 !== sha256(bytes) || expected.bytes !== bytes.length) throw new Error(`Visual reference receipt mismatch: ${key}`);
      return { file, bytes };
    },
  };
}
