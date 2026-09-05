import { pairwiseSchema, captureSchema, distinctnessSchema, imageRegressionSchema } from "./visual/contracts.js";
import { collectorSchema } from "./collectors/contracts.js";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isPortablePathComponent, stableJson } from "./io.js";
import type { EvalConfig, EvalSpec, EvalSplit, RubricItem, Scenario, ScenarioCase } from "./types.js";

const graderSchema = z.discriminatedUnion("type", [
  pairwiseSchema,
  distinctnessSchema,
  imageRegressionSchema,
  z.object({ type: z.literal("capture") }).strict(),
  z.object({ type: z.literal("llm") }).strict(),
  z.object({
    type: z.literal("command"),
    output: z.enum(["json", "exit-code"]),
    command: z.string().min(1),
    cwd: z.union([z.literal("project"), z.literal("run"), z.string().min(1)]).optional(),
    timeoutSeconds: z.number().positive().optional(),
  }).strict(),
  z.object({ type: z.literal("manual") }).strict(),
  z.object({
    type: z.literal("hybrid"),
    autoShare: z.number().min(0).max(1).default(0.5),
  }).strict(),
]);

const splitSchema = z.enum(["development", "evaluation"]);
// Areas and scenarios become directory components. A materialized matrix ID is
// `${scenarioId}--${caseId}`; capping each source component at 100 ASCII
// characters keeps every resulting component below the common 255-byte limit.
const artifactIdSchema = z
  .string()
  .max(100, "must be at most 100 characters")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine(isPortablePathComponent, "must not be a Windows reserved device name or end in a dot");
const strataSchema = z.union([
  z.array(z.string().min(1)).transform((value) => [...new Set(value)].sort()),
  z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])).transform((value) =>
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${key}=${String(item)}`),
  ),
]).default([]);
const scenarioCaseSchema = z.object({
  id: artifactIdSchema,
  name: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
  strata: strataSchema,
  split: splitSchema.optional(),
}).strict();

const scenarioSchema = z.object({
  id: artifactIdSchema,
  name: z.string().min(1),
  kind: z.enum(["browser", "workspace", "command"]).optional(),
  persona: z.string().min(1).optional(),
  instructions: z.string().min(1),
  successSignals: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  requiresAuth: z.boolean().default(false),
  split: splitSchema.optional(),
  cases: z.array(scenarioCaseSchema).min(1).optional(),
  capture: captureSchema.optional(),
  collect: collectorSchema.optional(),
}).strict();

const rubricSchema = z
  .object({
    // Command graders derive artifact filenames from rubric IDs too.
    id: artifactIdSchema,
    criterion: z.string().min(1),
    weight: z.number().positive(),
    tags: z.array(z.string().min(1)).default(["general"]),
    scenarios: z.array(z.string().min(1)).default([]),
    grader: graderSchema.default({ type: "llm" }),
    passCriteria: z.string().min(1),
    evidence: z.string().optional(),
    manualInstructions: z.string().optional(),
    gate: z.boolean().default(false),
  }).strict()
  .superRefine((item, context) => {
    if ((item.grader.type === "manual" || item.grader.type === "hybrid") && !item.manualInstructions) {
      context.addIssue({
        code: "custom",
        path: ["manualInstructions"],
        message: `${item.grader.type} grader requires manualInstructions`,
      });
    }
  });

const specSchema = z.object({
  id: artifactIdSchema,
  title: z.string().min(1),
  weight: z.number().positive(),
  optional: z.boolean().default(false),
  description: z.string().min(1),
  scenarios: z.array(scenarioSchema).min(1),
  rubric: z.array(rubricSchema).min(1),
}).strict();

const filesystemKey = (value: string) => value.toLowerCase();
const reservedScenarioArtifactIds = new Set([
  "areas",
  "artifact-index.json",
  "comparisons",
  "inputs",
  "lifecycle",
  "manual-checklist.md",
  "manual-results.json",
  "manual-revisions.ndjson",
  "receipt.json",
  "report.html",
  "report.json",
  "run-state.json",
  "run.log",
].map(filesystemKey));

export function loadSpecFile(file: string): EvalSpec {
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  try {
    return { ...specSchema.parse(raw), sourceFile: file };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
        .join("\n  - ");
      throw new Error(`Invalid spec ${file}:\n  - ${details}`);
    }
    throw error;
  }
}

export function loadSpecs(specsPath: string): EvalSpec[] {
  if (!fs.existsSync(specsPath)) throw new Error(`Specs path does not exist: ${specsPath}`);
  const stat = fs.statSync(specsPath);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(specsPath)
        .filter((name) => /\.ya?ml$/i.test(name))
        .sort()
        .map((name) => path.join(specsPath, name))
    : [specsPath];
  if (!files.length) throw new Error(`No .yaml or .yml specs found in ${specsPath}`);

  const specs = files.map(loadSpecFile);
  const areaIds = new Set<string>();
  const foldedAreaIds = new Map<string, string>();
  const scenarioIds = new Set<string>();
  const foldedScenarioIds = new Map<string, string>();
  // Scenario artifacts live directly under the run directory, so executable
  // IDs must be unique across the complete spec set rather than only within an
  // area. Seed this with every source ID first so the result is independent of
  // spec file ordering.
  const sourceExecutableIds = specs.flatMap((spec) => spec.scenarios.map((scenario) => scenario.id));
  const executableIds = new Set(sourceExecutableIds);
  const foldedExecutableIds = new Map<string, string>();
  for (const id of sourceExecutableIds) {
    if (!foldedExecutableIds.has(filesystemKey(id))) foldedExecutableIds.set(filesystemKey(id), id);
  }
  const rubricIds = new Set<string>();
  const foldedRubricIds = new Map<string, string>();
  const problems: string[] = [];
  for (const spec of specs) {
    const foldedArea = foldedAreaIds.get(filesystemKey(spec.id));
    if (areaIds.has(spec.id)) problems.push(`duplicate area id ${spec.id}`);
    else if (foldedArea) problems.push(`area ids ${foldedArea} and ${spec.id} collide on case-insensitive filesystems`);
    areaIds.add(spec.id);
    if (!foldedArea) foldedAreaIds.set(filesystemKey(spec.id), spec.id);
    const localScenarios = new Set(spec.scenarios.map((scenario) => scenario.id));
    const scenarioOrder = new Map(spec.scenarios.map((scenario, index) => [scenario.id, index]));
    for (const [scenarioIndex, scenario] of spec.scenarios.entries()) {
      const scenarioKey = filesystemKey(scenario.id);
      const foldedScenario = foldedScenarioIds.get(scenarioKey);
      if (scenarioIds.has(scenario.id)) problems.push(`duplicate scenario id ${scenario.id}`);
      else if (foldedScenario) problems.push(`scenario ids ${foldedScenario} and ${scenario.id} collide on case-insensitive filesystems`);
      if (reservedScenarioArtifactIds.has(scenarioKey)) {
        problems.push(`scenario id ${scenario.id} is reserved by the run artifact layout`);
      }
      scenarioIds.add(scenario.id);
      if (!foldedScenario) foldedScenarioIds.set(scenarioKey, scenario.id);
      const localCases = new Set<string>();
      const foldedLocalCases = new Map<string, string>();
      for (const scenarioCase of scenario.cases ?? []) {
        const caseKey = filesystemKey(scenarioCase.id);
        const foldedCase = foldedLocalCases.get(caseKey);
        if (localCases.has(scenarioCase.id)) problems.push(`duplicate case id ${scenarioCase.id} in scenario ${scenario.id}`);
        else if (foldedCase) problems.push(`case ids ${foldedCase} and ${scenarioCase.id} in scenario ${scenario.id} collide on case-insensitive filesystems`);
        localCases.add(scenarioCase.id);
        if (!foldedCase) foldedLocalCases.set(caseKey, scenarioCase.id);
        const expandedId = executionId(scenario.id, scenarioCase.id);
        const expandedKey = filesystemKey(expandedId);
        if (executableIds.has(expandedId) || foldedExecutableIds.has(expandedKey)) {
          problems.push(`expanded scenario id ${expandedId} collides with another scenario or case across the spec set (found in area ${spec.id})`);
        }
        if (reservedScenarioArtifactIds.has(expandedKey)) {
          problems.push(`expanded scenario id ${expandedId} is reserved by the run artifact layout`);
        }
        executableIds.add(expandedId);
        if (!foldedExecutableIds.has(expandedKey)) foldedExecutableIds.set(expandedKey, expandedId);
      }
      for (const dependency of scenario.dependsOn) {
        if (!localScenarios.has(dependency)) {
          problems.push(`${scenario.id} depends on unknown scenario ${dependency} in area ${spec.id}`);
        } else if (scenarioOrder.get(dependency)! >= scenarioIndex) {
          problems.push(`${scenario.id} must depend only on an earlier scenario; ${dependency} is not earlier in area ${spec.id}`);
        }
      }
    }
    for (const scenario of spec.scenarios) {
      for (const dependency of scenario.dependsOn) {
        const dependencyScenario = spec.scenarios.find((candidate) => candidate.id === dependency);
        if (!dependencyScenario) continue;
        if (scenario.cases?.length && dependencyScenario.cases?.length) {
          const dependencyCases = new Map(dependencyScenario.cases.map((item) => [item.id, item]));
          for (const scenarioCase of scenario.cases) {
            const dependencyCase = dependencyCases.get(scenarioCase.id);
            if (!dependencyCase) {
              problems.push(`${scenario.id}/${scenarioCase.id} has no matching dependency case ${dependency}/${scenarioCase.id}`);
              continue;
            }
            if (stableJson(scenarioCase.strata) !== stableJson(dependencyCase.strata)) {
              problems.push(`${scenario.id}/${scenarioCase.id} has different strata from dependency ${dependency}/${scenarioCase.id}`);
            }
            const scenarioSplit = scenarioCase.split ?? scenario.split;
            const dependencySplit = dependencyCase.split ?? dependencyScenario.split;
            if (dependencySplit && scenarioSplit !== dependencySplit) {
              problems.push(scenarioSplit
                ? `${scenario.id}/${scenarioCase.id} has split ${scenarioSplit} but dependency ${dependency}/${scenarioCase.id} has split ${dependencySplit}`
                : `${scenario.id}/${scenarioCase.id} runs in every split but dependency ${dependency}/${scenarioCase.id} has split ${dependencySplit}`);
            }
          }
        } else if (!scenario.cases?.length && dependencyScenario.cases?.length) {
          problems.push(`${scenario.id} cannot depend on matrix scenario ${dependency} without defining matching cases`);
        } else if (scenario.cases?.length) {
          for (const scenarioCase of scenario.cases) {
            const scenarioSplit = scenarioCase.split ?? scenario.split;
            if (dependencyScenario.split && scenarioSplit !== dependencyScenario.split) {
              problems.push(scenarioSplit
                ? `${scenario.id}/${scenarioCase.id} has split ${scenarioSplit} but dependency ${dependency} has split ${dependencyScenario.split}`
                : `${scenario.id}/${scenarioCase.id} runs in every split but dependency ${dependency} has split ${dependencyScenario.split}`);
            }
          }
        } else if (dependencyScenario.split && scenario.split !== dependencyScenario.split) {
          problems.push(scenario.split
            ? `${scenario.id} has split ${scenario.split} but dependency ${dependency} has split ${dependencyScenario.split}`
            : `${scenario.id} runs in every split but dependency ${dependency} has split ${dependencyScenario.split}`);
        }
      }
    }
    for (const item of spec.rubric) {
      const rubricKey = filesystemKey(item.id);
      const foldedRubric = foldedRubricIds.get(rubricKey);
      if (rubricIds.has(item.id)) problems.push(`duplicate rubric id ${item.id}`);
      else if (foldedRubric) problems.push(`rubric ids ${foldedRubric} and ${item.id} collide on case-insensitive filesystems`);
      rubricIds.add(item.id);
      if (!foldedRubric) foldedRubricIds.set(rubricKey, item.id);
      if (["pairwise", "capture", "image-distinctness", "image-regression"].includes(item.grader.type) && !item.scenarios.length) problems.push(`${item.id} requires scenarios`);
      if (new Set(item.scenarios).size !== item.scenarios.length) problems.push(`${item.id} repeats scenario references`);
      if (item.grader.type === "image-distinctness") {
        const count = item.scenarios.reduce((n, id) => n + (spec.scenarios.find(s => s.id === id)?.cases?.length ?? 1), 0);
        if (count < 2 || count > 100) problems.push(`${item.id}: image-distinctness requires 2–100 materialized scenarios`);
      }

      for (const scenarioId of item.scenarios) {
        if (!localScenarios.has(scenarioId)) {
          problems.push(`${item.id} references unknown scenario ${scenarioId} in area ${spec.id}`);
        }
      }
    }
  }
  const requiredWeight = specs.filter((spec) => !spec.optional).reduce((sum, spec) => sum + spec.weight, 0);
  if (Math.abs(requiredWeight - 100) > 0.0001) {
    problems.push(`required area weights must sum to 100; got ${requiredWeight}`);
  }
  if (problems.length) throw new Error(`Spec validation failed:\n  - ${problems.join("\n  - ")}`);
  return specs;
}

export function assertScenarioTargetCompatibility(
  specs: EvalSpec[],
  target: Pick<EvalConfig["target"], "kind" | "url">,
): void {
  const problems: string[] = [];
  for (const spec of specs) {
    for (const scenario of spec.scenarios) {
      const kind = scenario.kind ?? (target.kind === "web" ? "browser" : "workspace");
      if ((kind === "command") !== Boolean(scenario.collect)) problems.push(`${scenario.id}: command mode requires collect, and collect requires command mode`);
      if (scenario.collect && scenario.persona) problems.push(`${scenario.id}: command collectors cannot use browser personas`);
      if (scenario.capture && kind !== "browser") problems.push(`${scenario.id}: capture requires browser mode`);
      if (scenario.capture && scenario.dependsOn.length) problems.push(`${scenario.id}: controlled captures must reset independently and cannot depend on scenarios`);
      if (kind === "browser" && !target.url) {
        problems.push(`${scenario.id} uses browser mode but target.url is not configured`);
      }
      if (!scenario.requiresAuth) continue;
      if (!scenario.persona) problems.push(`${scenario.id} requires authentication but has no persona`);
      if (kind !== "browser") problems.push(`${scenario.id} requires authentication but resolves to workspace mode`);
    }
  }
  if (problems.length) throw new Error(`Scenario target validation failed:\n  - ${problems.join("\n  - ")}`);
}

const executionId = (scenarioId: string, caseId: string) => `${scenarioId}--${caseId}`;

function splitMatches(value: EvalSplit | undefined, selected: EvalSplit | "all"): boolean {
  return selected === "all" || value === undefined || value === selected;
}

/** Expand parameterized cases into stable executable scenarios and rubric references. */
export function materializeSpec(spec: EvalSpec, selectedSplit: EvalSplit | "all" = "all"): EvalSpec {
  const sourceById = new Map(spec.scenarios.map((scenario) => [scenario.id, scenario]));
  const expandedBySource = new Map<string, Scenario[]>();
  const scenarios: Scenario[] = [];
  for (const source of spec.scenarios) {
    const instances: Scenario[] = source.cases?.length
      ? source.cases
          .filter((scenarioCase) => splitMatches(scenarioCase.split ?? source.split, selectedSplit))
          .map((scenarioCase) => ({
            ...source,
            id: executionId(source.id, scenarioCase.id),
            name: scenarioCase.name ? `${source.name} — ${scenarioCase.name}` : `${source.name} — ${scenarioCase.id}`,
            sourceScenarioId: source.id,
            caseId: scenarioCase.id,
            caseVariables: scenarioCase.variables,
            strata: scenarioCase.strata,
            split: scenarioCase.split ?? source.split,
            cases: undefined,
            dependsOn: source.dependsOn.map((dependency) => {
              const dependencySource = sourceById.get(dependency)!;
              return dependencySource.cases?.length ? executionId(dependency, scenarioCase.id) : dependency;
            }),
          }))
      : splitMatches(source.split, selectedSplit)
        ? [{ ...source, sourceScenarioId: source.id, cases: undefined }]
        : [];
    expandedBySource.set(source.id, instances);
    scenarios.push(...instances);
  }
  const rubric: RubricItem[] = spec.rubric.flatMap((item) => {
    if (!item.scenarios.length) return [{ ...item }];
    const references = item.scenarios.flatMap((id) => expandedBySource.get(id)?.map((scenario) => scenario.id) ?? []);
    return references.length ? [{ ...item, scenarios: references }] : [];
  });
  return { ...spec, scenarios, rubric };
}

export function materializeSpecs(specs: EvalSpec[], selectedSplit: EvalSplit | "all" = "all"): EvalSpec[] {
  // A split may legitimately remove every scenario referenced by an area's
  // rubric. That area is outside this execution, not zero-coverage evidence.
  return specs.map((spec) => materializeSpec(spec, selectedSplit)).filter((spec) => spec.rubric.length > 0);
}

export function assertScenarioSelectors(specs: EvalSpec[], ids: string[] | undefined, split: EvalSplit | "all"): void {
  if (!ids?.length) return;
  const knownSelectors = new Set(specs.flatMap((spec) => spec.scenarios.flatMap((scenario) =>
    [scenario.id, scenario.sourceScenarioId].filter((value): value is string => Boolean(value)),
  )));
  const unknown = [...new Set(ids)].filter((id) => !knownSelectors.has(id));
  if (unknown.length) {
    throw new Error(`Unknown scenario selector${unknown.length === 1 ? "" : "s"} for split ${split}: ${unknown.join(", ")}. Known selectors: ${[...knownSelectors].sort().join(", ") || "none"}`);
  }
}

export function selectSpecs(specs: EvalSpec[], ids?: string[], includeOptional = false): EvalSpec[] {
  if (!ids?.length) return specs.filter((spec) => !spec.optional || includeOptional);
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return [...new Set(ids)].map((id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`Unknown area ${id}. Known areas: ${[...byId.keys()].join(", ")}`);
    return found;
  });
}

export function loadFixtures(file?: string): unknown {
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`Fixture file does not exist: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  const fixtures: unknown = /\.ya?ml$/i.test(file) ? YAML.parse(text) : JSON.parse(text);
  if (fixtures === null || typeof fixtures !== "object" || Array.isArray(fixtures)) {
    throw new Error(`Invalid fixtures ${file}: top-level value must be an object`);
  }

  const files = (fixtures as Record<string, unknown>).files;
  if (files === undefined) return fixtures;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(`Invalid fixtures ${file}: files must be an object of name-to-path entries`);
  }

  const problems: string[] = [];
  for (const [name, configuredPath] of Object.entries(files)) {
    if (typeof configuredPath !== "string" || !configuredPath.trim()) {
      problems.push(`files.${name} must be a non-empty path string`);
      continue;
    }
    const resolved = path.resolve(path.dirname(file), configuredPath);
    if (!fs.existsSync(resolved)) {
      problems.push(`files.${name} does not exist: ${resolved}`);
      continue;
    }
    if (!fs.statSync(resolved).isFile()) {
      problems.push(`files.${name} is not a regular file: ${resolved}`);
    }
  }
  if (problems.length) throw new Error(`Fixture validation failed:\n  - ${problems.join("\n  - ")}`);
  return fixtures;
}
