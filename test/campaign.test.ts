import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignReport, campaignRunRecord } from "../src/campaign.js";
import type { RunReceipt, RunReport, Verdict } from "../src/types.js";

function receipt(fingerprint = "f".repeat(64)): RunReceipt {
  return {
    schemaVersion: 1,
    evaluationFingerprint: fingerprint,
    inputFingerprint: "i".repeat(64),
    inputs: {
      config: { sha256: "c".repeat(64), bytes: 1 },
      methodSha256: "m".repeat(64),
      specs: {},
      selection: { areas: ["core"] },
      specMethods: {},
    },
    target: { kind: "repository" },
    providers: {
      agent: { provider: "mock", cliVersion: "mock 0.1.0" },
      judge: { provider: "mock", cliVersion: "mock 0.1.0" },
    },
    runtime: {
      kitVersion: "0.1.0",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function report(runId: string, score: number, verdict: Verdict, fingerprint?: string): RunReport {
  return {
    schemaVersion: 1,
    runId,
    project: "Campaign",
    target: { kind: "repository", root: "/project" },
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    kitVersion: "0.1.0",
    providers: { agent: { provider: "mock" }, judge: { provider: "mock" } },
    areas: [
      {
        id: "core",
        title: "Core",
        weight: 100,
        optional: false,
        earned: 1,
        judgeable: 1,
        total: 1,
        scorePct: score,
        coveragePct: 100,
        items: [
          {
            id: "R1",
            verdict,
            confidence: "high",
            reasoning: "test",
            evidenceRefs: ["e"],
            source: "llm",
          },
        ],
        caseResults: [
          {
            areaId: "core",
            rubricId: "R1",
            caseId: "annual",
            scenarioIds: ["S--annual"],
            strata: ["plan=annual"],
            split: "evaluation",
            verdict,
            confidence: "high",
            reasoning: "test",
            evidenceRefs: ["e"],
            source: "llm",
            points:
              verdict === "pass"
                ? 1
                : verdict === "partial"
                  ? 0.5
                  : verdict === "cannot_judge"
                    ? null
                    : 0,
          },
        ],
        defects: [],
        notes: "",
        scenarios: [],
        pendingManual: [],
        unproven: [],
        byTag: {},
        byStratum: {},
        gates: [
          {
            itemId: "R1",
            status: verdict === "pass" ? "passed" : "failed",
            verdict,
            reason: "test",
          },
        ],
      },
    ],
    overallScorePct: score,
    overallCoveragePct: 100,
    scoreWithheld: false,
    byTag: {},
    byStratum: {},
    manualPending: 0,
    receipt: receipt(fingerprint),
    gates: { passed: verdict === "pass", blocking: [] },
  };
}

test("campaign aggregation reports whole-run variation, bootstrap intervals, and item stability", () => {
  const reports = [
    report("one", 100, "pass"),
    report("two", 80, "pass"),
    report("three", 60, "fail"),
  ];
  const runs = reports.map((result, index) =>
    campaignRunRecord(index + 1, `/runs/${index + 1}`, result),
  );
  const campaign = buildCampaignReport({
    campaignId: "campaign",
    project: "Campaign",
    startedAt: "2026-01-01T00:00:00Z",
    plannedRepetitions: 3,
    runs,
  });
  assert.equal(campaign.status, "complete");
  assert.equal(campaign.compatibility.status, "compatible");
  assert.equal(campaign.scorePct.state, "observed");
  if (campaign.scorePct.state === "observed") {
    assert.equal(campaign.scorePct.value.mean, 80);
    assert.equal(campaign.scorePct.value.standardDeviation, 20);
    assert.equal(
      campaign.scorePct.value.confidenceInterval95?.resamplingUnit,
      "complete evaluation run",
    );
  }
  assert.equal(
    campaign.criticalGatePassRate.state === "observed" && campaign.criticalGatePassRate.value,
    0.667,
  );
  assert.equal(
    requireDefined(campaign.itemStability[0], "campaign.itemStability[0]").fullPassRate,
    0.667,
  );
  assert.equal(
    requireDefined(campaign.itemStability[0], "campaign.itemStability[0]").verdicts.fail,
    1,
  );
  assert.equal(
    requireDefined(campaign.caseStability[0], "campaign.caseStability[0]").caseId,
    "annual",
  );
  assert.equal(
    requireDefined(campaign.caseStability[0], "campaign.caseStability[0]").fullPassRate,
    0.667,
  );
  assert.equal(
    requireDefined(campaign.stratumStability[0], "campaign.stratumStability[0]").stratum,
    "plan=annual",
  );
});

test("campaign aggregation withholds aggregate metrics when evaluator fingerprints differ", () => {
  const runs = [
    campaignRunRecord(1, "/runs/1", report("one", 100, "pass")),
    campaignRunRecord(2, "/runs/2", report("two", 80, "pass", "x".repeat(64))),
  ];
  const campaign = buildCampaignReport({
    campaignId: "mixed",
    project: "Campaign",
    startedAt: "now",
    plannedRepetitions: 2,
    runs,
  });
  assert.equal(campaign.compatibility.status, "incompatible");
  assert.equal(campaign.scorePct.state, "unavailable");
  assert.equal(campaign.criticalGatePassRate.state, "unavailable");
});

test("campaign gate pass rate is unavailable when runs contain no critical gates", () => {
  const source = report("gate-free", 100, "pass");
  requireDefined(source.areas[0], "source.areas[0]").gates = [];
  // Run-level `passed` is also true for a gate-free report; it must not be
  // mistaken for an observation that a critical criterion was exercised.
  source.gates = { passed: true, blocking: [] };
  const record = campaignRunRecord(1, "/runs/gate-free", source);
  assert.equal(record.gatesPassed, undefined);

  const campaign = buildCampaignReport({
    campaignId: "gate-free",
    project: "Campaign",
    startedAt: "now",
    plannedRepetitions: 1,
    runs: [record],
  });
  assert.equal(campaign.criticalGatePassRate.state, "unavailable");
});

test("campaign records normalize unproven item and case verdicts", () => {
  const source = report("unproven", 100, "pass");
  requireDefined(source.areas[0], "source.areas[0]").unproven = ["R1"];
  const record = campaignRunRecord(1, "/runs/unproven", source);
  assert.equal(requireDefined(record.items?.[0], "record.items?.[0]").verdict, "cannot_judge");
  assert.equal(requireDefined(record.cases?.[0], "record.cases?.[0]").verdict, "cannot_judge");
  assert.equal(requireDefined(record.cases?.[0], "record.cases?.[0]").points, null);

  const campaign = buildCampaignReport({
    campaignId: "unproven",
    project: "Campaign",
    startedAt: "now",
    plannedRepetitions: 1,
    runs: [record],
  });
  assert.equal(
    requireDefined(campaign.itemStability[0], "campaign.itemStability[0]").verdicts.cannot_judge,
    1,
  );
  assert.equal(
    requireDefined(campaign.itemStability[0], "campaign.itemStability[0]").fullPassRate,
    0,
  );
  assert.equal(
    requireDefined(campaign.caseStability[0], "campaign.caseStability[0]").verdicts.cannot_judge,
    1,
  );
  assert.equal(
    requireDefined(campaign.stratumStability[0], "campaign.stratumStability[0]").verdicts
      .cannot_judge,
    1,
  );
});

test("campaign aggregation rejects incomplete records instead of degrading compatibility", () => {
  assert.throws(
    () =>
      buildCampaignReport({
        campaignId: "invalid",
        project: "Campaign",
        startedAt: "now",
        plannedRepetitions: 1,
        runs: [{ ordinal: 1, status: "complete" } as never],
      }),
    /missing required v1 measurements or identity/,
  );
});
