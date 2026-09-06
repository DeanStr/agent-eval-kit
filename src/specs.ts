import { omitUndefinedDeep, omitUndefined } from "./invariants.js";
import { textPairwiseSchema } from "./text/contracts.js";
import {
  pairwiseSchema,
  captureSchema,
  distinctnessSchema,
  imageRegressionSchema,
} from "./visual/contracts.js";
import { collectorSchema } from "./collectors/contracts.js";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { isPortablePathComponent, stableJson } from "./io.js";
import type { EvalConfig, EvalSpec, EvalSplit, RubricItem, Scenario } from "./types.js";

const graderSchema = z.discriminatedUnion("type", [
  pairwiseSchema,
  textPairwiseSchema,
  distinctnessSchema,
  imageRegressionSchema,
  z.object({ type: z.literal("capture") }).strict(),
  z.object({ type: z.literal("llm") }).strict(),
  z
    .object({
      type: z.literal("command"),
      methodFiles: z
        .array(z.string().min(1))
        .max(500)
        .refine((files) => new Set(files).size === files.length, "methodFiles must be unique"),
      output: z.enum(["json", "exit-code"]),
      command: z.string().min(1),
      cwd: z.union([z.literal("project"), z.literal("run"), z.string().min(1)]).optional(),
      timeoutSeconds: z.number().positive().optional(),
    })
    .strict(),
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({
      type: z.literal("hybrid"),
      autoShare: z.number().min(0).max(1).default(0.5),
    })
    .strict(),
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
const strataSchema = z
  .union([
    z.array(z.string().min(1)).transform((value) => [...new Set(value)].sort()),
    z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])).transform((value) =>
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${key}=${String(item)}`),
    ),
  ])
  .default([]);
const scenarioCaseSchema = z
  .object({
    id: artifactIdSchema,
    name: z.string().min(1).optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    strata: strataSchema,
    split: splitSchema.optional(),
  })
  .strict();

const scenarioSchema = z
  .object({
    authenticateEmail: z.boolean().optional(),
    id: artifactIdSchema,
    name: z.string().min(1),
    kind: z.enum(["browser", "workspace", "command"]).optional(),
    persona: z.string().min(1).optional(),
    allowedPersonas: z.array(artifactIdSchema).min(1).max(8).optional(),
    checkpoints: z.record(artifactIdSchema, z.string().trim().min(1)).optional(),
    outputs: z
      .record(
        artifactIdSchema,
        z.object({ type: z.enum(["string", "number", "boolean", "url", "file"]) }).strict(),
      )
      .optional(),
    inputs: z
      .record(
        artifactIdSchema,
        z.object({ from: artifactIdSchema, output: artifactIdSchema }).strict(),
      )
      .optional(),
    instructions: z.string().min(1),
    successSignals: z.array(z.string().min(1)).default([]),
    dependsOn: z.array(z.string().min(1)).default([]),
    requiresAuth: z.boolean().default(false),
    split: splitSchema.optional(),
    cases: z.array(scenarioCaseSchema).min(1).optional(),
    capture: captureSchema.optional(),
    collect: collectorSchema.optional(),
  })
  .strict();

const rubricSchema = z
  .object({
    // Command graders derive artifact filenames from rubric IDs too.
    id: artifactIdSchema,
    criterion: z.string().min(1),
    applicability: z
      .object({ applicable: z.boolean(), reason: z.string().trim().min(1) })
      .strict()
      .optional(),
    checkpoints: z.record(artifactIdSchema, z.array(artifactIdSchema).min(1)).optional(),
    weight: z.number().positive(),
    tags: z.array(z.string().min(1)).default(["general"]),
    scenarios: z.array(z.string().min(1)).default([]),
    grader: graderSchema.default({ type: "llm" }),
    passCriteria: z.string().min(1),
    evidence: z.string().optional(),
    manualInstructions: z.string().optional(),
    gate: z.boolean().default(false),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.gate && item.applicability?.applicable === false) {
      context.addIssue({
        code: "custom",
        path: ["applicability"],
        message: "Critical gates cannot be excluded; change the declared suite policy explicitly",
      });
    }
    if (item.checkpoints && !["llm", "hybrid"].includes(item.grader.type)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoints"],
        message: "Checkpoint selectors require llm or hybrid grading",
      });
    }
    if (item.grader.type === "text-pairwise" && item.scenarios.length) {
      context.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "text-pairwise reads candidate files directly; scenarios must be empty",
      });
    }
    if (
      (item.grader.type === "manual" || item.grader.type === "hybrid") &&
      !item.manualInstructions
    ) {
      context.addIssue({
        code: "custom",
        path: ["manualInstructions"],
        message: `${item.grader.type} grader requires manualInstructions`,
      });
    }
  });

const specSchema = z
  .object({
    id: artifactIdSchema,
    title: z.string().min(1),
    weight: z.number().positive(),
    optional: z.boolean().default(false),
    description: z.string().min(1),
    scenarios: z.array(scenarioSchema).default([]),
    rubric: z.array(rubricSchema).min(1),
  })
  .strict()
  .superRefine((spec, context) => {
    if (
      !spec.scenarios.length &&
      spec.rubric.some((item) => !["command", "manual", "text-pairwise"].includes(item.grader.type))
    ) {
      context.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "This area requires scenarios for its evidence-based graders",
      });
    }
  });

const filesystemKey = (value: string) => value.toLowerCase();
const reservedScenarioArtifactIds = new Set(
  [
    "areas",
    "artifact-index.json",
    "comparisons",
    "collection.json",
    "scoring-definitions",
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
  ].map(filesystemKey),
);

export function loadSpecFile(file: string): EvalSpec {
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  try {
    return omitUndefinedDeep({ ...specSchema.parse(raw), sourceFile: file });
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
  return readSpecs(specsPath, true);
}

/** Selected snapshots keep original weights and validate the collected workflow. */
export function loadSelectedSpecs(specsPath: string, split: EvalSplit | "all"): EvalSpec[] {
  return readSpecs(specsPath, false, split);
}

function readSpecs(
  specsPath: string,
  completeSuite: boolean,
  split: EvalSplit | "all" = "all",
): EvalSpec[] {
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
  const workflowIds = completeSuite
    ? undefined
    : new Set(
        materializeSpecs(specs, split).flatMap((spec) =>
          spec.scenarios.map((scenario) => scenario.sourceScenarioId ?? scenario.id),
        ),
      );
  const inWorkflow = (id: string) => workflowIds === undefined || workflowIds.has(id);
  const areaIds = new Set<string>();
  const foldedAreaIds = new Map<string, string>();
  const scenarioIds = new Set<string>();
  const foldedScenarioIds = new Map<string, string>();
  // Scenario artifacts live directly under the run directory, so executable
  // IDs must be unique across the complete spec set rather than only within an
  // area. Seed this with every source ID first so the result is independent of
  // spec file ordering.
  const sourceExecutableIds = specs.flatMap((spec) =>
    spec.scenarios.map((scenario) => scenario.id),
  );
  const executableIds = new Set(sourceExecutableIds);
  const foldedExecutableIds = new Map<string, string>();
  for (const id of sourceExecutableIds) {
    if (!foldedExecutableIds.has(filesystemKey(id))) foldedExecutableIds.set(filesystemKey(id), id);
  }
  const rubricIds = new Set<string>();
  const foldedRubricIds = new Map<string, string>();
  const problems: string[] = [];
  const allScenarios = new Map(
    specs.flatMap((spec) => spec.scenarios.map((scenario) => [scenario.id, scenario] as const)),
  );
  for (const spec of specs) {
    const foldedArea = foldedAreaIds.get(filesystemKey(spec.id));
    if (areaIds.has(spec.id)) problems.push(`duplicate area id ${spec.id}`);
    else if (foldedArea)
      problems.push(
        `area ids ${foldedArea} and ${spec.id} collide on case-insensitive filesystems`,
      );
    areaIds.add(spec.id);
    if (!foldedArea) foldedAreaIds.set(filesystemKey(spec.id), spec.id);
    const localScenarios = new Set(spec.scenarios.map((scenario) => scenario.id));
    for (const scenario of spec.scenarios) {
      const scenarioKey = filesystemKey(scenario.id);
      const foldedScenario = foldedScenarioIds.get(scenarioKey);
      if (scenarioIds.has(scenario.id)) problems.push(`duplicate scenario id ${scenario.id}`);
      else if (foldedScenario)
        problems.push(
          `scenario ids ${foldedScenario} and ${scenario.id} collide on case-insensitive filesystems`,
        );
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
        if (localCases.has(scenarioCase.id))
          problems.push(`duplicate case id ${scenarioCase.id} in scenario ${scenario.id}`);
        else if (foldedCase)
          problems.push(
            `case ids ${foldedCase} and ${scenarioCase.id} in scenario ${scenario.id} collide on case-insensitive filesystems`,
          );
        localCases.add(scenarioCase.id);
        if (!foldedCase) foldedLocalCases.set(caseKey, scenarioCase.id);
        const expandedId = executionId(scenario.id, scenarioCase.id);
        const expandedKey = filesystemKey(expandedId);
        if (executableIds.has(expandedId) || foldedExecutableIds.has(expandedKey)) {
          problems.push(
            `expanded scenario id ${expandedId} collides with another scenario or case across the spec set (found in area ${spec.id})`,
          );
        }
        if (reservedScenarioArtifactIds.has(expandedKey)) {
          problems.push(
            `expanded scenario id ${expandedId} is reserved by the run artifact layout`,
          );
        }
        executableIds.add(expandedId);
        if (!foldedExecutableIds.has(expandedKey)) foldedExecutableIds.set(expandedKey, expandedId);
      }
      for (const dependency of scenario.dependsOn) {
        if (inWorkflow(scenario.id) && !allScenarios.has(dependency))
          problems.push(`${scenario.id} depends on unknown scenario ${dependency}`);
      }
    }
    for (const scenario of spec.scenarios) {
      if (!inWorkflow(scenario.id)) continue;
      for (const dependency of scenario.dependsOn) {
        const dependencyScenario = allScenarios.get(dependency);
        if (!dependencyScenario) continue;
        if (scenario.cases?.length && dependencyScenario.cases?.length) {
          const dependencyCases = new Map(dependencyScenario.cases.map((item) => [item.id, item]));
          for (const scenarioCase of scenario.cases) {
            const dependencyCase = dependencyCases.get(scenarioCase.id);
            if (!dependencyCase) {
              problems.push(
                `${scenario.id}/${scenarioCase.id} has no matching dependency case ${dependency}/${scenarioCase.id}`,
              );
              continue;
            }
            if (stableJson(scenarioCase.strata) !== stableJson(dependencyCase.strata)) {
              problems.push(
                `${scenario.id}/${scenarioCase.id} has different strata from dependency ${dependency}/${scenarioCase.id}`,
              );
            }
            const scenarioSplit = scenarioCase.split ?? scenario.split;
            const dependencySplit = dependencyCase.split ?? dependencyScenario.split;
            if (dependencySplit && scenarioSplit !== dependencySplit) {
              problems.push(
                scenarioSplit
                  ? `${scenario.id}/${scenarioCase.id} has split ${scenarioSplit} but dependency ${dependency}/${scenarioCase.id} has split ${dependencySplit}`
                  : `${scenario.id}/${scenarioCase.id} runs in every split but dependency ${dependency}/${scenarioCase.id} has split ${dependencySplit}`,
              );
            }
          }
        } else if (!scenario.cases?.length && dependencyScenario.cases?.length) {
          problems.push(
            `${scenario.id} cannot depend on matrix scenario ${dependency} without defining matching cases`,
          );
        } else if (scenario.cases?.length) {
          for (const scenarioCase of scenario.cases) {
            const scenarioSplit = scenarioCase.split ?? scenario.split;
            if (dependencyScenario.split && scenarioSplit !== dependencyScenario.split) {
              problems.push(
                scenarioSplit
                  ? `${scenario.id}/${scenarioCase.id} has split ${scenarioSplit} but dependency ${dependency} has split ${dependencyScenario.split}`
                  : `${scenario.id}/${scenarioCase.id} runs in every split but dependency ${dependency} has split ${dependencyScenario.split}`,
              );
            }
          }
        } else if (dependencyScenario.split && scenario.split !== dependencyScenario.split) {
          problems.push(
            scenario.split
              ? `${scenario.id} has split ${scenario.split} but dependency ${dependency} has split ${dependencyScenario.split}`
              : `${scenario.id} runs in every split but dependency ${dependency} has split ${dependencyScenario.split}`,
          );
        }
      }
    }
    for (const item of spec.rubric) {
      const rubricKey = filesystemKey(item.id);
      const foldedRubric = foldedRubricIds.get(rubricKey);
      if (rubricIds.has(item.id)) problems.push(`duplicate rubric id ${item.id}`);
      else if (foldedRubric)
        problems.push(
          `rubric ids ${foldedRubric} and ${item.id} collide on case-insensitive filesystems`,
        );
      rubricIds.add(item.id);
      if (!foldedRubric) foldedRubricIds.set(rubricKey, item.id);
      if (
        ["pairwise", "capture", "image-distinctness", "image-regression"].includes(
          item.grader.type,
        ) &&
        !item.scenarios.length
      )
        problems.push(`${item.id} requires scenarios`);
      if (new Set(item.scenarios).size !== item.scenarios.length)
        problems.push(`${item.id} repeats scenario references`);
      if (item.grader.type === "image-distinctness") {
        const count = item.scenarios.reduce(
          (n, id) => n + (spec.scenarios.find((s) => s.id === id)?.cases?.length ?? 1),
          0,
        );
        if (count < 2 || count > 100)
          problems.push(`${item.id}: image-distinctness requires 2–100 materialized scenarios`);
      }

      for (const [scenarioId, names] of Object.entries(item.checkpoints ?? {})) {
        if (!item.scenarios.includes(scenarioId))
          problems.push(`${item.id}: checkpoint scenario ${scenarioId} must be in scenarios`);
        if (new Set(names).size !== names.length)
          problems.push(`${item.id}: duplicate checkpoint selectors`);
        for (const name of names)
          if (
            !Object.hasOwn(spec.scenarios.find((s) => s.id === scenarioId)?.checkpoints ?? {}, name)
          )
            problems.push(`${item.id}: unknown checkpoint ${scenarioId}.${name}`);
      }
      for (const scenarioId of item.scenarios) {
        if (!localScenarios.has(scenarioId)) {
          problems.push(`${item.id} references unknown scenario ${scenarioId} in area ${spec.id}`);
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) {
      problems.push(`Scenario dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of allScenarios.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const scenario of allScenarios.values()) {
    if (inWorkflow(scenario.id)) visit(scenario.id);
    for (const [name, binding] of Object.entries(
      inWorkflow(scenario.id) ? (scenario.inputs ?? {}) : {},
    )) {
      if (!scenario.dependsOn.includes(binding.from))
        problems.push(
          `${scenario.id}.inputs.${name}: ${binding.from} must be declared in dependsOn`,
        );
      if (!Object.hasOwn(allScenarios.get(binding.from)?.outputs ?? {}, binding.output))
        problems.push(
          `${scenario.id}.inputs.${name}: unknown output ${binding.from}.${binding.output}`,
        );
    }
    if (scenario.allowedPersonas) {
      if (new Set(scenario.allowedPersonas).size !== scenario.allowedPersonas.length)
        problems.push(`${scenario.id}: allowedPersonas must be unique`);
      if (!scenario.allowedPersonas.includes(scenario.persona ?? "anonymous"))
        problems.push(
          `${scenario.id}: allowedPersonas must include the starting persona (or anonymous)`,
        );
    }
  }
  const requiredWeight = specs
    .filter((spec) => !spec.optional)
    .reduce((sum, spec) => sum + spec.weight, 0);
  if (completeSuite && Math.abs(requiredWeight - 100) > 0.0001) {
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
  const scenarios = new Map(specs.flatMap((spec) => spec.scenarios.map((s) => [s.id, s] as const)));
  for (const spec of specs) {
    for (const scenario of spec.scenarios) {
      const kind = scenario.kind ?? (target.kind === "web" ? "browser" : "workspace");
      if (
        scenario.authenticateEmail &&
        (kind !== "browser" ||
          scenario.capture ||
          scenario.allowedPersonas ||
          scenario.requiresAuth ||
          !scenario.persona ||
          scenario.persona === "anonymous")
      )
        problems.push(
          `${scenario.id}: authenticateEmail requires a single named browser persona, without requiresAuth, capture or allowedPersonas; capture other personas with aek auth --email first`,
        );
      if (
        kind === "workspace" &&
        Object.values(scenario.outputs ?? {}).some((o) => o.type === "file")
      )
        problems.push(
          `${scenario.id}: file outputs require browser downloads or command collection`,
        );
      for (const [name, binding] of Object.entries(scenario.inputs ?? {}))
        if (
          kind !== "command" &&
          scenarios.get(binding.from)?.outputs?.[binding.output]?.type === "file"
        )
          problems.push(
            `${scenario.id}: file input ${name} requires command collection to access retained bytes`,
          );
      if ((kind === "command") !== Boolean(scenario.collect))
        problems.push(
          `${scenario.id}: command mode requires collect, and collect requires command mode`,
        );
      if (scenario.capture && (scenario.outputs || scenario.inputs || scenario.checkpoints))
        problems.push(
          `${scenario.id}: controlled captures cannot declare workflow bindings or checkpoints`,
        );
      if (scenario.allowedPersonas && (kind !== "browser" || scenario.capture))
        problems.push(`${scenario.id}: allowedPersonas requires agent-driven browser collection`);
      if (scenario.collect && scenario.persona)
        problems.push(`${scenario.id}: command collectors cannot use browser personas`);
      if (scenario.capture && kind !== "browser")
        problems.push(`${scenario.id}: capture requires browser mode`);
      if (scenario.capture && scenario.dependsOn.length)
        problems.push(
          `${scenario.id}: controlled captures must reset independently and cannot depend on scenarios`,
        );
      if (kind === "browser" && !target.url) {
        problems.push(`${scenario.id} uses browser mode but target.url is not configured`);
      }
      if (!scenario.requiresAuth) continue;
      if (scenario.persona === "anonymous")
        problems.push(`${scenario.id}: anonymous cannot require authentication`);
      if (!scenario.persona)
        problems.push(`${scenario.id} requires authentication but has no persona`);
      if (kind !== "browser")
        problems.push(`${scenario.id} requires authentication but resolves to workspace mode`);
    }
  }
  if (problems.length)
    throw new Error(`Scenario target validation failed:\n  - ${problems.join("\n  - ")}`);
}

export function assertEmailConfiguration(specs: EvalSpec[], config: EvalConfig): void {
  for (const scenario of specs.flatMap((spec) => spec.scenarios)) {
    if (!scenario.authenticateEmail) continue;
    const flow = scenario.persona && config.emailAuth?.[scenario.persona];
    if (!flow || !Object.hasOwn(config.mailboxes ?? {}, flow.mailbox))
      throw new Error(
        `${scenario.id}: configure emailAuth for persona ${scenario.persona} and its mailbox`,
      );
  }
}

const executionId = (scenarioId: string, caseId: string) => `${scenarioId}--${caseId}`;

function splitMatches(value: EvalSplit | undefined, selected: EvalSplit | "all"): boolean {
  return selected === "all" || value === undefined || value === selected;
}

/** Expand parameterized cases into stable executable scenarios and rubric references. */
export function materializeSpec(
  spec: EvalSpec,
  selectedSplit: EvalSplit | "all" = "all",
  suite: EvalSpec[] = [spec],
): EvalSpec {
  const sourceById = new Map(
    suite.flatMap((area) => area.scenarios.map((scenario) => [scenario.id, scenario] as const)),
  );
  const dependencyInstance = (id: string, caseId: string): string => {
    const dependency = sourceById.get(id);
    if (!dependency)
      throw new Error(
        `Cannot expand dependency ${id}: its scenario is outside the supplied suite. Include the prerequisite area.`,
      );
    return dependency.cases?.length ? executionId(id, caseId) : id;
  };
  const expandedBySource = new Map<string, Scenario[]>();
  const scenarios: Scenario[] = [];
  for (const source of spec.scenarios) {
    const instances: Scenario[] = source.cases?.length
      ? source.cases
          .filter((scenarioCase) => splitMatches(scenarioCase.split ?? source.split, selectedSplit))
          .map((scenarioCase) =>
            omitUndefined({
              ...source,
              id: executionId(source.id, scenarioCase.id),
              name: scenarioCase.name
                ? `${source.name} — ${scenarioCase.name}`
                : `${source.name} — ${scenarioCase.id}`,
              sourceScenarioId: source.id,
              caseId: scenarioCase.id,
              caseVariables: scenarioCase.variables,
              strata: scenarioCase.strata,
              split: scenarioCase.split ?? source.split,
              cases: undefined,
              inputs: source.inputs
                ? Object.fromEntries(
                    Object.entries(source.inputs).map(([name, binding]) => [
                      name,
                      {
                        ...binding,
                        from: dependencyInstance(binding.from, scenarioCase.id),
                      },
                    ]),
                  )
                : undefined,
              dependsOn: source.dependsOn.map((dependency) =>
                dependencyInstance(dependency, scenarioCase.id),
              ),
            }),
          )
      : splitMatches(source.split, selectedSplit)
        ? [omitUndefined({ ...source, sourceScenarioId: source.id, cases: undefined })]
        : [];
    expandedBySource.set(source.id, instances);
    scenarios.push(...instances);
  }
  const rubric: RubricItem[] = spec.rubric.flatMap((item) => {
    if (item.applicability?.applicable === false) return [];
    if (!item.scenarios.length) return [{ ...item }];
    const references = item.scenarios.flatMap(
      (id) => expandedBySource.get(id)?.map((scenario) => scenario.id) ?? [],
    );
    return references.length
      ? [
          {
            ...item,
            scenarios: references,
            ...(item.checkpoints
              ? {
                  checkpoints: Object.fromEntries(
                    Object.entries(item.checkpoints).flatMap(([id, names]) =>
                      (expandedBySource.get(id) ?? []).map((s) => [s.id, names]),
                    ),
                  ),
                }
              : {}),
          },
        ]
      : [];
  });
  const exclusions = [
    ...(spec.exclusions ?? []),
    ...spec.rubric
      .filter((item) => item.applicability?.applicable === false)
      .map((item) => ({ id: item.id, weight: item.weight, reason: item.applicability!.reason })),
  ];
  return { ...spec, scenarios, rubric, ...(exclusions.length ? { exclusions } : {}) };
}

export function materializeSpecs(
  specs: EvalSpec[],
  selectedSplit: EvalSplit | "all" = "all",
): EvalSpec[] {
  // Plan with source IDs first: resolving dependencies of an unused matrix can
  // otherwise demand an area that the executable workflow does not need.
  const active = specs.map((spec) => ({
    ...spec,
    exclusions: [
      ...(spec.exclusions ?? []),
      ...spec.rubric
        .filter((item) => item.applicability?.applicable === false)
        .map((item) => ({ id: item.id, weight: item.weight, reason: item.applicability!.reason })),
    ],
    rubric: spec.rubric.filter((item) => item.applicability?.applicable !== false),
    scenarios: spec.scenarios.filter((scenario) =>
      scenario.cases?.length
        ? scenario.cases.some((item) => splitMatches(item.split ?? scenario.split, selectedSplit))
        : splitMatches(scenario.split, selectedSplit),
    ),
  }));
  const scored = new Set(
    active
      .filter((spec) =>
        spec.rubric.some(
          (item) =>
            !item.scenarios.length ||
            item.scenarios.some((id) => spec.scenarios.some((scenario) => scenario.id === id)),
        ),
      )
      .map((spec) => spec.id),
  );
  const byId = new Map(
    active.flatMap((spec) => spec.scenarios.map((scenario) => [scenario.id, scenario] as const)),
  );
  const required = new Set<string>();
  function include(id: string): void {
    if (required.has(id)) return;
    const scenario = byId.get(id);
    if (!scenario)
      throw new Error(
        `Required scenario ${id} is outside the selected areas/split. Include its prerequisite area and matching split.`,
      );
    required.add(id);
    scenario.dependsOn.forEach(include);
  }
  for (const spec of active)
    if (scored.has(spec.id))
      spec.scenarios.forEach((scenario) => {
        const source = specs.find((source) => source.id === spec.id)!;
        const onlyExcluded =
          source.rubric.some(
            (item) =>
              item.applicability?.applicable === false && item.scenarios.includes(scenario.id),
          ) &&
          !spec.rubric.some(
            (item) =>
              (!item.scenarios.length && ["llm", "hybrid"].includes(item.grader.type)) ||
              item.scenarios.includes(scenario.id),
          );
        if (!onlyExcluded) include(scenario.id);
      });
  // Areas without scoring items contribute only prerequisites, never score weight.
  return active.flatMap((spec) => {
    if (scored.has(spec.id))
      return [
        materializeSpec(
          { ...spec, scenarios: spec.scenarios.filter((scenario) => required.has(scenario.id)) },
          selectedSplit,
          specs,
        ),
      ];
    const scenarios = spec.scenarios.filter((scenario) => required.has(scenario.id));
    return scenarios.length || spec.exclusions.length
      ? [materializeSpec({ ...spec, scenarios, rubric: [] }, selectedSplit, specs)]
      : [];
  });
}

export function assertScenarioSelectors(
  specs: EvalSpec[],
  ids: string[] | undefined,
  split: EvalSplit | "all",
): void {
  if (!ids?.length) return;
  const knownSelectors = new Set(
    specs.flatMap((spec) =>
      spec.scenarios.flatMap((scenario) =>
        [scenario.id, scenario.sourceScenarioId].filter((value): value is string => Boolean(value)),
      ),
    ),
  );
  const unknown = [...new Set(ids)].filter((id) => !knownSelectors.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown scenario selector${unknown.length === 1 ? "" : "s"} for split ${split}: ${unknown.join(", ")}. Known selectors: ${[...knownSelectors].sort().join(", ") || "none"}`,
    );
  }
}

export function selectSpecs(
  specs: EvalSpec[],
  ids?: string[],
  includeOptional = false,
): EvalSpec[] {
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
  if (problems.length)
    throw new Error(`Fixture validation failed:\n  - ${problems.join("\n  - ")}`);
  return fixtures;
}
