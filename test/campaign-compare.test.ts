import assert from "node:assert/strict";
import test from "node:test";
import { campaignComparisonFailures, compareCampaigns } from "../src/campaign-compare.js";
import type { CampaignReport, CampaignRunRecord } from "../src/campaign.js";

function campaign(id: string, verdicts: Array<[string, "pass" | "partial" | "fail" | "cannot_judge"]>, fingerprint = "f".repeat(64)): CampaignReport {
  const runs: CampaignRunRecord[] = verdicts.map(([caseId, verdict], index) => ({
    ordinal: index + 1,
    status: "complete",
    runId: `${id}-${index + 1}`,
    runDir: `/runs/${id}-${index + 1}`,
    evaluationFingerprint: fingerprint,
    inputFingerprint: "i".repeat(64),
    scorePct: null,
    coveragePct: 100,
    scoreWithheld: true,
    items: [],
    cases: [{
      areaId: "core",
      rubricId: "R1",
      caseId,
      strata: [`plan=${caseId}`],
      verdict,
      points: verdict === "pass" ? 1 : verdict === "partial" ? 0.5 : verdict === "fail" ? 0 : null,
    }],
  }));
  return {
    schemaVersion: 1,
    campaignId: id,
    project: "Demo",
    status: "complete",
    startedAt: "now",
    updatedAt: "now",
    plannedRepetitions: runs.length,
    compatibility: { status: "compatible", evaluationFingerprint: fingerprint, fingerprints: [fingerprint], inputFingerprint: "i".repeat(64), inputFingerprints: ["i".repeat(64)] },
    coverage: { completedRuns: runs.length, failedRuns: 0, pendingRuns: 0 },
    scorePct: { state: "unavailable", value: null, reason: "test" },
    evidenceCoveragePct: { state: "unavailable", value: null, reason: "test" },
    criticalGatePassRate: { state: "unavailable", value: null, reason: "test" },
    itemStability: [], caseStability: [], stratumStability: [], runs, limitations: [],
  };
}

test("campaign comparison pairs stable cases and reports case and stratum regressions", () => {
  const baseline = campaign("before", [["monthly", "fail"], ["annual", "pass"]]);
  const candidate = campaign("after", [["monthly", "pass"], ["annual", "partial"]]);
  const result = compareCampaigns(baseline, candidate);
  assert.equal(result.compatibility.status, "compatible");
  assert.equal(result.summary.improved, 1);
  assert.equal(result.summary.regressed, 1);
  assert.equal(result.pairedCases.meanDelta, 0.25);
  assert.equal(result.strata.find((item) => item.stratum === "plan=monthly")?.meanDelta, 1);
});

test("campaign comparison withholds deltas for incompatible evaluators", () => {
  const result = compareCampaigns(campaign("before", [["one", "fail"]]), campaign("after", [["one", "pass"]], "x".repeat(64)));
  assert.equal(result.compatibility.status, "incompatible");
  assert.equal(result.cases[0].delta, null);
  assert.equal(result.pairedCases.meanDelta, null);
});

test("campaign regression gates include lost case coverage and removed cases", () => {
  const baseline = campaign("before", [["lost", "pass"], ["removed", "pass"]]);
  const candidate = campaign("after", [["lost", "cannot_judge"]]);
  const result = compareCampaigns(baseline, candidate);
  assert.equal(result.summary.lostCoverage, 1);
  assert.equal(result.summary.removed, 1);
  assert.equal(campaignComparisonFailures(result, { failOnRegression: true }).length, 1);
});

test("campaign regression gates fail closed when headline metrics lose coverage", () => {
  const baseline = campaign("before", []);
  const candidate = campaign("after", []);
  baseline.scorePct = {
    state: "observed",
    value: { mean: 100, median: 100, minimum: 100, maximum: 100, standardDeviation: 0, confidenceInterval95: null },
    evidence: { availableRuns: 1, totalRuns: 1 },
  };
  baseline.criticalGatePassRate = {
    state: "observed",
    value: 1,
    evidence: { availableRuns: 1, totalRuns: 1 },
  };

  const result = compareCampaigns(baseline, candidate);
  assert.deepEqual(
    campaignComparisonFailures(result, { failOnRegression: true }),
    [
      "candidate campaign mean score is unavailable despite an available baseline score",
      "candidate critical-gate pass rate is unavailable despite an available baseline rate",
    ],
  );
});
