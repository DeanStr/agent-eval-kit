import { caseJudgeRequests } from "./judging/evidence.js";
import type { EvalConfig, EvalSpec, RubricItem, Scenario, ScenarioEvidence } from "./types.js";

export function scenarioPrompt(options: {
  config: EvalConfig;
  spec: EvalSpec;
  scenario: Scenario;
  kind: "browser" | "workspace";
  fixtures: unknown;
  inputs?: Record<string, import("./types.js").BoundInput>;
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
    options.inputs && Object.keys(options.inputs).length
      ? `BOUND INPUTS (observed upstream values with provenance):\n${JSON.stringify(options.inputs)}`
      : "",
    scenario.outputs
      ? `REQUIRED OUTPUTS: ${JSON.stringify(scenario.outputs)}. Publish observed values using publish_output with successful earlier tool step references (step:N). Do not invent missing values or expose secrets. Unavailable outputs block downstream checks.`
      : "",
    scenario.allowedPersonas
      ? `ALLOWED PERSONAS: ${scenario.allowedPersonas.join(", ")}. Use switch_persona to change isolated browser identity, including anonymous when declared. Never sign in as another identity inside the current context.`
      : "",
    scenario.checkpoints
      ? `CHECKPOINTS: ${JSON.stringify(scenario.checkpoints)}. Call checkpoint immediately after exercising each declared check, citing its actual tool steps. This records reach, not success.`
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

function compactEvidence(
  evidence: ScenarioEvidence[],
  attachments: Record<string, string>,
): unknown[] {
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
    files: scenario.files?.map((file) => ({ ...file, ref: `${scenario.scenarioId}/${file.path}` })),
    checkpoints: Object.entries(scenario.checkpoints ?? {}).map(([name, value]) => ({
      name,
      ...value,
      ref: `${scenario.scenarioId}/evidence.json#checkpoint-${name}`,
    })),
    inputs: scenario.inputs,
    outputs: scenario.outputs,
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
      persona: entry.persona,
      tool: entry.tool,
      input: entry.input,
      result: entry.result.slice(0, 2_000),
      isError: entry.isError,
    })),
  }));
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
    `Every non-abstaining verdict needs concrete evidenceRefs; cannot_judge may use an empty array. Never turn an agent/harness timeout, missing authentication, or low evidence coverage into a product defect.`,
    `Cite a screenshot only if it is attached or you successfully viewed it through the evidence MCP. Screenshot labels and metadata alone are not visual evidence. Explicit cannot_judge may name an unavailable screenshot to explain an abstention.`,
    `File hashes establish identity, not content correctness. A supplied text preview supports only its visible excerpt; truncated previews cannot establish claims about the full file. Binary file contents require deterministic checks.`,
    `A rubric with checkpoint selectors requires those checks to have been exercised. Cite only its checkpoint records, the steps those records cite, or images/files captured at those steps. A later blocked outcome does not erase those checks. A checkpoint is not a passing verdict.`,
    `Copy evidenceRefs only from the supplied recordRef or ref fields. A reference not present in those fields is invalid.`,
    options.screenshotAccess === "mcp"
      ? `Screenshots marked visualAvailable are available through the evidence MCP. Call view_screenshot with their exact ref when visual evidence is material to a verdict.`
      : options.screenshotAccess === "attached"
        ? `Screenshots marked visualAvailable are attached to this request; their attachment file names are listed in EVIDENCE_JSON.`
        : `No screenshot attachment was selected for this judgement; rely only on the supplied textual evidence.`,
    `Return exactly one item for every rubric id, in the given order. Full pass on an aggregate item requires all applicable cases to pass; use partial for mixed case outcomes. Independently list only defects in the evaluated project, each citing evidence from completed or feature_not_found scenarios.`,
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
        checkpoints: item.checkpoints,
        evidenceToLookFor: item.evidence,
      })),
      null,
      2,
    )}`,
    `CASE_REQUESTS_JSON:\n${JSON.stringify(
      caseRequests.map(({ rubricId, caseId, scenarioIds }) => ({ rubricId, caseId, scenarioIds })),
      null,
      2,
    )}`,
    `EVIDENCE_JSON:\n${JSON.stringify(compactEvidence(evidence, options.attachments ?? {}), null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
