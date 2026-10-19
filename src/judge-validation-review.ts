import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadComparisonInput } from "./compare.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { isWithin, sha256, stableJson } from "./io.js";
import { loadRunState } from "./run/state.js";
import { loadSealedDefinitions } from "./run/inputs.js";
import { omitUndefinedDeep } from "./invariants.js";
import {
  validationConfigurationResults,
  validationConfigurationsSchema,
  validationDatasetSchema,
  validationLabelsSchema,
  validateValidationDataset,
  assertAutomaticValidationRubric,
} from "./judge-validation.js";

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = {
  caseId: text,
  configuration: text,
  split: z.enum(["development", "evaluation"]),
  evidenceRootSha256: hash,
};
const judged = {
  ...identity,
  runDir: text,
  evaluationFingerprint: hash,
  reasoning: z.string(),
  evidenceRefs: z.array(z.string()),
};
const observationSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...judged,
      status: z.literal("judged"),
      actual: z.enum(["pass", "partial", "fail", "not_found"]),
    })
    .strict(),
  z
    .object({ ...judged, status: z.literal("abstained"), actual: z.literal("cannot_judge") })
    .strict(),
  z
    .object({
      ...identity,
      status: z.literal("execution_error"),
      error: text,
      runDir: text.optional(),
    })
    .strict(),
]);
const input = z.object({ path: text, sha256: hash }).strict();
const summarySchema = z
  .object({
    schemaVersion: z.literal(1),
    inputs: z
      .object({
        dataset: input,
        labels: input,
        configurationManifest: input,
        configurations: z.array(z.object({ id: text, file: text, sha256: hash }).strict()).min(1),
      })
      .strict(),
    plannedObservations: z.number().int().positive(),
    observations: z.array(observationSchema),
    results: z.array(z.unknown()),
    limitations: z.array(z.string()),
  })
  .strict();

/** Cross-check a completed summary before it becomes decision-journal evidence. */
export function loadJudgeValidationReview(directory: string) {
  const root = fs.realpathSync(directory);
  const file = path.join(root, "validation-results.json");
  const bytes = fs.readFileSync(file);
  const report = omitUndefinedDeep(summarySchema.parse(JSON.parse(bytes.toString("utf8"))));
  const snapshot = (name: string, expected: string): unknown => {
    const bytes = fs.readFileSync(path.join(root, "review", name));
    if (sha256(bytes) !== expected) throw new Error(`Validation review snapshot changed: ${name}`);
    return JSON.parse(bytes.toString("utf8"));
  };
  const dataset = validationDatasetSchema.parse(
    snapshot("dataset.json", report.inputs.dataset.sha256),
  );
  const labels = validationLabelsSchema.parse(snapshot("labels.json", report.inputs.labels.sha256));
  const configurations = validationConfigurationsSchema.parse(
    snapshot("configurations.json", report.inputs.configurationManifest.sha256),
  );
  validateValidationDataset(dataset, labels);
  const ids = configurations.configurations.map((item) => item.id);
  if (
    new Set(ids).size !== ids.length ||
    stableJson(ids) !== stableJson(report.inputs.configurations.map((item) => item.id))
  )
    throw new Error("Validation configuration identities do not match the review snapshot");
  const planned = dataset.cases.length * ids.length;
  if (report.plannedObservations !== planned || report.observations.length !== planned)
    throw new Error("Only a completed validation comparison can be journaled");
  const seen = new Set<string>();
  for (const observation of report.observations) {
    const item = dataset.cases.find((item) => item.id === observation.caseId);
    const key = `${observation.configuration}/${observation.caseId}`;
    if (!item || !ids.includes(observation.configuration) || seen.has(key))
      throw new Error(`Unknown or duplicate validation observation: ${key}`);
    seen.add(key);
    if (
      observation.split !== item.split ||
      observation.evidenceRootSha256 !== item.evidence.rootSha256
    )
      throw new Error(`Validation evidence identity does not match the case: ${key}`);
    const attemptRoot = path.join(root, "attempts", observation.configuration, observation.caseId);
    if (observation.runDir) {
      const runDir = fs.realpathSync(observation.runDir);
      if (!isWithin(path.join(attemptRoot, "runs"), runDir))
        throw new Error(`Validation run is outside its attempt: ${key}`);
      assertArtifactIntegrity(runDir, {
        require: true,
        allowUnindexed: observation.status === "execution_error",
      });
    }
    if (observation.status === "execution_error") {
      if (fs.readFileSync(path.join(attemptRoot, "error.log"), "utf8") !== observation.error + "\n")
        throw new Error(`Validation error does not match retained diagnostics: ${key}`);
      continue;
    }
    const state = loadRunState(observation.runDir);
    if (state.mode !== "judge" || state.status !== "complete")
      throw new Error(`Validation judgement run is incomplete: ${key}`);
    const { report: original } = loadComparisonInput(observation.runDir);
    const { specs } = loadSealedDefinitions(observation.runDir, original.receipt);
    assertAutomaticValidationRubric(specs, item);
    const matches = original.areas
      .filter((area) => area.id === item.area)
      .flatMap((area) => area.items.filter((judgement) => judgement.id === item.rubric));
    const judgement = matches[0];
    if (
      matches.length !== 1 ||
      !judgement ||
      original.receipt.collection?.artifactRootSha256 !== observation.evidenceRootSha256 ||
      original.receipt.evaluationFingerprint !== observation.evaluationFingerprint ||
      judgement.verdict !== observation.actual ||
      judgement.reasoning !== observation.reasoning ||
      stableJson(judgement.evidenceRefs) !== stableJson(observation.evidenceRefs)
    )
      throw new Error(`Validation observation does not match its sealed judgement: ${key}`);
  }
  if (
    stableJson(report.results) !==
    stableJson(validationConfigurationResults(ids, report.observations, labels))
  )
    throw new Error("Validation metrics do not match the reviewed observations and labels");
  return { file, sha256: sha256(bytes), report, dataset };
}
