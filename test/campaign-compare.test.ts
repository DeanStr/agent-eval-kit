import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  campaignComparisonFailures,
  compareCampaigns,
  loadCampaign,
} from "../src/campaign-compare.js";
import {
  buildCampaignReport,
  type CampaignReport,
  type CampaignRunRecord,
} from "../src/campaign.js";

function campaign(
  id: string,
  verdicts: Array<[string, "pass" | "partial" | "fail" | "cannot_judge"]>,
  fingerprint = "f".repeat(64),
): CampaignReport {
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
    cases: [
      {
        areaId: "core",
        rubricId: "R1",
        caseId,
        strata: [`plan=${caseId}`],
        verdict,
        points:
          verdict === "pass" ? 1 : verdict === "partial" ? 0.5 : verdict === "fail" ? 0 : null,
      },
    ],
  }));
  return buildCampaignReport({
    campaignId: id,
    project: "Demo",
    startedAt: "now",
    plannedRepetitions: Math.max(1, runs.length),
    runs,
  });
}

test("campaign comparison pairs stable cases and reports case and stratum regressions", () => {
  const baseline = campaign("before", [
    ["monthly", "fail"],
    ["annual", "pass"],
  ]);
  const candidate = campaign("after", [
    ["monthly", "pass"],
    ["annual", "partial"],
  ]);
  const result = compareCampaigns(baseline, candidate);
  assert.equal(result.compatibility.status, "compatible");
  assert.equal(result.summary.improved, 1);
  assert.equal(result.summary.regressed, 1);
  assert.equal(result.pairedCases.meanDelta, 0.25);
  assert.equal(result.strata.find((item) => item.stratum === "plan=monthly")?.meanDelta, 1);
});

test("saved campaigns reject malformed measurements and duplicate case observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-schema-"));
  try {
    const valid = campaign("valid", [["one", "pass"]]);
    fs.writeFileSync(path.join(root, "campaign.json"), JSON.stringify(valid));
    assert.equal(loadCampaign(root).report.campaignId, "valid");
    for (const mutate of [
      (value: CampaignReport) => {
        value.scorePct = {
          state: "observed",
          value: null,
        } as unknown as CampaignReport["scorePct"];
      },
      (value: CampaignReport) => {
        const run = value.runs[0];
        if (run.status === "complete") run.cases.push(run.cases[0]);
      },
      (value: CampaignReport) => {
        const run = value.runs[0];
        if (run.status === "complete") run.cases[0].points = null;
      },
      (value: CampaignReport) => {
        value.compatibility.evaluationFingerprint = "stale";
      },
      (value: CampaignReport) => {
        value.coverage.completedRuns = 2;
      },
      (value: CampaignReport) => {
        value.scorePct = {
          state: "observed",
          value: {
            mean: 100,
            median: 100,
            minimum: 100,
            maximum: 100,
            standardDeviation: 0,
            confidenceInterval95: null,
          },
          evidence: { availableRuns: 1, totalRuns: 1 },
        };
      },
    ]) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      fs.writeFileSync(path.join(root, "campaign.json"), JSON.stringify(invalid));
      assert.throws(() => loadCampaign(root), /Invalid Agent Eval Kit campaign/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign comparisons retain abstentions and failed attempts in coverage denominators", () => {
  const baseline = campaign("before", [
    ["one", "pass"],
    ["one", "pass"],
    ["one", "pass"],
  ]);
  const candidate = campaign("after", [
    ["one", "pass"],
    ["one", "cannot_judge"],
    ["one", "cannot_judge"],
  ]);
  const result = compareCampaigns(baseline, candidate);
  assert.equal(result.cases[0].baselineMean, 1);
  assert.equal(result.cases[0].candidateMean, 1, "abstentions must not count as zero scores");
  assert.equal(result.cases[0].change, "lost_coverage");
  assert.equal(result.cases[0].candidateTotalRuns, 3);
  assert.equal(result.cases[0].coverage.candidate, 1 / 3);
  assert.equal(campaignComparisonFailures(result, { failOnRegression: true }).length, 1);
  candidate.runs[1] = { ordinal: 2, status: "failed", error: "provider unavailable" };
  assert.equal(compareCampaigns(baseline, candidate).cases[0].coverage.candidate, 1 / 3);
  const shorter = campaign("shorter", [["one", "pass"]]);
  assert.equal(
    compareCampaigns(baseline, shorter).cases[0].change,
    "unchanged",
    "compare rates, not raw repetition counts",
  );
});

test("campaign comparison withholds deltas for incompatible evaluators", () => {
  const result = compareCampaigns(
    campaign("before", [["one", "fail"]]),
    campaign("after", [["one", "pass"]], "x".repeat(64)),
  );
  assert.equal(result.compatibility.status, "incompatible");
  assert.equal(result.cases[0].delta, null);
  assert.equal(result.pairedCases.meanDelta, null);
});

test("campaign regression checks compare case means before display rounding", () => {
  const baseline = campaign("before", [["one", "pass"]]);
  const candidate = buildCampaignReport({
    campaignId: "after",
    project: "Demo",
    startedAt: "now",
    plannedRepetitions: 1,
    runs: baseline.runs.map((run) =>
      run.status === "complete"
        ? {
            ...run,
            runId: "after-1",
            cases: run.cases.map((item) => ({ ...item, verdict: "partial", points: 0.999999 })),
          }
        : run,
    ),
  });
  const comparison = compareCampaigns(baseline, candidate);
  assert.equal(comparison.cases[0].baselineMean, 1);
  assert.equal(comparison.cases[0].candidateMean, 1);
  assert.ok(comparison.cases[0].delta === 0, "the reported delta rounds to zero");
  assert.equal(comparison.cases[0].change, "regressed");
  assert.equal(campaignComparisonFailures(comparison, { failOnRegression: true }).length, 1);
});

test("campaign regression gates distinguish omitted observations from changed definitions", () => {
  const baseline = campaign("before", [
    ["lost", "pass"],
    ["removed", "pass"],
  ]);
  const candidate = campaign("after", [["lost", "cannot_judge"]]);
  const result = compareCampaigns(baseline, candidate);
  assert.equal(result.summary.lostCoverage, 2);
  assert.equal(result.summary.removed, 0);
  assert.deepEqual(result.cases.find((item) => item.caseId === "removed")?.coverage, {
    baseline: 0.5,
    candidate: 0,
    delta: -0.5,
  });
  assert.equal(campaignComparisonFailures(result, { failOnRegression: true }).length, 1);
  const changedDefinitions = campaign("changed", [["lost", "cannot_judge"]], "different");
  const changed = compareCampaigns(baseline, changedDefinitions, { allowIncompatible: true });
  assert.equal(changed.summary.lostCoverage, 1);
  assert.equal(changed.summary.removed, 1);
  assert.equal(changed.cases.find((item) => item.caseId === "removed")?.coverage.candidate, null);
});

test("fully omitted compatible cases report zero coverage without fabricating scores", () => {
  const baseline = campaign("before", [["one", "pass"]]);
  const candidate = buildCampaignReport({
    campaignId: "after",
    project: "Demo",
    startedAt: "now",
    plannedRepetitions: 1,
    runs: baseline.runs.map((run) =>
      run.status === "complete" ? { ...run, runId: "after-1", cases: [] } : run,
    ),
  });
  const comparison = compareCampaigns(baseline, candidate);
  assert.deepEqual(comparison.cases[0].coverage, { baseline: 1, candidate: 0, delta: -1 });
  assert.equal(comparison.cases[0].candidateRuns, 0);
  assert.equal(comparison.cases[0].candidateTotalRuns, 1);
  assert.equal(comparison.cases[0].candidateMean, null);
  assert.equal(comparison.cases[0].change, "lost_coverage");
  assert.equal(comparison.pairedCases.meanDelta, null);
  assert.equal(campaignComparisonFailures(comparison, { failOnRegression: true }).length, 1);
  const abstaining = campaign("abstaining", [["one", "cannot_judge"]]);
  assert.equal(compareCampaigns(abstaining, candidate).cases[0].change, "unavailable");
});

test("campaign regression gates fail closed when headline metrics lose coverage", () => {
  const baseline = campaign("before", [["one", "pass"]]);
  const candidate = campaign("after", [["one", "pass"]]);
  for (const run of baseline.runs)
    if (run.status === "complete") {
      run.scorePct = 100;
      run.scoreWithheld = false;
      run.gatesPassed = true;
    }

  const result = compareCampaigns(baseline, candidate);
  assert.deepEqual(campaignComparisonFailures(result, { failOnRegression: true }), [
    "candidate campaign mean score is unavailable despite an available baseline score",
    "candidate critical-gate pass rate is unavailable despite an available baseline rate",
  ]);
  for (const run of candidate.runs) if (run.status === "complete") run.coveragePct = 75;
  assert.ok(
    campaignComparisonFailures(compareCampaigns(baseline, candidate), {
      failOnRegression: true,
    }).includes("campaign mean evidence coverage dropped 25 points"),
  );
});

test("headline regression gates retain decreases below campaign display precision", () => {
  const source = campaign("source", [
    ["one", "pass"],
    ["one", "pass"],
    ["one", "pass"],
  ]);
  const make = (campaignId: string, last: number) =>
    buildCampaignReport({
      campaignId,
      project: "Demo",
      startedAt: "now",
      plannedRepetitions: 3,
      runs: source.runs.map((run) =>
        run.status === "complete"
          ? {
              ...run,
              scorePct: run.ordinal === 3 ? last : 100,
              coveragePct: run.ordinal === 3 ? last : 100,
              scoreWithheld: false,
              gatesPassed: true,
            }
          : run,
      ),
    });
  const baseline = make("before", 100);
  const candidate = make("after", 99.999);
  assert.deepEqual(baseline.scorePct.state === "observed" && baseline.scorePct.value.mean, 100);
  assert.deepEqual(candidate.scorePct.state === "observed" && candidate.scorePct.value.mean, 100);
  const result = compareCampaigns(baseline, candidate);
  assert.ok(result.overall.scoreMeanPct.delta! < 0);
  assert.ok(result.overall.evidenceCoverageMeanPct.delta! < 0);
  assert.deepEqual(campaignComparisonFailures(result, { failOnRegression: true }), [
    "campaign mean evidence coverage dropped <0.001 points",
    "campaign mean score dropped <0.001 points",
  ]);
});

test("campaign completion regression is gated independently of case and product scores", () => {
  const source = campaign("source", [["one", "pass"]]).runs[0];
  assert.equal(source.status, "complete");
  if (source.status !== "complete") throw new Error("Expected complete fixture");
  const make = (id: string, outcomes: boolean[], fingerprint = source.evaluationFingerprint) =>
    buildCampaignReport({
      campaignId: id,
      project: "Demo",
      startedAt: "now",
      plannedRepetitions: 10,
      runs: outcomes.map((complete, index) =>
        complete
          ? {
              ...source,
              ordinal: index + 1,
              runId: `${id}-${index}`,
              evaluationFingerprint: fingerprint,
              scorePct: 100,
              coveragePct: 100,
              scoreWithheld: false,
              gatesPassed: true,
              cases: [],
            }
          : { ordinal: index + 1, status: "failed", error: "grader crashed" },
      ),
    });
  const baseline = make("before", [true, true, true]);
  const candidate = make("after", [true, false, false]);
  const result = compareCampaigns(baseline, candidate);
  assert.deepEqual(result.cases, []);
  assert.equal(
    result.overall.completionRate.baseline,
    1,
    "pending repetitions do not reduce completion rate",
  );
  assert.equal(result.overall.completionRate.candidate, 1 / 3);
  assert.equal(
    result.overall.scoreMeanPct.delta,
    0,
    "execution failures are not zero product scores",
  );
  assert.equal(result.overall.evidenceCoverageMeanPct.delta, 0);
  assert.equal(result.overall.criticalGatePassRate.delta, 0);
  assert.deepEqual(campaignComparisonFailures(result, { failOnRegression: true }), [
    "campaign completion rate dropped 66.667 percentage points",
  ]);
  assert.deepEqual(campaignComparisonFailures(result, {}), []);
  assert.deepEqual(
    campaignComparisonFailures(
      compareCampaigns(candidate, make("longer", [true, false, false, true, false, false])),
      { failOnRegression: true },
    ),
    [],
  );
  assert.deepEqual(
    campaignComparisonFailures(compareCampaigns(candidate, baseline), { failOnRegression: true }),
    [],
  );
  const incompatible = make("different", [true, false], "different");
  assert.equal(compareCampaigns(baseline, incompatible).overall.completionRate.delta, null);
  assert.equal(
    compareCampaigns(baseline, incompatible, { allowIncompatible: true }).overall.completionRate
      .delta,
    -0.5,
  );
  const failed = compareCampaigns(baseline, make("failed", [false, false]), {
    allowIncompatible: true,
  });
  assert.equal(failed.overall.completionRate.candidate, 0);
  assert.ok(
    campaignComparisonFailures(failed, { failOnRegression: true }).some((message) =>
      /completion rate dropped/.test(message),
    ),
  );
  const pending = compareCampaigns(baseline, make("pending", []));
  assert.equal(pending.overall.completionRate.candidate, null);
  assert.ok(
    campaignComparisonFailures(pending, { failOnRegression: true }).some((message) =>
      /completion rate is unavailable/.test(message),
    ),
  );
});
