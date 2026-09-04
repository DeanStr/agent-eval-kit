import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, scoreArea } from "../src/scoring.js";
import type { EvalConfig, EvalSpec, JudgedCase, JudgedItem, RunReceipt, ScenarioEvidence, Verdict } from "../src/types.js";

const config = {
  scoring: { partialCredit: 0.5, minimumCoverage: 60 },
} as EvalConfig;

const evidence = (outcome: ScenarioEvidence["outcome"]): ScenarioEvidence => ({
  scenarioId: "S1",
  scenarioName: "Scenario",
  kind: "workspace",
  outcome,
  summary: "",
  observations: [],
  evidenceRefs: [],
  transcript: [],
  screenshots: [],
  artifacts: {},
  provider: "mock",
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:00:01Z",
  durationMs: 1000,
});

const spec: EvalSpec = {
  id: "area",
  title: "Area",
  weight: 100,
  optional: false,
  description: "",
  sourceFile: "spec.yaml",
  scenarios: [{ id: "S1", name: "Scenario", instructions: "Do it", successSignals: [], dependsOn: [], requiresAuth: false }],
  rubric: [
    { id: "R1", criterion: "One", weight: 3, tags: ["flow"], scenarios: ["S1"], grader: { type: "llm" }, passCriteria: "" },
    { id: "R2", criterion: "Two", weight: 2, tags: ["tests"], scenarios: [], grader: { type: "command", command: "true" }, passCriteria: "" },
  ],
};

const judgements: JudgedItem[] = [
  { id: "R1", verdict: "fail", confidence: "high", reasoning: "not reached", evidenceRefs: ["x"], source: "llm" },
  { id: "R2", verdict: "pass", confidence: "high", reasoning: "ok", evidenceRefs: ["x"], source: "command" },
];

test("negative evidence from an entirely blocked scenario is not scored as product failure", () => {
  const score = scoreArea({ spec, judgements, evidence: [evidence("blocked")], config });
  assert.deepEqual(score.unproven, ["R1"]);
  assert.deepEqual(score.pendingManual, []);
  assert.equal(score.earned, 2);
  assert.equal(score.judgeable, 2);
  assert.equal(score.total, 5);
  assert.equal(score.scorePct, 100);
  assert.equal(score.coveragePct, 40);
});

test("positive automatic verdicts are not scored when every backing scenario was blocked", () => {
  const optimistic = judgements.map((item) => item.id === "R1" ? { ...item, verdict: "pass" as const } : item);
  const score = scoreArea({ spec, judgements: optimistic, evidence: [evidence("blocked")], config });
  assert.deepEqual(score.unproven, ["R1"]);
  assert.equal(score.earned, 2);
  assert.equal(score.judgeable, 2);
  assert.equal(score.coveragePct, 40);
});

test("unscoped automatic verdicts still require reached scenario evidence", () => {
  const llmSpec: EvalSpec = {
    ...spec,
    rubric: [{ ...spec.rubric[0], scenarios: [] }],
  };
  const llm = scoreArea({ spec: llmSpec, judgements: [judgements[0]], evidence: [evidence("blocked")], config });
  assert.deepEqual(llm.unproven, ["R1"]);
  assert.equal(llm.judgeable, 0);

  const hybridSpec: EvalSpec = {
    ...spec,
    rubric: [{
      ...spec.rubric[0],
      scenarios: [],
      grader: { type: "hybrid", autoShare: 0.5 },
      manualInstructions: "Verify it",
    }],
  };
  const hybrid = scoreArea({ spec: hybridSpec, judgements: [judgements[0]], evidence: [evidence("blocked")], config });
  assert.deepEqual(hybrid.unproven, ["R1"]);
  assert.equal(hybrid.judgeable, 0);
  assert.deepEqual(hybrid.pendingManual, ["R1"]);
});

test("a completed search makes the same negative verdict judgeable", () => {
  const score = scoreArea({ spec, judgements, evidence: [evidence("completed")], config });
  assert.deepEqual(score.unproven, []);
  assert.equal(score.earned, 2);
  assert.equal(score.judgeable, 5);
  assert.equal(score.scorePct, 40);
  assert.equal(score.coveragePct, 100);
});

test("command graders remain independent when they name blocked scenarios", () => {
  const scopedCommand: EvalSpec = {
    ...spec,
    rubric: [{ ...spec.rubric[1], scenarios: ["S1"] }],
  };
  const score = scoreArea({
    spec: scopedCommand,
    judgements: [judgements[1]],
    evidence: [evidence("blocked")],
    config,
  });
  assert.deepEqual(score.unproven, []);
  assert.equal(score.scorePct, 100);
  assert.equal(score.coveragePct, 100);
});

test("a manual negative verdict remains judgeable when automation was blocked", () => {
  const manual: JudgedItem = {
    ...judgements[0],
    source: "manual",
    reasoning: "A human verified the absence",
    evidenceRefs: ["manual"],
  };
  const score = scoreArea({ spec, judgements: [manual, judgements[1]], evidence: [evidence("blocked")], config });
  assert.deepEqual(score.unproven, []);
  assert.deepEqual(score.pendingManual, []);
  assert.equal(score.earned, 2);
  assert.equal(score.judgeable, 5);
  assert.equal(score.scorePct, 40);
  assert.equal(score.coveragePct, 100);
});

test("hybrid grader counts automatic and manual shares independently", () => {
  const hybrid: EvalSpec = {
    ...spec,
    rubric: [{
      id: "H1",
      criterion: "Hybrid",
      weight: 4,
      tags: ["side-effect"],
      scenarios: ["S1"],
      grader: { type: "hybrid", autoShare: 0.25 },
      passCriteria: "",
      manualInstructions: "Check it",
    }],
  };
  const automatic: JudgedItem = {
    id: "H1",
    verdict: "pass",
    confidence: "high",
    reasoning: "UI said sent",
    evidenceRefs: ["shot.jpg"],
    source: "llm",
  };
  const before = scoreArea({ spec: hybrid, judgements: [automatic], evidence: [evidence("completed")], config });
  assert.equal(before.earned, 1);
  assert.equal(before.judgeable, 1);
  assert.equal(before.coveragePct, 25);
  assert.deepEqual(before.pendingManual, ["H1"]);

  const blocked = scoreArea({ spec: hybrid, judgements: [automatic], evidence: [evidence("blocked")], config });
  assert.equal(blocked.earned, 0);
  assert.equal(blocked.judgeable, 0);
  assert.deepEqual(blocked.unproven, ["H1"]);

  const combined: JudgedItem = {
    ...automatic,
    verdict: "partial",
    source: "manual",
    components: { automatic: "pass", manual: "fail" },
  };
  const after = scoreArea({ spec: hybrid, judgements: [combined], evidence: [evidence("completed")], config });
  assert.equal(after.earned, 1);
  assert.equal(after.judgeable, 4);
  assert.equal(after.scorePct, 25);
  assert.equal(after.coveragePct, 100);
});

test("rescoring rebuilds finalized hybrid verdicts from current shares", () => {
  const manualOnly: EvalSpec = {
    ...spec,
    rubric: [{
      id: "H1",
      criterion: "Hybrid gate",
      weight: 4,
      tags: ["side-effect"],
      scenarios: ["S1"],
      grader: { type: "hybrid", autoShare: 0 },
      passCriteria: "Every weighted component passes",
      manualInstructions: "Verify it",
      gate: true,
    }],
  };
  const finalized: JudgedItem = {
    id: "H1",
    verdict: "pass",
    confidence: "high",
    reasoning: "Finalized under a zero automatic share",
    evidenceRefs: ["manual-revision:one"],
    source: "manual",
    components: { automatic: "fail", manual: "pass" },
  };
  const before = scoreArea({ spec: manualOnly, judgements: [finalized], evidence: [evidence("completed")], config });
  assert.equal(before.items[0].verdict, "pass");
  assert.equal(before.gates?.[0].status, "passed");

  const reweighted: EvalSpec = {
    ...manualOnly,
    rubric: [{ ...manualOnly.rubric[0], grader: { type: "hybrid", autoShare: 0.5 } }],
  };
  const after = scoreArea({ spec: reweighted, judgements: [finalized], evidence: [evidence("completed")], config });
  assert.equal(after.items[0].verdict, "partial");
  assert.equal(after.scorePct, 50);
  assert.equal(after.gates?.[0].status, "failed");
});

test("critical rubric items become hard pass, fail, or unavailable gates", () => {
  const gated: EvalSpec = {
    ...spec,
    rubric: [
      { ...spec.rubric[0], id: "PASS", gate: true },
      { ...spec.rubric[0], id: "FAIL", gate: true },
      { ...spec.rubric[0], id: "UNKNOWN", gate: true },
    ],
  };
  const score = scoreArea({
    spec: gated,
    judgements: [
      { ...judgements[0], id: "PASS", verdict: "pass" },
      { ...judgements[0], id: "FAIL", verdict: "partial" },
      { ...judgements[0], id: "UNKNOWN", verdict: "cannot_judge", evidenceRefs: [] },
    ],
    evidence: [evidence("completed")],
    config,
  });
  assert.deepEqual(score.gates?.map(({ itemId, status }) => ({ itemId, status })), [
    { itemId: "PASS", status: "passed" },
    { itemId: "FAIL", status: "failed" },
    { itemId: "UNKNOWN", status: "unavailable" },
  ]);
});

test("a hybrid critical item stays unavailable until every weighted share is judged", () => {
  const gated: EvalSpec = {
    ...spec,
    rubric: [{
      id: "HYBRID_GATE",
      criterion: "Human-confirmed side effect",
      weight: 5,
      tags: ["side-effect"],
      scenarios: ["S1"],
      grader: { type: "hybrid", autoShare: 0.5 },
      passCriteria: "Both checks pass",
      manualInstructions: "Verify the side effect",
      gate: true,
    }],
  };
  const manualOnly: JudgedItem = {
    id: "HYBRID_GATE",
    verdict: "pass",
    confidence: "high",
    reasoning: "Human confirmed it",
    evidenceRefs: ["manual"],
    source: "manual",
    components: { manual: "pass" },
  };
  const score = scoreArea({ spec: gated, judgements: [manualOnly], evidence: [evidence("completed")], config });
  assert.equal(score.gates?.[0].status, "unavailable");
  assert.match(score.gates?.[0].reason ?? "", /Only 2\.5 of 5/);
});

test("automated cannot-judge results reduce coverage without creating impossible manual work", () => {
  const cannotJudge: JudgedItem[] = spec.rubric.map((rubric) => ({
    id: rubric.id,
    verdict: "cannot_judge",
    confidence: "low",
    reasoning: "No usable evidence",
    evidenceRefs: [],
    source: rubric.grader.type === "command" ? "command" : "llm",
  }));
  const score = scoreArea({ spec, judgements: cannotJudge, evidence: [evidence("completed")], config });
  assert.deepEqual(score.pendingManual, []);
  assert.equal(score.coveragePct, 0);
});

test("global tag and stratum diagnostics respect top-level area weights", () => {
  const area = (id: string, areaWeight: number, rubricWeight: number, verdict: Verdict) => {
    const weightedSpec: EvalSpec = {
      ...spec,
      id,
      title: id,
      weight: areaWeight,
      rubric: [{
        ...spec.rubric[0],
        id: "SHARED",
        weight: rubricWeight,
        tags: ["shared"],
      }],
    };
    const judgement: JudgedItem = {
      id: "SHARED",
      verdict,
      confidence: "high",
      reasoning: verdict,
      evidenceRefs: ["evidence"],
      source: "llm",
    };
    const caseResult: JudgedCase = {
      areaId: id,
      rubricId: "SHARED",
      caseId: "case",
      scenarioIds: ["S1"],
      strata: ["tier=shared"],
      verdict,
      confidence: "high",
      reasoning: verdict,
      evidenceRefs: ["evidence"],
      source: "llm",
    };
    return scoreArea({
      spec: weightedSpec,
      judgements: [judgement],
      evidence: [evidence("completed")],
      caseResults: [caseResult],
      config,
    });
  };
  const reportConfig = {
    ...config,
    project: { name: "Weighted diagnostics", root: "/project" },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 1, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 1, extraArgs: [] },
  } as EvalConfig;
  const report = buildReport({
    runId: "weighted",
    startedAt: "2026-01-01T00:00:00Z",
    config: reportConfig,
    areas: [area("large", 90, 1, "pass"), area("small", 10, 100, "fail")],
    receipt: {} as RunReceipt,
  });

  assert.deepEqual(report.byTag.shared, {
    earned: 90,
    judgeable: 100,
    total: 100,
    scorePct: 90,
    coveragePct: 100,
  });
  assert.deepEqual(report.byStratum["tier=shared"], {
    earned: 90,
    judgeable: 100,
    total: 100,
    scorePct: 90,
    coveragePct: 100,
    cases: 2,
  });
});
