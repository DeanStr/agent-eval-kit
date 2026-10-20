import type { RunOptions } from "./runner.js";
import type { EvalSpec } from "./types.js";
import { defaultTextVoting } from "./text/contracts.js";
import { textInstances } from "./text/datasets.js";
import { requiredCheckpointNames } from "./checkpoints.js";
import { requireDefined } from "./invariants.js";

/** Describe the materialized execution without probing providers or starting the target. */
export function buildExecutionPlan(options: RunOptions, specs: EvalSpec[]) {
  const { config } = options;
  const selected = (scenario: EvalSpec["scenarios"][number]) =>
    !options.scenarioIds?.length ||
    options.scenarioIds.includes(scenario.id) ||
    Boolean(scenario.sourceScenarioId && options.scenarioIds.includes(scenario.sourceScenarioId));
  const declarations = new Map(
    specs.flatMap((spec) => spec.scenarios.map((s) => [s.id, s] as const)),
  );
  const order: string[] = [];
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const scenario = declarations.get(id)!;
    if (!selected(scenario)) return;
    for (const dependency of scenario.dependsOn) visit(dependency);
    order.push(id);
  }
  for (const spec of specs)
    if (spec.rubric.length) for (const scenario of spec.scenarios) visit(scenario.id);
  const blocked = new Set<string>();
  for (const id of order) {
    if (declarations.get(id)!.dependsOn.some((dep) => !order.includes(dep) || blocked.has(dep)))
      blocked.add(id);
  }
  const steps: Array<{ area: string; kind: "collector" | "command" | "grading"; ids: string[] }> =
    [];
  const emitted = new Set<string>();
  const owners = new Map(
    specs.flatMap((spec) => spec.scenarios.map((s) => [s.id, spec.id] as const)),
  );
  function emit(id: string): void {
    if (emitted.has(id) || !order.includes(id)) return;
    emitted.add(id);
    for (const dependency of declarations.get(id)!.dependsOn) emit(dependency);
    steps.push({ area: owners.get(id)!, kind: "collector", ids: [id] });
  }
  let minimum = 0,
    maximum = 0;
  const areas = specs.map((spec) => {
    if (spec.rubric.length) for (const scenario of spec.scenarios) emit(scenario.id);
    const ordinary = spec.rubric.filter(
      (item) =>
        item.grader.type === "llm" || (item.grader.type === "hybrid" && item.grader.autoShare > 0),
    );
    const judgeGroups: Array<{ ids: string[]; minimum: number; maximum: number }> = [];
    if (!options.collectOnly && ordinary.length)
      judgeGroups.push({
        ids: ordinary.map((i) => i.id),
        minimum: config.judge.voting?.minimumVotes ?? 1,
        maximum: config.judge.voting?.maximumVotes ?? 1,
      });
    const graders = spec.rubric.map((item) => {
      const grader = item.grader;
      const cases = item.dataset
        ? requireDefined(
            spec.datasets?.[item.dataset],
            `${spec.id}/${item.id} dataset ${item.dataset}`,
          ).map((c) => ({
            id: `${spec.id}/${item.dataset}/${c.id}`,
            selected:
              options.textCaseIds === undefined ||
              options.textCaseIds.includes(`${spec.id}/${item.dataset}/${c.id}`),
          }))
        : [];
      if (!options.collectOnly && grader.type === "pairwise") {
        const comparisons =
          item.scenarios.filter((id) => order.includes(id) && !blocked.has(id)).length *
          grader.references.length;
        judgeGroups.push({
          ids: [item.id],
          minimum: comparisons * grader.voting.minimumVotes,
          maximum: comparisons * grader.voting.maximumVotes,
        });
      }
      if (
        !options.collectOnly &&
        (grader.type === "text-pairwise" || grader.type === "text-rubric")
      ) {
        const policy = grader.voting ?? config.judge.voting ?? defaultTextVoting;
        const instances = textInstances(spec, item).filter(
          (instance) =>
            !instance.case ||
            options.textCaseIds === undefined ||
            options.textCaseIds.includes(`${spec.id}/${item.dataset}/${instance.case.id}`),
        );
        const comparisons =
          instances.length * (grader.type === "text-pairwise" ? grader.references.length : 1);
        judgeGroups.push({
          ids: [item.id],
          minimum: comparisons * policy.minimumVotes,
          maximum: comparisons * policy.maximumVotes,
        });
      }
      if (grader.type === "command") steps.push({ area: spec.id, kind: "command", ids: [item.id] });
      return {
        id: item.id,
        type: grader.type,
        weight: item.weight,
        gate: Boolean(item.gate),
        scenarios: item.scenarios,
        status:
          options.collectOnly && grader.type !== "command"
            ? "deferred"
            : grader.type === "manual" || (grader.type === "hybrid" && grader.autoShare === 0)
              ? "manual"
              : "planned",
        ...(grader.type === "hybrid"
          ? { autoShare: grader.autoShare, manualShare: 1 - grader.autoShare }
          : {}),
        ...(grader.type === "command"
          ? {
              command: grader.command,
              cwd: grader.cwd ?? "project",
              timeoutSeconds: grader.timeoutSeconds ?? 300,
              output: grader.output,
              methodFiles: grader.methodFiles,
            }
          : {}),
        ...(cases.length ? { cases } : {}),
      };
    });
    if (!options.collectOnly && spec.rubric.some((item) => item.grader.type !== "command"))
      steps.push({
        area: spec.id,
        kind: "grading",
        ids: spec.rubric.filter((item) => item.grader.type !== "command").map((item) => item.id),
      });
    for (const group of judgeGroups) {
      minimum += group.minimum;
      maximum += group.maximum;
    }
    return {
      id: spec.id,
      title: spec.title,
      weight: spec.weight,
      optional: spec.optional,
      scenarios: spec.scenarios
        .filter((s) => order.includes(s.id))
        .map((scenario) => ({
          id: scenario.id,
          name: scenario.name,
          sourceScenarioId: scenario.sourceScenarioId ?? null,
          caseId: scenario.caseId ?? null,
          split: scenario.split ?? null,
          strata: scenario.strata ?? [],
          kind: scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace"),
          collector: scenario.collect
            ? "command"
            : scenario.capture
              ? "controlled-capture"
              : "agent",
          status: blocked.has(scenario.id) ? "blocked-by-selection" : "planned",
          dependsOn: scenario.dependsOn,
          inputs: scenario.inputs ?? {},
          outputs: scenario.outputs ?? {},
          checkpoints: scenario.checkpoints ?? {},
          requiredCheckpoints: requiredCheckpointNames(spec.rubric, scenario.id),
          persona: scenario.persona ?? null,
          requiresAuth: scenario.requiresAuth,
          allowedPersonas: scenario.allowedPersonas ?? [],
          authenticateEmail: Boolean(scenario.authenticateEmail),
          ...(scenario.collect
            ? {
                command: scenario.collect.command,
                cwd: config.project.root,
                timeoutSeconds: scenario.collect.timeoutSeconds,
                methodFiles: scenario.collect.methodFiles,
                sources: scenario.collect.sources,
                images: scenario.collect.images,
                files: scenario.collect.files ?? [],
              }
            : {}),
          ...(scenario.capture ? { capture: scenario.capture } : {}),
        })),
      skippedScenarios: spec.scenarios.filter((s) => !order.includes(s.id)).map((s) => s.id),
      graders,
      exclusions: spec.exclusions ?? [],
      judgeGroups,
    };
  });
  const active = order.filter((id) => !blocked.has(id)).map((id) => declarations.get(id)!);
  const selectedDeclarations = [...declarations.values()].filter(selected);
  const agentInvocations = active.filter((s) => !s.capture && !s.collect).length;
  // Receipts record provider/browser versions even when filtering prevents calls.
  const agentRequired =
    !options.collectOnly || selectedDeclarations.some((s) => !s.capture && !s.collect);
  const judgeRequired =
    !options.collectOnly &&
    specs.some((spec) =>
      spec.rubric.some(
        (item) =>
          ["llm", "pairwise", "text-pairwise", "text-rubric"].includes(item.grader.type) ||
          (item.grader.type === "hybrid" && item.grader.autoShare > 0),
      ),
    );
  const usesBrowser = (s: EvalSpec["scenarios"][number]) =>
    !s.collect &&
    (Boolean(s.capture) || config.agent.provider !== "mock") &&
    (s.kind ?? (config.target.kind === "web" ? "browser" : "workspace")) === "browser";
  const browserRequired = selectedDeclarations.some(usesBrowser);
  const command = (value: typeof config.target.setup, phase: "setup" | "start") =>
    value
      ? {
          command: value.command,
          cwd: value.cwd ?? config.project.root,
          environmentVariables: Object.keys(value.env ?? {}),
          timeoutSeconds: phase === "setup" ? (value.timeoutSeconds ?? 600) : null,
        }
      : null;
  return {
    version: 2,
    mode: options.previewRepetitions ? "campaign" : options.collectOnly ? "collect" : "run",
    repetitions: options.previewRepetitions ?? 1,
    project: config.project.name,
    suite: config.suite ?? null,
    split: options.split ?? "development",
    target: {
      kind: config.target.kind,
      url: config.target.url ?? null,
      setup: command(config.target.setup, "setup"),
      start: command(config.target.start, "start"),
      ready: config.target.ready ?? null,
      allowExternalServer: config.target.allowExternalServer ?? false,
      fingerprintExclusions: config.target.fingerprint?.exclude ?? [],
    },
    services: {
      browser: {
        required: browserRequired,
        collectionPlanned: active.some(usesBrowser),
        engine: "chromium",
        headless: config.browser.headless,
        viewport: config.browser.viewport,
      },
      providers: [
        ...(agentRequired
          ? [
              {
                role: "agent",
                purpose: agentInvocations ? "collection-and-version" : "version-only",
                plannedInvocations: agentInvocations,
                provider: config.agent.provider,
                model: config.agent.model ?? null,
                effort: config.agent.effort ?? null,
                timeoutSeconds: config.agent.timeoutSeconds,
                maxTurns: config.agent.maxTurns ?? (config.agent.provider === "codex" ? 50 : null),
              },
            ]
          : []),
        ...(judgeRequired
          ? [
              {
                role: "judge",
                purpose: maximum ? "judging-and-version" : "version-only",
                provider: config.judge.provider,
                model: config.judge.model ?? null,
                effort: config.judge.effort ?? null,
                timeoutSeconds: config.judge.timeoutSeconds,
                maxTurns:
                  config.judge.provider === "codex" ? null : (config.judge.maxTurns ?? null),
              },
            ]
          : []),
      ],
      emailPersonas: [...new Set(active.filter((s) => s.authenticateEmail).map((s) => s.persona!))],
      savedPersonas: [
        ...new Set(
          active.flatMap(
            (s) =>
              s.allowedPersonas?.filter((p) => p !== "anonymous") ??
              (s.requiresAuth && s.persona ? [s.persona] : []),
          ),
        ),
      ],
    },
    executionOrder: steps,
    judgeCalls: {
      minimum: minimum * (options.previewRepetitions ?? 1),
      maximum: maximum * (options.previewRepetitions ?? 1),
      perRepetition: { minimum, maximum },
      basis:
        "Conditional range for fresh execution with all required evidence available. Blocking, missing evidence, errors, or adaptive stopping can reduce calls; mock invocations use no model quota.",
    },
    areas,
  };
}

export function formatExecutionPlan(plan: ReturnType<typeof buildExecutionPlan>): string {
  const lines = [
    `${plan.project}: ${plan.mode}, split ${plan.split}, ${plan.repetitions} repetition(s)`,
    `Target: ${plan.target.kind}${plan.target.url ? ` ${plan.target.url}` : ""}`,
  ];
  if (plan.target.fingerprintExclusions.length)
    lines.push(`Target fingerprint excludes: ${plan.target.fingerprintExclusions.join(", ")}`);
  for (const phase of ["setup", "start"] as const)
    if (plan.target[phase]) lines.push(`${phase}: ${plan.target[phase].command}`);
  if (plan.target.ready) lines.push(`ready: ${plan.target.ready.url ?? plan.target.ready.command}`);
  lines.push(`Chromium: ${plan.services.browser.required ? "required" : "not required"}`);
  for (const provider of plan.services.providers)
    lines.push(
      `${provider.role}: ${provider.provider}${provider.model ? `/${provider.model}` : ""} (${provider.purpose})`,
    );
  if (plan.services.savedPersonas.length)
    lines.push(`Saved authentication required: ${plan.services.savedPersonas.join(", ")}`);
  if (plan.services.emailPersonas.length)
    lines.push(`Email authentication: ${plan.services.emailPersonas.join(", ")}`);
  for (const area of plan.areas)
    lines.push(
      `Area ${area.id}: ${area.title}, weight ${area.weight}${area.optional ? " (optional)" : ""}`,
    );
  for (const step of plan.executionOrder) {
    lines.push(`${step.area}: ${step.kind} ${step.ids.join(", ")}`);
    const area = plan.areas.find((a) => a.id === step.area)!;
    for (const id of step.ids) {
      const entry =
        step.kind === "collector"
          ? area.scenarios.find((s) => s.id === id)!
          : area.graders.find((g) => g.id === id)!;
      const kind = "kind" in entry ? entry.kind : entry.type;
      const weight = "weight" in entry ? ` w${entry.weight}${entry.gate ? " GATE" : ""}` : "";
      lines.push(
        `  ${entry.id} [${kind}]${weight}: ${entry.status}${entry.command ? ` — ${entry.command}` : ""}`,
      );
      if ("dependsOn" in entry && entry.dependsOn.length)
        lines.push(`    depends on: ${entry.dependsOn.join(", ")}`);
      if ("requiredCheckpoints" in entry && entry.requiredCheckpoints.length)
        lines.push(`    required checkpoints: ${entry.requiredCheckpoints.join(", ")}`);
      if ("images" in entry && entry.images?.length)
        lines.push(`    images: ${entry.images.join(", ")}`);
      if ("files" in entry && entry.files?.length)
        lines.push(`    files: ${entry.files.join(", ")}`);
    }
  }
  for (const area of plan.areas) {
    for (const id of area.skippedScenarios) lines.push(`${area.id}: skipped scenario ${id}`);
    for (const grader of area.graders) {
      for (const c of grader.cases ?? []) lines.push(`  ${c.selected ? ">" : "~"} ${c.id} [text]`);
      if (grader.status === "deferred")
        lines.push(`${area.id}: ${grader.id} [${grader.type}] deferred until judge`);
    }
    for (const item of area.exclusions)
      lines.push(`${area.id}: ${item.id} EXCLUDED: ${item.reason}`);
  }
  lines.push(
    `Judge calls: ${plan.judgeCalls.minimum}–${plan.judgeCalls.maximum}`,
    plan.judgeCalls.basis,
  );
  return lines.join("\n");
}
