import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCiThresholds } from "../src/ci.js";
import type { RunReport } from "../src/types.js";

const report = {
  overallScorePct: 84.5,
  overallCoveragePct: 92,
  scoreWithheld: false,
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
