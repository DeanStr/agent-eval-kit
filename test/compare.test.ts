import { requireDefined, omitUndefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scoreArea } from "../src/scoring.js";
import type { EvalConfig, EvalSpec, ScenarioEvidence } from "../src/types.js";
import {
  compareReports,
  comparisonFailures,
  loadComparisonInput,
  loadResumableRunReport,
  writeComparisonArtifacts,
} from "../src/compare.js";
import type {
  AreaResult,
  JudgedItem,
  RunReceipt,
  RunReport,
  ScoreSlice,
  Verdict,
} from "../src/types.js";

const receipt = (fingerprint = "same", methodSha256 = "method"): RunReceipt => ({
  schemaVersion: 1,
  evaluationFingerprint: fingerprint,
  inputFingerprint: `input-${fingerprint}`,
  inputs: {
    config: { sha256: "c".repeat(64), bytes: 1 },
    methodSha256,
    specs: { core: { file: "core.yaml", sha256: "s".repeat(64), bytes: 1 } },
    selection: { areas: ["core"] },
  },
  target: { kind: "repository", git: { commit: "a".repeat(40), dirty: false } },
  providers: {
    agent: { provider: "mock", cliVersion: "mock" },
    judge: { provider: "mock", cliVersion: "mock" },
  },
  runtime: {
    kitVersion: "0.1.0",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
});

const item = (id: string, verdict: Verdict): JudgedItem => ({
  id,
  verdict,
  confidence: "high",
  reasoning: "test",
  evidenceRefs: verdict === "cannot_judge" ? [] : ["evidence"],
  source: "llm",
  score: {
    total: 1,
    earned: verdict === "pass" ? 1 : verdict === "partial" ? 0.5 : 0,
    judgeable: verdict === "cannot_judge" ? 0 : 1,
    scorePct:
      verdict === "cannot_judge" ? null : verdict === "pass" ? 100 : verdict === "partial" ? 50 : 0,
    coveragePct: verdict === "cannot_judge" ? 0 : 100,
  },
});

const slice = (scorePct: number | null, coveragePct: number): ScoreSlice => ({
  earned: ((scorePct ?? 0) * coveragePct) / 100,
  judgeable: coveragePct,
  total: 100,
  scorePct,
  coveragePct,
});

const area = (
  items: JudgedItem[],
  scorePct: number | null,
  coveragePct: number,
  unproven: string[] = [],
): AreaResult => ({
  id: "core",
  title: "Core",
  weight: 100,
  optional: false,
  ...slice(scorePct, coveragePct),
  items,
  defects: [],
  notes: "",
  scenarios: [],
  pendingManual: [],
  unproven,
  byTag: { workflow: slice(scorePct, coveragePct) },
  byStratum: {},
  gates: [],
  caseResults: [],
});

const report = (
  runId: string,
  items: JudgedItem[],
  scorePct: number | null,
  coveragePct: number,
): RunReport => ({
  schemaVersion: 1,
  runId,
  project: "Demo",
  target: { kind: "repository", root: "/project" },
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
  kitVersion: "0.1.0",
  providers: { agent: { provider: "mock" }, judge: { provider: "mock" } },
  areas: [area(items, scorePct, coveragePct)],
  overallScorePct: scorePct,
  overallCoveragePct: coveragePct,
  scoreWithheld: false,
  byTag: { workflow: slice(scorePct, coveragePct) },
  byStratum: {},
  manualPending: 0,
  receipt: receipt(),
  gates: { passed: true, blocking: [] },
});

test("hybrid comparisons use actual weighted contributions and partial coverage", () => {
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "hybrid",
    sourceFile: "core.yaml",
    scenarios: [],
    rubric: [
      {
        id: "R1",
        criterion: "hybrid",
        passCriteria: "both pass",
        weight: 1,
        tags: [],
        scenarios: ["S1"],
        grader: { type: "hybrid", autoShare: 0.9 },
      },
    ],
  };
  const make = (automatic: Verdict, manual?: Verdict) => {
    const result = report(automatic, [], null, 0);
    const input = omitUndefined({
      ...item("R1", automatic),
      score: undefined,
      components: { automatic, ...(manual === undefined ? {} : { manual }) },
    });
    const scored = scoreArea({
      spec,
      config: { scoring: { partialCredit: 0.25 } } as EvalConfig,
      evidence: [{ scenarioId: "S1", outcome: "completed" } as ScenarioEvidence],
      judgements: [input],
    });
    assert.equal(input.score, undefined, "scoring must not mutate original judgements");
    result.areas = [scored];
    result.overallScorePct = scored.scorePct;
    result.overallCoveragePct = scored.coveragePct;
    return result;
  };
  const result = compareReports(make("pass", "fail"), make("fail", "pass"));
  assert.equal(result.overall.scorePct.delta, -80);
  assert.equal(requireDefined(result.items[0], "result.items[0]").change, "regressed");
  assert.equal(requireDefined(result.items[0], "result.items[0]").scorePct.delta, -80);
  assert.equal(comparisonFailures(result, { failOnRegression: true }).length, 1);
  const pending = compareReports(make("pass", "fail"), make("pass"));
  assert.equal(requireDefined(pending.items[0], "pending.items[0]").change, "lost_coverage");
  assert.equal(requireDefined(pending.items[0], "pending.items[0]").coveragePct.delta, -10);
  assert.equal(comparisonFailures(pending, { failOnRegression: true }).length, 1);
  assert.equal(
    requireDefined(
      compareReports(make("pass"), make("partial")).items[0],
      'compareReports(make("pass"), make("partial")).items[0]',
    ).change,
    "regressed",
  );
  requireDefined(spec.rubric[0], "spec.rubric[0]").grader = { type: "hybrid", autoShare: 0.000001 };
  const smallDrop = compareReports(make("pass", "partial"), make("fail", "partial"));
  assert.deepEqual(requireDefined(smallDrop.items[0], "smallDrop.items[0]").scorePct, {
    baseline: 25,
    candidate: 25,
    delta: 0,
  });
  assert.equal(requireDefined(smallDrop.items[0], "smallDrop.items[0]").change, "regressed");
  assert.equal(comparisonFailures(smallDrop, { failOnRegression: true }).length, 1);
  const smallCoverageLoss = compareReports(make("pass", "pass"), make("cannot_judge", "pass"));
  assert.deepEqual(
    requireDefined(smallCoverageLoss.items[0], "smallCoverageLoss.items[0]").coveragePct,
    {
      baseline: 100,
      candidate: 100,
      delta: 0,
    },
  );
  assert.equal(
    requireDefined(smallCoverageLoss.items[0], "smallCoverageLoss.items[0]").change,
    "lost_coverage",
  );
  assert.equal(comparisonFailures(smallCoverageLoss, { failOnRegression: true }).length, 1);
});

test("comparison reports score, coverage, tag, and item-level changes", () => {
  const baseline = report(
    "base",
    [item("R1", "pass"), item("R2", "cannot_judge"), item("R4", "pass")],
    90,
    80,
  );
  const candidate = report(
    "candidate",
    [item("R1", "fail"), item("R2", "pass"), item("R3", "pass")],
    82,
    70,
  );
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.overall.scorePct.delta, -8);
  assert.equal(comparison.overall.coveragePct.delta, -10);
  assert.equal(comparison.summary.regressed, 1);
  assert.equal(comparison.summary.gained_coverage, 1);
  assert.equal(comparison.summary.added, 1);
  assert.equal(comparison.summary.removed, 1);
  assert.equal(requireDefined(comparison.tags[0], "comparison.tags[0]").scorePct.delta, -8);
  assert.equal(comparisonFailures(comparison, { failOnRegression: true }).length, 1);
  assert.deepEqual(comparisonFailures(comparison, { maxScoreDrop: 8, maxCoverageDrop: 10 }), []);
  assert.equal(comparisonFailures(comparison, { maxScoreDrop: 7, maxCoverageDrop: 9 }).length, 2);
});

test("semantic verdict regressions remain blocking when partial credit makes scores equal", () => {
  for (const [beforeVerdict, afterVerdict, points] of [
    ["pass", "partial", 1],
    ["partial", "fail", 0],
  ] as const) {
    const before = item("R1", beforeVerdict);
    const after = item("R1", afterVerdict);
    before.score = after.score = {
      earned: points,
      total: 1,
      judgeable: 1,
      scorePct: points * 100,
      coveragePct: 100,
    };
    const comparison = compareReports(
      report("before", [before], points * 100, 100),
      report("after", [after], points * 100, 100),
    );
    assert.equal(requireDefined(comparison.items[0], "comparison.items[0]").scorePct.delta, 0);
    assert.equal(requireDefined(comparison.items[0], "comparison.items[0]").change, "regressed");
    assert.equal(comparisonFailures(comparison, { failOnRegression: true }).length, 1);
  }
});

test("comparison artifacts can be loaded from run directories and written as JSON and HTML", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-compare-test-"));
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify(report("candidate", [], 100, 100)),
  );
  assert.equal(loadComparisonInput(runDir).report.runId, "candidate");
  const comparison = compareReports(report("base", [], 90, 90), loadComparisonInput(runDir).report);
  const artifacts = writeComparisonArtifacts(path.join(root, "out"), comparison);
  assert.equal(JSON.parse(fs.readFileSync(artifacts.json, "utf8")).candidate.runId, "candidate");
  assert.match(fs.readFileSync(artifacts.html, "utf8"), /evaluation comparison/);
});

test("withheld scores produce an unavailable, CI-failing score delta", () => {
  const baseline = report("base", [], 90, 90);
  const candidate = { ...report("candidate", [], 100, 40), scoreWithheld: true };
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.overall.scorePct.delta, null);
  assert.match(
    requireDefined(
      comparisonFailures(comparison, { maxScoreDrop: 0 })[0],
      "comparisonFailures(comparison, { maxScoreDrop: 0 })[0]",
    ),
    /score delta is unavailable/,
  );
});

test("comparison treats unproven automatic verdicts as unavailable", () => {
  const baseline = report("base", [item("R1", "pass")], 100, 100);
  const candidate = report("candidate", [item("R1", "fail")], null, 0);
  candidate.areas[0] = area(
    requireDefined(candidate.areas[0], "candidate.areas[0]").items,
    null,
    0,
    ["R1"],
  );

  const comparison = compareReports(baseline, candidate);
  assert.equal(
    requireDefined(comparison.items[0], "comparison.items[0]").candidateVerdict,
    "cannot_judge",
  );
  assert.equal(comparison.summary.regressed, 0);
  assert.equal(comparison.summary.lost_coverage, 1);
});

test("incompatible evaluator inputs withhold numeric deltas unless explicitly overridden", () => {
  const baseline = report("base", [item("R1", "pass")], 90, 90);
  const candidate = report("candidate", [item("R1", "fail")], 70, 80);
  candidate.receipt = receipt("different", "different-method");

  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.compatibility.status, "incompatible");
  assert.equal(requireDefined(comparison.items[0], "comparison.items[0]").change, "unavailable");
  assert.equal(comparison.summary.regressed, 0);
  assert.equal(comparison.overall.scorePct.delta, null);
  assert.match(comparison.compatibility.differences.join(" "), /configuration/);
  assert.match(
    requireDefined(
      comparisonFailures(comparison, { requireCompatible: true })[0],
      "comparisonFailures(comparison, { requireCompatible: true })[0]",
    ),
    /incompatible/,
  );

  const overridden = compareReports(baseline, candidate, { allowIncompatible: true });
  assert.equal(overridden.compatibility.overridden, true);
  assert.equal(overridden.overall.scorePct.delta, -20);
});

test("report loading rejects incomplete receipt-less artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-incomplete-report-"));
  const incomplete = { ...report("incomplete", [], 80, 80) } as Partial<RunReport>;
  delete incomplete.receipt;
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(incomplete));
  assert.throws(() => loadComparisonInput(root), /Invalid Agent Eval Kit report/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("saved report schemas reject malformed nested scores, gates, and evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-report-schema-"));
  try {
    for (const mutate of [
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").scorePct = 101;
      },
      (value: RunReport) => {
        requireDefined(value.byTag.workflow, "value.byTag.workflow").coveragePct = -1;
      },
      (value: RunReport) => {
        requireDefined(
          requireDefined(value.areas[0], "value.areas[0]").items[0],
          "value.areas[0].items[0]",
        ).evidenceRefs = [12 as unknown as string];
      },
      (value: RunReport) => {
        value.gates.blocking = [{ itemId: "R1" } as RunReport["gates"]["blocking"][number]];
      },
      (value: RunReport) => {
        delete requireDefined(
          requireDefined(value.areas[0], "value.areas[0]").items[0],
          "value.areas[0].items[0]",
        ).score;
      },
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").items.push(
          requireDefined(
            requireDefined(value.areas[0], "value.areas[0]").items[0],
            "value.areas[0].items[0]",
          ),
        );
      },
      (value: RunReport) => {
        requireDefined(
          requireDefined(value.areas[0], "value.areas[0]").items[0],
          "value.areas[0].items[0]",
        ).score!.earned = 2;
      },
      (value: RunReport) => {
        requireDefined(
          requireDefined(value.areas[0], "value.areas[0]").items[0],
          "value.areas[0].items[0]",
        ).score!.scorePct = 0;
      },
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").scorePct = 0;
      },
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").coveragePct = 50;
      },
      (value: RunReport) => {
        requireDefined(
          requireDefined(value.areas[0], "value.areas[0]").byTag.workflow,
          "value.areas[0].byTag.workflow",
        ).scorePct = 0;
      },
      (value: RunReport) => {
        requireDefined(value.byTag.workflow, "value.byTag.workflow").coveragePct = 50;
      },
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").byStratum.one = {
          ...slice(100, 100),
          cases: 1,
          scorePct: 0,
        };
      },
      (value: RunReport) => {
        value.byStratum.one = { ...slice(100, 100), cases: 1, coveragePct: 50 };
      },
      (value: RunReport) => {
        requireDefined(value.areas[0], "value.areas[0]").caseResults = [
          {
            areaId: "core",
            rubricId: "R1",
            caseId: "one",
            scenarioIds: [],
            strata: [],
            verdict: "fail",
            points: 1,
            confidence: "high",
            reasoning: "test",
            evidenceRefs: [],
            source: "llm",
          },
        ];
      },
    ]) {
      const invalid = report("invalid", [item("R1", "pass")], 100, 100);
      mutate(invalid);
      fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(invalid));
      assert.throws(() => loadComparisonInput(root), /Invalid Agent Eval Kit report/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("report loading rejects a sealed partial run missing a receipted area", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-partial-report-"));
  const partial = report("partial", [], 100, 100);
  partial.receipt.inputs.selection.areas = ["core", "later"];
  partial.receipt.inputs.specs.later = {
    file: "later.yaml",
    sha256: "l".repeat(64),
    bytes: 1,
  };
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(partial));
  assert.throws(() => loadComparisonInput(root), /Invalid Agent Eval Kit report/);
  assert.equal(loadResumableRunReport(root).report.runId, "partial");
  fs.rmSync(root, { recursive: true, force: true });
});

test("resume report loading rejects areas outside the run's selected set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-invalid-resume-report-"));
  const invalid = report("invalid-resume", [], 100, 100);
  invalid.receipt.inputs.selection.areas = ["later"];
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(invalid));
  assert.throws(() => loadResumableRunReport(root), /Invalid Agent Eval Kit report/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("saved reports preserve structured provider usage metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-usage-report-"));
  try {
    const saved = report("usage", [item("R1", "pass")], 100, 100);
    const usage = {
      input_tokens: 12,
      output_tokens_details: { reasoning_tokens: 4 },
      service_tier: "standard",
      iterations: [{ tokens: 3 }],
    };
    requireDefined(saved.areas[0], "saved.areas[0]").scenarios.push({
      scenarioId: "S1",
      scenarioName: "Usage",
      kind: "workspace",
      outcome: "completed",
      summary: "Done",
      observations: [],
      evidenceRefs: [],
      transcript: [],
      screenshots: [],
      artifacts: {},
      provider: "claude",
      startedAt: "now",
      finishedAt: "now",
      durationMs: 1,
      usage,
    });
    fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(saved));
    assert.deepEqual(
      requireDefined(
        requireDefined(
          loadComparisonInput(root).report.areas[0],
          "loadComparisonInput(root).report.areas[0]",
        ).scenarios[0],
        "loadComparisonInput(root).report.areas[0].scenarios[0]",
      ).usage,
      usage,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
