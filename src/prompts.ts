import type { EvalConfig, EvalSpec, RubricItem, Scenario, ScenarioEvidence } from "./types.js";

export interface CaseJudgeRequest {
  rubricId: string;
  caseId: string;
  scenarioIds: string[];
  strata: string[];
  split?: "development" | "evaluation";
}

export function caseJudgeRequests(items: RubricItem[], evidence: ScenarioEvidence[]): CaseJudgeRequest[] {
  return items.flatMap((item) => {
    if (!item.scenarios.length) return [];
    const relevant = evidence.filter((scenario) => item.scenarios.includes(scenario.scenarioId));
    const shared = relevant.filter((scenario) => !scenario.caseId);
    const byCase = new Map<string, ScenarioEvidence[]>();
    for (const scenario of relevant) {
      if (!scenario.caseId) continue;
      const members = byCase.get(scenario.caseId) ?? [];
      members.push(scenario);
      byCase.set(scenario.caseId, members);
    }
    if (!byCase.size) {
      return [{
        rubricId: item.id,
        caseId: "default",
        scenarioIds: relevant.map((scenario) => scenario.scenarioId),
        strata: [...new Set(relevant.flatMap((scenario) => scenario.strata ?? []))].sort(),
        split: relevant.map((scenario) => scenario.split).find(Boolean),
      }];
    }

    return [...byCase.entries()].sort(([left], [right]) => left.localeCompare(right)).flatMap(([caseId, members]) => {
      const byIdentity = new Map<string, ScenarioEvidence[]>();
      for (const scenario of members) {
        const identity = JSON.stringify({
          strata: [...new Set(scenario.strata ?? [])].sort(),
          split: scenario.split,
        });
        const matching = byIdentity.get(identity) ?? [];
        matching.push(scenario);
        byIdentity.set(identity, matching);
      }
      const disambiguate = byIdentity.size > 1;
      return [...byIdentity.values()]
        .map((caseMembers) => {
          const sources = [...new Set(caseMembers.map((scenario) => scenario.sourceScenarioId ?? scenario.scenarioId))].sort();
          const allMembers = [...shared, ...caseMembers];
          return {
            rubricId: item.id,
            caseId: disambiguate ? `${sources.join("+")}/${caseId}` : caseId,
            scenarioIds: allMembers.map((scenario) => scenario.scenarioId),
            strata: [...new Set(caseMembers.flatMap((scenario) => scenario.strata ?? []))].sort(),
            split: caseMembers.map((scenario) => scenario.split).find(Boolean),
          };
        })
        .sort((left, right) => left.caseId.localeCompare(right.caseId));
    });
  });
}

export function scenarioPrompt(options: {
  config: EvalConfig;
  spec: EvalSpec;
  scenario: Scenario;
  kind: "browser" | "workspace";
  fixtures: unknown;
}): string {
  const { config, spec, scenario, kind, fixtures } = options;
  const variables = { ...config.variables, ...(scenario.caseVariables ?? {}) };
  const target = config.target.url
    ? `Web target: ${config.target.url}`
    : `Project source is available only through the read-only aek workspace MCP.`;
  const modeRules =
    kind === "browser"
      ? `Use the aek browser MCP tools for all interaction. Start with navigate. Use fresh snapshot refs literally; refs expire after page changes. Stay within the configured origin allowlist. Capture screenshots of meaningful before/after/result states, record factual observations as you go, and finish by calling done. Do not use shell or file tools to inspect the app implementation: this is a black-box evaluation.`
      : `Use the aek workspace MCP tools for all project inspection. Start with list_files, then use search and bounded read_file calls. Do not use shell or built-in file tools: the MCP is the evidence boundary. It cannot edit or execute the project. Put executable assertions in command graders. Cite project-relative file:line references that support each observation, record observations as you go, and finish by calling done.`;

  return [
    `You are an evidence-collection agent evaluating a project. You are not the judge and must not award scores.`,
    `Adapt navigation and terminology to the project, but never claim an outcome you did not observe.`,
    `Distinguish feature_not_found (you searched credible paths and it is absent) from blocked (authentication, crash, permissions, or harness failure prevented the check).`,
    `Be persistent but bounded. Prefer high-value evidence over exhaustive exploration.`,
    modeRules,
    config.instructions ? `Project-wide evaluator instructions:\n${config.instructions}` : "",
    `TARGET_KIND: ${config.target.kind}`,
    target,
    `AREA: ${spec.title} (${spec.id})`,
    `SCENARIO_ID: ${scenario.id}`,
    scenario.sourceScenarioId ? `SCENARIO_TEMPLATE_ID: ${scenario.sourceScenarioId}` : "",
    scenario.caseId ? `CASE_ID: ${scenario.caseId}` : "",
    `SCENARIO: ${scenario.name}`,
    scenario.persona ? `PERSONA: ${scenario.persona}` : "",
    scenario.requiresAuth
      ? `AUTH: a saved browser session is expected for this persona. If it has expired, record blocked rather than treating the logged-out view as product absence.`
      : "",
    `INSTRUCTIONS:\n${scenario.instructions}`,
    scenario.successSignals.length
      ? `SUCCESS SIGNALS TO SEEK (not assumptions):\n- ${scenario.successSignals.join("\n- ")}`
      : "",
    `FIXTURES / VARIABLES:\n${JSON.stringify({ fixtures, variables }, null, 2)}`,
    `At the end, return only the required structured object. Its observations and evidenceRefs must agree with the evidence you actually collected.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function compactEvidence(evidence: ScenarioEvidence[], attachments: Record<string, string>): unknown[] {
  return evidence.map((scenario) => ({
    recordRef: `${scenario.scenarioId}/evidence.json`,
    scenarioId: scenario.scenarioId,
    sourceScenarioId: scenario.sourceScenarioId,
    caseId: scenario.caseId,
    name: scenario.scenarioName,
    collector: scenario.collector ?? "agent",
    captureChecks: scenario.captureChecks,
    browserDiagnostics: scenario.diagnostics,
    outcome: scenario.outcome,
    summary: scenario.summary,
    observations: scenario.observations.map((text, index) => ({
      ref: `${scenario.scenarioId}/evidence.json#observation-${index + 1}`,
      text,
    })),
    collectorEvidenceRefs: scenario.evidenceRefs,
    screenshots: scenario.screenshots.map((shot) => {
      const ref = `${scenario.scenarioId}/${shot.path}`;
      return {
        ...shot,
        ref,
        visualAvailable: Boolean(attachments[ref]),
        attachment: attachments[ref],
      };
    }),
    finalUrl: scenario.finalUrl,
    error: scenario.error,
    transcript: scenario.transcript.map((entry) => ({
      ref: `${scenario.scenarioId}/${scenario.kind}-transcript.ndjson#step-${entry.step}`,
      step: entry.step,
      tool: entry.tool,
      input: entry.input,
      result: entry.result.slice(0, 2_000),
      isError: entry.isError,
    })),
  }));
}

export function canonicalEvidenceRefs(evidence: ScenarioEvidence[]): Set<string> {
  return new Set(evidence.flatMap((scenario) => [
    `${scenario.scenarioId}/evidence.json`,
    ...scenario.observations.map((_text, index) => `${scenario.scenarioId}/evidence.json#observation-${index + 1}`),
    ...scenario.screenshots.map((shot) => `${scenario.scenarioId}/${shot.path}`),
    ...scenario.transcript.map((entry) => `${scenario.scenarioId}/${scenario.kind}-transcript.ndjson#step-${entry.step}`),
  ]));
}

export function judgePrompt(options: {
  config: EvalConfig;
  spec: EvalSpec;
  items: RubricItem[];
  evidence: ScenarioEvidence[];
  attachments?: Record<string, string>;
  screenshotAccess?: "attached" | "mcp" | "none";
}): string {
  const { config, spec, items, evidence } = options;
  const caseRequests = caseJudgeRequests(items, evidence);
  return [
    `You are an impartial software evaluator. Judge the stated criterion, including visible quality when explicitly requested. Do not substitute visual resemblance or implementation style for functional correctness.`,
    `Use only the supplied evidence. Do not inspect the target again, browse the web, or repair missing evidence.`,
    `Verdicts: pass = clearly meets the full pass criteria; partial = works with a material named gap; fail = the supplied evidence demonstrates a criterion violation through observed incorrect behavior or a concrete defect in an explicitly source-level criterion; not_found = the evidence collector credibly searched and found no capability; cannot_judge = evidence is insufficient or the collector was blocked.`,
    `For criteria explicitly about source code, directly inspected code and a logically complete counterexample may prove a defect without execution. Identify the relevant source lines and distinguish a static deduction from an observed runtime result. Do not apply this exception to runtime, integration, or persistence claims.`,
    `A form or code symbol existing is not proof the workflow works. Require persisted outputs, command results, or before/after states when the criterion calls for them.`,
    `Still images establish only the visible sampled states, not continuous motion, sound, interaction, or runtime correctness. Collector extraction descriptions and adapter metrics are instrumented claims; source hashes establish artifact identity, not the truth of those claims.`,
    `Every verdict needs concrete evidenceRefs. Never turn an agent/harness timeout, missing authentication, or low evidence coverage into a product defect.`,
    `Copy evidenceRefs only from the supplied recordRef or ref fields. A reference not present in those fields is invalid.`,
    options.screenshotAccess === "mcp"
      ? `Screenshots marked visualAvailable are available through the evidence MCP. Call view_screenshot with their exact ref when visual evidence is material to a verdict.`
      : options.screenshotAccess === "attached"
        ? `Screenshots marked visualAvailable are attached to this request; their attachment file names are listed in EVIDENCE_JSON.`
        : `No screenshot attachment was selected for this judgement; rely only on the supplied textual evidence.`,
    `Return exactly one item for every rubric id, in the given order. Full pass on an aggregate item requires all applicable cases to pass; use partial for mixed case outcomes. Independently list only defects in the evaluated project.`,
    caseRequests.length
      ? `Also return exactly one case judgement for every rubricId/caseId pair in CASE_REQUESTS_JSON. Judge each case only from its listed scenarioIds. These diagnostic case judgements do not replace the aggregate rubric verdict.`
      : `Return an empty cases array because no rubric has scenario-backed cases.`,
    config.instructions ? `Project-wide evaluator instructions:\n${config.instructions}` : "",
    `PROJECT: ${config.project.name}`,
    `AREA: ${spec.title} (${spec.id})`,
    `AREA DESCRIPTION:\n${spec.description}`,
    `RUBRIC_JSON:\n${JSON.stringify(
      items.map((item) => ({
        id: item.id,
        criterion: item.criterion,
        scenarios: item.scenarios,
        passCriteria: item.passCriteria,
        evidenceToLookFor: item.evidence,
      })),
      null,
      2,
    )}`,
    `CASE_REQUESTS_JSON:\n${JSON.stringify(caseRequests.map(({ rubricId, caseId, scenarioIds }) => ({ rubricId, caseId, scenarioIds })), null, 2)}`,
    `EVIDENCE_JSON:\n${JSON.stringify(compactEvidence(evidence, options.attachments ?? {}), null, 2)}`,
  ].filter(Boolean).join("\n\n");
}
