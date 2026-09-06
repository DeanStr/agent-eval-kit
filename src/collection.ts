import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { redactConfig } from "./config.js";
import { assertArtifactIntegrity, writeArtifactIndex } from "./integrity.js";
import { sha256, stableJson, writeJson } from "./io.js";
import { loadSpecFile, materializeSpecs } from "./specs.js";
import { textInputDefinitions } from "./text/inputs.js";
import type { EvalConfig, EvalSpec, EvalSplit, RunReceipt } from "./types.js";

/** Collection identity deliberately excludes all model judgement and scoring policy. */
export function collectionConfig(config: EvalConfig) {
  return {
    project: config.project,
    target: config.target,
    agent: config.agent,
    browser: config.browser,
    variables: config.variables,
    instructions: config.instructions,
  };
}

export function collectionDefinitions(specs: EvalSpec[], split: EvalSplit | "all") {
  return materializeSpecs(specs, split).map((spec) => ({
    id: spec.id,
    title: spec.title,
    scenarios: spec.scenarios,
    commands: spec.rubric
      .filter((item) => item.grader.type === "command")
      .map((item) => {
        const { weight: _weight, gate: _gate, tags: _tags, ...definition } = item;
        return definition;
      }),
  }));
}

const collectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("collection"),
    completedAt: z.string(),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    redactedConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
    definitionsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    textCandidatesSha256: z.string().regex(/^[a-f0-9]{64}$/),
    split: z.enum(["all", "development", "evaluation"]),
    scenarioIds: z.array(z.string()).optional(),
  })
  .strict();
export type CollectionManifest = z.infer<typeof collectionSchema>;

export function sealCollection(
  runDir: string,
  config: EvalConfig,
  specs: EvalSpec[],
  split: EvalSplit | "all",
  scenarioIds?: string[],
): void {
  const manifest: CollectionManifest = {
    schemaVersion: 1,
    kind: "collection",
    completedAt: new Date().toISOString(),
    configSha256: sha256(stableJson(collectionConfig(config))),
    redactedConfigSha256: sha256(stableJson(collectionConfig(redactConfig(config)))),
    definitionsSha256: sha256(stableJson(collectionDefinitions(specs, split))),
    textCandidatesSha256: sha256(stableJson(textInputDefinitions(specs, split, "textCandidates"))),
    split,
    scenarioIds,
  };
  writeJson(path.join(runDir, "collection.json"), manifest);
  writeArtifactIndex(runDir);
}

export function loadCollection(runDir: string): CollectionManifest {
  assertArtifactIntegrity(runDir, { require: true });
  return collectionSchema.parse(
    JSON.parse(fs.readFileSync(path.join(runDir, "collection.json"), "utf8")),
  );
}

export function assertCollectionCompatible(
  manifest: CollectionManifest,
  config: EvalConfig,
  specs: EvalSpec[],
  explicitConfig: boolean,
): void {
  const actual = sha256(
    stableJson(collectionConfig(explicitConfig ? config : redactConfig(config))),
  );
  if (actual !== (explicitConfig ? manifest.configSha256 : manifest.redactedConfigSha256))
    throw new Error(
      "Collection configuration changed (target, agent, browser, variables or instructions); collect fresh evidence",
    );
  if (
    manifest.definitionsSha256 !== sha256(stableJson(collectionDefinitions(specs, manifest.split)))
  )
    throw new Error(
      "Scenario or executable check definitions changed; collect fresh evidence. Judging may change rubric criteria, references and scoring, but cannot change what was collected.",
    );
  if (
    manifest.textCandidatesSha256 !==
    sha256(stableJson(textInputDefinitions(specs, manifest.split, "textCandidates")))
  )
    throw new Error("Candidate text declarations changed; collect fresh evidence");
}

export function snapshotJudgingDefinitions(
  runDir: string,
  config: EvalConfig,
  specs: EvalSpec[],
  receipt: RunReceipt,
): void {
  const directory = path.join(runDir, "inputs", "specs");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const spec of specs) {
    const bytes = fs.readFileSync(spec.sourceFile),
      expected = receipt.inputs.specs[spec.id];
    if (!expected || sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes)
      throw new Error(`Spec ${spec.id} changed during judging snapshot; start a new judging run`);
    const destination = path.join(directory, expected.file);
    fs.writeFileSync(destination, bytes);
    const parsed = loadSpecFile(destination);
    if (
      stableJson({ ...spec, sourceFile: undefined }) !==
      stableJson({ ...parsed, sourceFile: undefined })
    )
      throw new Error(
        `Spec ${spec.id} differs from the loaded judging definition; reload specs and start a new judging run`,
      );
  }
  fs.writeFileSync(
    path.join(runDir, "inputs", "config.resolved.yaml"),
    YAML.stringify(redactConfig(config)),
  );
}
