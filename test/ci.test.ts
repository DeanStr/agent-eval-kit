import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCiThresholds } from "../src/ci.js";
import { buildReport, scoreArea } from "../src/scoring.js";
import { calculateScoreSlice } from "../src/score-slice.js";
import type { EvalConfig, EvalSpec, RunReceipt, RunReport, Verdict } from "../src/types.js";

const report = {
  overallScorePct: 84.5,
  overallCoveragePct: 92,
  scoreWithheld: false,
  areas: [{ weight: 100, optional: false, total: 100000, judgeable: 92000, earned: 77740 }],
} as RunReport;

test("CI thresholds pass at or above the configured boundary", () => {
  assert.deepEqual(evaluateCiThresholds(report, { minimumScore: 84.5, minimumCoverage: 92 }), []);
});

test("CI thresholds explain independent score and coverage failures", () => {
  assert.deepEqual(evaluateCiThresholds(report, { minimumScore: 90, minimumCoverage: 95 }), [
    "coverage 92% is below required 95%",
    "score 84.5% is below required 90%",
  ]);
});

test("a withheld score cannot satisfy a score threshold", () => {
  assert.match(
    evaluateCiThresholds({ ...report, scoreWithheld: true }, { minimumScore: 1 })[0],
    /score is withheld/,
  );
});

test("critical rubric gates fail CI even without numeric thresholds", () => {
  const gated = {
    ...report,
    gates: {
      passed: false,
      blocking: [{
        areaId: "core",
        itemId: "CORE-01",
        status: "failed",
        verdict: "fail",
        reason: "critical workflow failed",
      }],
    },
  } as RunReport;
  assert.deepEqual(evaluateCiThresholds(gated, {}), [
    "critical gates not satisfied: core/CORE-01 (failed: fail)",
  ]);
});

test("rounded 100% never satisfies exact score or coverage requirements", () => {
  const config = {
    project: { name: "Precision", root: "/project" }, target: { kind: "repository" },
    agent: { provider: "mock" }, judge: { provider: "mock" },
    scoring: { partialCredit: 0.5, minimumCoverage: 100 },
  } as EvalConfig;
  const spec = {
    id: "core", title: "Core", description: "Precision", sourceFile: "spec.yaml", weight: 100, optional: false, scenarios: [],
    rubric: [999999, 1].map((weight, index) => ({
      id: `R${index}`, criterion: "Works", passCriteria: "Works", weight, tags: [], scenarios: [],
      grader: { type: "command", command: "true", methodFiles: [], output: "exit-code" },
    })),
  } as EvalSpec;
  for (const verdict of ["fail", "cannot_judge", "pass"] as Verdict[]) {
    const area = scoreArea({ config, spec, evidence: [], judgements: ["R0", "R1"].map(id => ({
      id, verdict: id === "R0" ? "pass" : verdict, source: "command", confidence: "high", reasoning: "Observed", evidenceRefs: [],
    })) });
    const actual = buildReport({ runId: "precision", startedAt: "now", config, areas: [area], receipt: {} as RunReceipt });
    assert.equal(actual.overallScorePct, 100);
    assert.equal(actual.overallCoveragePct, 100);
    const failures = evaluateCiThresholds(actual, { minimumScore: 100, minimumCoverage: 100 });
    if (verdict === "pass") assert.deepEqual(failures, []);
    else {
      assert.equal(actual.scoreWithheld, verdict === "cannot_judge");
      assert.match(failures.join("\n"), verdict === "fail" ? /score 99\.9999% is below/ : /coverage 99\.9999% is below/);
    }
  }
});

test("exact decimal boundaries tolerate arithmetic roundoff without admitting real shortfalls", () => {
  const config = {
    project: { name: "Boundary", root: "/project" }, target: { kind: "repository" },
    agent: { provider: "mock" }, judge: { provider: "mock" },
    scoring: { partialCredit: 0.5, minimumCoverage: 0 },
  } as EvalConfig;
  for (const threshold of [0.29, 29, 57, 58, 84.5, 100]) {
    for (const deficit of [0, 1e-8]) {
      const observed = threshold - deficit;
      const area: RunReport["areas"][number] = {
        id: "core", title: "Core", weight: 100, optional: false,
        ...calculateScoreSlice({ total: 100, judgeable: observed, earned: observed * observed / 100 }),
        gates: [], pendingManual: [], byTag: {}, byStratum: {}, items: [], defects: [],
        notes: "", scenarios: [], unproven: [], caseResults: [],
      };
      const actual = buildReport({
        runId: "boundary", startedAt: "now", areas: [area], receipt: {} as RunReceipt,
        config: { ...config, scoring: { ...config.scoring, minimumCoverage: threshold } },
      });
      assert.equal(actual.scoreWithheld, deficit > 0, `coverage ${observed} vs ${threshold}`);
      const failures = evaluateCiThresholds({ ...actual, scoreWithheld: false }, { minimumCoverage: threshold, minimumScore: threshold });
      assert.equal(failures.length, deficit > 0 ? 2 : 0, `score/coverage ${observed} vs ${threshold}: ${failures.join("; ")}`);
    }
  }
});
