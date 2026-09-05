import assert from "node:assert/strict";
import test from "node:test";
import { campaignRunSchema, scoreSliceSchema } from "../src/artifact-schemas.js";

test("score slices reject contradictory percentages and zero-denominator scores", () => {
  for (const value of [
    { earned: 0, judgeable: 1, total: 1, scorePct: 100, coveragePct: 100 },
    { earned: 1, judgeable: 1, total: 2, scorePct: 100, coveragePct: 100 },
    { earned: 0, judgeable: 0, total: 0, scorePct: 100, coveragePct: 100 },
    { earned: 0, judgeable: 0, total: 1, scorePct: 0, coveragePct: 0 },
    { earned: 0, judgeable: 1, total: 1, scorePct: null, coveragePct: 100 },
  ]) assert.equal(scoreSliceSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(scoreSliceSchema.safeParse({ earned: 0, judgeable: 0, total: 0, scorePct: null, coveragePct: 0 }).success, true);
  assert.equal(scoreSliceSchema.safeParse({ earned: 1, judgeable: 3, total: 7, scorePct: 33.333, coveragePct: 42.857 }).success, true);
});

test("campaign case points enforce fixed verdict values while permitting configured partial credit", () => {
  for (const [verdict, points, valid] of [
    ["pass", 0, false], ["pass", 1, true], ["pass", null, false],
    ["fail", 1, false], ["fail", 0, true],
    ["not_found", 1, false], ["not_found", 0, true],
    ["cannot_judge", 0, false], ["cannot_judge", null, true],
    ["partial", null, false], ["partial", 0, true], ["partial", 0.7, true], ["partial", 1, true],
  ] as const) {
    const result = campaignRunSchema.safeParse({
      ordinal: 1, status: "complete", runId: "run", runDir: "/runs/run", evaluationFingerprint: "e", inputFingerprint: "i",
      scorePct: null, coveragePct: 0, scoreWithheld: true, items: [],
      cases: [{ areaId: "core", rubricId: "R1", caseId: "one", strata: [], verdict, points }],
    });
    assert.equal(result.success, valid, `${verdict}/${points}`);
  }
});
