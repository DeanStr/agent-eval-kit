import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { assertArtifactIntegrity } from "./integrity.js";
import {
  isWithin,
  isPortablePathComponent,
  prospectiveRealPath,
  sha256,
  stableJson,
  writeJson,
} from "./io.js";
import { judgeCollected } from "./judge-run.js";
import { loadCollection } from "./collection.js";
import { loadSelectedSpecs, loadFixtures } from "./specs.js";
import { loadRunState } from "./run/state.js";
import { throwIfCancelled } from "./cancellation.js";
import { evaluatorInputPaths } from "./run/inputs.js";
import type { EvalSpec } from "./types.js";
import { validationMetrics, verdictOutcome, type ValidationOutcome } from "./validation-metrics.js";

const text = z.string().trim().min(1);
const id = text.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const rubricId = text
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(isPortablePathComponent);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bundle = z.object({ directory: text, rootSha256: hash }).strict();
const source = z.object({ path: text, sha256: hash }).strict();
function uniqueIgnoringCase(values: string[]): boolean {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}
export const validationDatasetSchema = z
  .object({
    version: z.literal(1),
    cases: z
      .array(
        z
          .object({
            id,
            group: id,
            split: z.enum(["development", "evaluation"]),
            evidence: bundle,
            area: rubricId,
            rubric: rubricId,
            originalRun: bundle.optional(),
            sources: z.array(source),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const validationLabelsSchema = z
  .object({
    version: z.literal(1),
    labels: z
      .array(
        z
          .object({
            caseId: id,
            evidenceRootSha256: hash,
            area: rubricId,
            rubric: rubricId,
            reviewer: z.object({ name: text, kind: z.enum(["human", "agent"]) }).strict(),
            application: z
              .object({
                verdict: z.enum(["pass", "fail", "unknown"]),
                rationale: text,
                sources: z.array(text).min(1),
              })
              .strict(),
            evidence: z
              .object({
                verdict: z.enum(["pass", "fail", "cannot_judge"]),
                rationale: text,
                refs: z.array(text),
              })
              .strict()
              .refine((item) => item.verdict === "cannot_judge" || item.refs.length > 0, {
                message: "Decisive evidence labels require supporting evidence references",
              }),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const validationConfigurationsSchema = z
  .object({
    version: z.literal(1),
    configurations: z
      .array(z.object({ id, config: text }).strict())
      .min(1)
      .refine((items) => uniqueIgnoringCase(items.map((item) => item.id)), {
        message: "Duplicate configuration ID (case-insensitive)",
      }),
  })
  .strict();

export type ValidationDataset = z.infer<typeof validationDatasetSchema>;
export type ValidationLabels = z.infer<typeof validationLabelsSchema>;
export type ValidationObservation = ValidationOutcome & {
  caseId: string;
  configuration: string;
  split: "development" | "evaluation";
  evidenceRootSha256: string;
  runDir?: string;
  evaluationFingerprint?: string;
  reasoning?: string;
  evidenceRefs?: string[];
};

const json = (bytes: Buffer): unknown => JSON.parse(bytes.toString("utf8"));
function unique(values: string[], description: string) {
  if (!uniqueIgnoringCase(values)) throw new Error(`Duplicate ${description} (case-insensitive)`);
}

export function validateValidationDataset(dataset: ValidationDataset, labels: ValidationLabels) {
  unique(
    dataset.cases.map((item) => item.id),
    "case ID",
  );
  unique(
    labels.labels.map((item) => item.caseId),
    "reviewer label",
  );
  const splits = new Map<string, string>();
  const evidenceGroups = new Map<string, string>();
  for (const item of dataset.cases) {
    const previous = splits.get(item.group);
    if (previous && previous !== item.split)
      throw new Error(`Related group ${item.group} crosses dataset splits`);
    splits.set(item.group, item.split);
    for (const identity of [item.evidence.rootSha256, item.originalRun?.rootSha256].filter(
      (value): value is string => value !== undefined,
    )) {
      const group = evidenceGroups.get(identity);
      if (group && group !== item.group)
        throw new Error(
          `Identical evidence or original runs must share a related group: ${item.id}`,
        );
      evidenceGroups.set(identity, item.group);
    }
    const label = labels.labels.find((label) => label.caseId === item.id);
    if (!label || label.evidenceRootSha256 !== item.evidence.rootSha256)
      throw new Error(`Missing or mismatched reviewer label for ${item.id}`);
    if (label.area !== item.area || label.rubric !== item.rubric)
      throw new Error(
        `Reviewer label for ${item.id} does not match selected criterion ${item.area}/${item.rubric}; review the label for this criterion before comparing judges`,
      );
  }
  if (labels.labels.some((label) => !dataset.cases.some((item) => item.id === label.caseId)))
    throw new Error("Reviewer labels contain unknown cases");
}

/** Pending manual work is not a model abstention. Apply this to execution and review. */
export function assertAutomaticValidationRubric(
  specs: EvalSpec[],
  item: Pick<ValidationDataset["cases"][number], "area" | "rubric">,
): void {
  const matches = specs
    .filter((spec) => spec.id === item.area)
    .flatMap((spec) => spec.rubric.filter((rubric) => rubric.id === item.rubric));
  if (matches.length !== 1)
    throw new Error(`Expected exactly one ${item.area}/${item.rubric} validation criterion`);
  const type = matches[0]!.grader.type;
  if (type === "hybrid" || type === "manual")
    throw new Error(
      `Judge validation requires an automatic rubric; ${item.area}/${item.rubric} uses ${type}. Select a separate automatic criterion with its own reviewed labels`,
    );
}

export function summarizeValidation(
  observations: ValidationObservation[],
  labels: ValidationLabels,
) {
  const labelled = observations.map((observation) => {
    const label = labels.labels.find((label) => label.caseId === observation.caseId);
    if (!label) throw new Error(`Missing reviewer label for ${observation.caseId}`);
    return { ...observation, expected: label.evidence.verdict };
  });
  return validationMetrics(labelled);
}

export function validationConfigurationResults(
  configurations: string[],
  observations: ValidationObservation[],
  labels: ValidationLabels,
) {
  return configurations.map((id) => ({
    configuration: id,
    metrics: summarizeValidation(
      observations.filter((item) => item.configuration === id),
      labels,
    ),
    splits: Object.fromEntries(
      ["development", "evaluation"].map((split) => [
        split,
        summarizeValidation(
          observations.filter((item) => item.configuration === id && item.split === split),
          labels,
        ),
      ]),
    ),
  }));
}

function verifyBundle(directory: string, expected: string) {
  const index = assertArtifactIntegrity(directory, { require: true })!;
  if (index.rootSha256 !== expected)
    throw new Error(
      `Bundle identity changed: ${directory}; expected ${expected}, got ${index.rootSha256}`,
    );
  return index;
}

/** Review files and original judgements are read only here, never passed to judgeCollected. */
export async function runJudgeValidation(options: {
  datasetFile: string;
  labelsFile: string;
  configurationsFile: string;
  output: string;
  onProgress?: (message: string) => void;
}) {
  const datasetFile = fs.realpathSync(options.datasetFile);
  const labelsFile = fs.realpathSync(options.labelsFile);
  const configurationsFile = fs.realpathSync(options.configurationsFile);
  const datasetBytes = fs.readFileSync(datasetFile);
  const labelBytes = fs.readFileSync(labelsFile);
  const configurationBytes = fs.readFileSync(configurationsFile);
  const dataset = validationDatasetSchema.parse(json(datasetBytes));
  const labels = validationLabelsSchema.parse(json(labelBytes));
  const configurations = validationConfigurationsSchema.parse(json(configurationBytes));
  const inputHashes = {
    dataset: sha256(datasetBytes),
    labels: sha256(labelBytes),
    configurations: sha256(configurationBytes),
  };
  validateValidationDataset(dataset, labels);
  const base = path.dirname(datasetFile);
  const cases = dataset.cases.map((item) => ({
    ...item,
    directory: fs.realpathSync(path.resolve(base, item.evidence.directory)),
  }));
  const configs = configurations.configurations.map((item) => {
    const file = fs.realpathSync(path.resolve(path.dirname(configurationsFile), item.config));
    return { ...item, file, sha256: sha256(fs.readFileSync(file)), config: loadConfig(file) };
  });
  const output = prospectiveRealPath(path.resolve(options.output));
  // Labels and review provenance stay out of collection snapshots and project inputs.
  for (const directory of [
    ...cases.map((item) => item.directory),
    ...configs.map((item) => fs.realpathSync(item.config.project.root)),
    ...cases.flatMap((item) =>
      item.originalRun ? [fs.realpathSync(path.resolve(base, item.originalRun.directory))] : [],
    ),
  ]) {
    if (isWithin(directory, labelsFile))
      throw new Error(
        `Reviewer labels must be outside judge inputs and project roots: ${directory}`,
      );
    if (isWithin(directory, output))
      throw new Error(
        `Validation output must be outside source bundles and project roots: ${directory}`,
      );
  }
  for (const item of cases) {
    if (item.originalRun)
      verifyBundle(path.resolve(base, item.originalRun.directory), item.originalRun.rootSha256);
    for (const source of item.sources) {
      if (sha256(fs.readFileSync(path.resolve(base, source.path))) !== source.sha256)
        throw new Error(`Review source changed: ${source.path}`);
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output); // A comparison never overwrites a previous experiment.
  fs.mkdirSync(path.join(output, "review"));
  fs.writeFileSync(path.join(output, "review", "dataset.json"), datasetBytes);
  fs.writeFileSync(path.join(output, "review", "labels.json"), labelBytes);
  fs.writeFileSync(path.join(output, "review", "configurations.json"), configurationBytes);
  // Load every planned judge before the first invocation. Later cases may not
  // silently pick up edits to rubric files, datasets, references or methods.
  const prepared = configs.map((candidate) =>
    cases.map((item) => {
      try {
        if (sha256(fs.readFileSync(candidate.file)) !== candidate.sha256)
          throw new Error(`Judge configuration changed: ${candidate.file}; start a new comparison`);
        verifyBundle(item.directory, item.evidence.rootSha256);
        const manifest = loadCollection(item.directory);
        const state = loadRunState(item.directory);
        const specs = loadSelectedSpecs(candidate.config.paths.specs, manifest.split).filter(
          (spec) => state.selectedAreas.includes(spec.id),
        );
        assertAutomaticValidationRubric(specs, item);
        const snapshotInputs = () =>
          [
            ...new Set([
              candidate.file,
              ...specs.map((spec) => spec.sourceFile),
              ...(candidate.config.paths.fixtures ? [candidate.config.paths.fixtures] : []),
              ...evaluatorInputPaths(candidate.config, specs, manifest.split),
            ]),
          ]
            .sort()
            .map((file) => {
              if (fs.realpathSync(file) === labelsFile)
                throw new Error(`Reviewer labels cannot be a judge input: ${file}`);
              return { file, sha256: sha256(fs.readFileSync(file)) };
            });
        const inputs = snapshotInputs();
        return {
          ok: true as const,
          specs,
          fixtures: loadFixtures(candidate.config.paths.fixtures),
          assertInputs: () => {
            // Resolve references again as well as hashing their bytes: named
            // references may move to a new snapshot without changing the spec.
            const current = snapshotInputs();
            if (stableJson(current) !== stableJson(inputs)) {
              const original = new Map(inputs.map((input) => [input.file, input.sha256]));
              const changed = current
                .filter((input) => original.get(input.file) !== input.sha256)
                .map((input) => input.file);
              throw new Error(
                `Judge inputs changed during comparison (${candidate.id}/${item.id}): ${changed.join(", ")}; start a new comparison`,
              );
            }
          },
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    }),
  );
  const observations: ValidationObservation[] = [];
  const summarize = () => {
    const report = {
      schemaVersion: 1,
      inputs: {
        dataset: { path: datasetFile, sha256: inputHashes.dataset },
        labels: { path: labelsFile, sha256: inputHashes.labels },
        configurationManifest: { path: configurationsFile, sha256: inputHashes.configurations },
        configurations: configs.map(({ id, file, sha256 }) => ({ id, file, sha256 })),
      },
      plannedObservations: cases.length * configs.length,
      observations,
      results: validationConfigurationResults(
        configs.map(({ id }) => id),
        observations,
        labels,
      ),
      limitations: [
        "Labels are reviewer assessments, not independent ground truth; reviewer kind is recorded in the separate label file.",
        "Metrics use evidence-supported labels. Known application outcomes are separate and never substitute for missing evidence.",
        "False passes divide by expected failures; false failures divide by expected passes, including abstentions/errors in those denominators. Partial and not_found are non-passing decisions.",
        "Abstentions, execution errors, and decision coverage divide by all attempted cases. Unsupported decisions and correct abstentions divide by evidence-insufficient cases. Zero denominators have null rates.",
        "Related variants must share a group and split. Evaluation cases must remain held out during configuration tuning; this small exercise is not an accuracy estimate.",
      ],
    };
    writeJson(path.join(output, "validation-results.json"), report);
    return report;
  };
  summarize();
  try {
    for (const [configurationIndex, candidate] of configs.entries())
      for (const [caseIndex, item] of cases.entries()) {
        throwIfCancelled();
        const attemptRoot = path.join(output, "attempts", candidate.id, item.id);
        const runs = path.join(attemptRoot, "runs");
        fs.mkdirSync(attemptRoot, { recursive: true });
        const identity = {
          caseId: item.id,
          configuration: candidate.id,
          split: item.split,
          evidenceRootSha256: item.evidence.rootSha256,
        };
        options.onProgress?.(`${candidate.id}/${item.id}`);
        try {
          const planned = prepared[configurationIndex]![caseIndex]!;
          if (!planned.ok) throw planned.error;
          planned.assertInputs();
          verifyBundle(item.directory, item.evidence.rootSha256);
          const config = { ...candidate.config, paths: { ...candidate.config.paths, runs } };
          const result = await judgeCollected({
            evidenceDir: item.directory,
            config,
            configFile: candidate.file,
            specs: planned.specs,
            fixtures: planned.fixtures,
            explicitConfig: true,
            onProgress: (message) => {
              fs.appendFileSync(path.join(attemptRoot, "progress.log"), message + "\n");
            },
          });
          assertArtifactIntegrity(result.runDir, { require: true });
          const matches = result.report.areas
            .filter((area) => area.id === item.area)
            .flatMap((area) => area.items.filter((judgement) => judgement.id === item.rubric));
          if (matches.length !== 1)
            throw new Error(`Expected exactly one ${item.area}/${item.rubric} judgement`);
          const judgement = matches[0]!;
          planned.assertInputs();
          verifyBundle(item.directory, item.evidence.rootSha256);
          observations.push({
            ...identity,
            ...verdictOutcome(judgement.verdict),
            runDir: result.runDir,
            evaluationFingerprint: result.report.receipt.evaluationFingerprint,
            reasoning: judgement.reasoning,
            evidenceRefs: judgement.evidenceRefs,
          });
        } catch (error) {
          const diagnostic =
            error instanceof Error ? (error.stack ?? error.message) : String(error);
          fs.writeFileSync(path.join(attemptRoot, "error.log"), diagnostic + "\n");
          const created = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
          observations.push({
            ...identity,
            status: "execution_error",
            error: diagnostic,
            ...(created.length === 1 ? { runDir: path.join(runs, created[0]!) } : {}),
          });
        }
        summarize();
        throwIfCancelled();
      }
    return { output, report: summarize() };
  } finally {
    summarize();
  }
}
