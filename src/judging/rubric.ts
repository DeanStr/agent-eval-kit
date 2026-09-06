import { checkpointRefs, rubricWasReached } from "../checkpoints.js";
import type { z } from "zod";
import type { judgementOutputValidator } from "../schemas.js";
import type {
  Defect,
  EvalConfig,
  EvalSpec,
  JudgedCase,
  JudgedItem,
  RubricItem,
  ScenarioEvidence,
} from "../types.js";
import { canonicalEvidenceRefs, caseJudgeRequests, rubricEvidenceRefs } from "./evidence.js";
import { assertScreenshotAccess } from "../evidence/inspection.js";
import { assertJudgementIdentities, constrainFullPass } from "./contracts.js";

function checkedEvidenceRefs(
  references: string[],
  allowed: Set<string>,
  required: boolean,
  identity: string,
  directory: string,
): string[] {
  const invalid = [...new Set(references.filter((reference) => !allowed.has(reference)))];
  const problem = invalid.length
    ? `invalid or out-of-scope evidence references (${invalid.join(", ")})`
    : required && !references.length
      ? "no evidence references for a claim"
      : undefined;
  if (problem)
    throw new Error(
      `Judge evidence contract violation for ${identity}: ${problem}. Cite only supplied references within scope, explicitly abstain when evidence is insufficient, or omit unsupported defects. See ${directory} for retained judge diagnostics.`,
    );
  return [...new Set(references)];
}

/** Canonical normalization for fresh single judgements and each repeated judgement. */
export function normalizeRubricJudgement(options: {
  judgement: z.infer<typeof judgementOutputValidator>;
  config: EvalConfig;
  spec: EvalSpec;
  items: RubricItem[];
  evidence: ScenarioEvidence[];
  directory: string;
  attachments: Record<string, string>;
}): { items: JudgedItem[]; cases: JudgedCase[]; defects: Defect[]; notes: string } {
  const { judgement, config, spec, items, evidence, directory, attachments } = options;
  const requestedCases = caseJudgeRequests(items, evidence);
  assertJudgementIdentities(judgement, { items, cases: requestedCases }, directory);
  const screenshotRefs = new Set(
    evidence.flatMap((scenario) =>
      scenario.screenshots.map((shot) => `${scenario.scenarioId}/${shot.path}`),
    ),
  );
  const claims = [
    ...judgement.items.filter((item) => item.verdict !== "cannot_judge"),
    ...judgement.cases.filter((item) => item.verdict !== "cannot_judge"),
    ...judgement.defects,
  ];
  assertScreenshotAccess({
    directory,
    access: config.judge.provider === "codex" ? "attached" : "mcp",
    selectedRefs: Object.keys(attachments),
    requiredRefs: claims
      .flatMap((item) => item.evidenceRefs)
      .filter((ref) => screenshotRefs.has(ref)),
    context: "Judge screenshot",
  });

  const reachedAreaRefs = canonicalEvidenceRefs(
    evidence.filter(
      (scenario) => scenario.outcome === "completed" || scenario.outcome === "feature_not_found",
    ),
  );
  for (const scenario of evidence)
    for (const ref of checkpointRefs(scenario, Object.keys(scenario.checkpoints ?? {})))
      reachedAreaRefs.add(ref);
  const byId = new Map(judgement.items.map((item) => [item.id, item]));
  const normalized = items.map((rubric) => {
    const item = byId.get(rubric.id)!;
    const rubricEvidence = rubric.scenarios.length
      ? evidence.filter((scenario) => rubric.scenarios.includes(scenario.scenarioId))
      : evidence;
    const allowedRefs =
      item.verdict === "cannot_judge"
        ? canonicalEvidenceRefs(rubricEvidence)
        : rubricEvidenceRefs(rubric, rubricEvidence);
    const evidenceRefs = checkedEvidenceRefs(
      item.evidenceRefs,
      allowedRefs,
      item.verdict !== "cannot_judge",
      `rubric item ${item.id}`,
      directory,
    );
    return { ...item, evidenceRefs, source: "llm" as const };
  });
  const returnedCases = new Map(
    judgement.cases.map((item) => [`${item.rubricId}\0${item.caseId}`, item]),
  );
  const cases: JudgedCase[] = requestedCases.map((request) => {
    const item = returnedCases.get(`${request.rubricId}\0${request.caseId}`)!;
    const caseEvidence = evidence.filter((scenario) =>
      request.scenarioIds.includes(scenario.scenarioId),
    );
    const rubric = items.find((rubric) => rubric.id === request.rubricId)!;
    const allowedCaseRefs =
      item.verdict === "cannot_judge"
        ? canonicalEvidenceRefs(caseEvidence)
        : rubricEvidenceRefs(rubric, caseEvidence);
    const evidenceRefs = checkedEvidenceRefs(
      item.evidenceRefs,
      allowedCaseRefs,
      item.verdict !== "cannot_judge",
      `case ${item.rubricId}/${item.caseId}`,
      directory,
    );
    const caseSpecificEvidence = caseEvidence.filter((scenario) => scenario.caseId);
    const evidenceThatMustReach = caseSpecificEvidence.length ? caseSpecificEvidence : caseEvidence;
    // A matrix case requires shared checks and its own instances, not other cases.
    const scopedRubric = (scenarioIds: string[]) => ({
      ...rubric,
      scenarios: scenarioIds,
      checkpoints: Object.fromEntries(
        Object.entries(rubric.checkpoints ?? {}).filter(([id]) => scenarioIds.includes(id)),
      ),
    });
    const missingCheckpointScenario = Object.keys(rubric.checkpoints ?? {}).some(
      (id) => !evidence.some((scenario) => scenario.scenarioId === id),
    );
    const caseWasReached =
      !missingCheckpointScenario &&
      rubricWasReached(scopedRubric(request.scenarioIds), caseEvidence) &&
      rubricWasReached(
        scopedRubric(evidenceThatMustReach.map((s) => s.scenarioId)),
        evidenceThatMustReach,
      );
    if (item.verdict !== "cannot_judge" && !caseWasReached) {
      return {
        areaId: spec.id,
        ...request,
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: `Evidence contract violation: required checkpoints or case-specific scenario evidence were not reached. Original reasoning: ${item.reasoning}`,
        evidenceRefs: [],
        source: "llm",
      };
    }
    return { areaId: spec.id, ...request, ...item, evidenceRefs, source: "llm" };
  });
  const enforcedItems = normalized.map((item) => {
    const itemCases = cases.filter((candidate) => candidate.rubricId === item.id);
    const verdict = constrainFullPass(
      item.verdict,
      itemCases.map((candidate) => candidate.verdict),
    );
    if (verdict === item.verdict) return item;
    return {
      ...item,
      verdict,
      confidence: verdict === "cannot_judge" ? ("low" as const) : item.confidence,
      reasoning: `Aggregate full pass rejected because not every applicable case passed. ${item.reasoning}`,
    };
  });
  const defects = judgement.defects.map((defect, index) => ({
    ...defect,
    evidenceRefs: checkedEvidenceRefs(
      defect.evidenceRefs,
      reachedAreaRefs,
      true,
      `defect ${index + 1} (${defect.description})`,
      directory,
    ),
  }));
  return { items: enforcedItems, cases, defects, notes: judgement.notes };
}
