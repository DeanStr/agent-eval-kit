import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareReports,
  comparisonFailures,
  loadComparisonInput,
  loadResumableRunReport,
  writeComparisonArtifacts,
} from "../src/compare.js";
import type { AreaResult, JudgedItem, RunReceipt, RunReport, Verdict } from "../src/types.js";

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
});

const area = (items: JudgedItem[], scorePct: number | null, coveragePct: number, unproven: string[] = []): AreaResult => ({
  id: "core",
  title: "Core",
  weight: 100,
  optional: false,
  earned: 1,
  judgeable: 1,
  total: 1,
  scorePct,
  coveragePct,
  items,
  defects: [],
  notes: "",
  scenarios: [],
  pendingManual: [],
  unproven,
  byTag: { workflow: { earned: 1, judgeable: 1, total: 1, scorePct, coveragePct } },
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
  byTag: { workflow: { earned: 1, judgeable: 1, total: 1, scorePct, coveragePct } },
  byStratum: {},
  manualPending: 0,
  receipt: receipt(),
  gates: { passed: true, blocking: [] },
});

test("comparison reports score, coverage, tag, and item-level changes", () => {
  const baseline = report("base", [item("R1", "pass"), item("R2", "cannot_judge"), item("R4", "pass")], 90, 80);
  const candidate = report("candidate", [item("R1", "fail"), item("R2", "pass"), item("R3", "pass")], 82, 70);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.overall.scorePct.delta, -8);
  assert.equal(comparison.overall.coveragePct.delta, -10);
  assert.equal(comparison.summary.regressed, 1);
  assert.equal(comparison.summary.gained_coverage, 1);
  assert.equal(comparison.summary.added, 1);
  assert.equal(comparison.summary.removed, 1);
  assert.equal(comparison.tags[0].scorePct.delta, -8);
  assert.equal(comparisonFailures(comparison, { failOnRegression: true }).length, 1);
  assert.deepEqual(comparisonFailures(comparison, { maxScoreDrop: 8, maxCoverageDrop: 10 }), []);
  assert.equal(comparisonFailures(comparison, { maxScoreDrop: 7, maxCoverageDrop: 9 }).length, 2);
});

test("comparison artifacts can be loaded from run directories and written as JSON and HTML", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-compare-test-"));
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report("candidate", [], 100, 100)));
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
  assert.match(comparisonFailures(comparison, { maxScoreDrop: 0 })[0], /score delta is unavailable/);
});

test("comparison treats unproven automatic verdicts as unavailable", () => {
  const baseline = report("base", [item("R1", "pass")], 100, 100);
  const candidate = report("candidate", [item("R1", "fail")], null, 0);
  candidate.areas[0] = area(candidate.areas[0].items, null, 0, ["R1"]);

  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.items[0].candidateVerdict, "cannot_judge");
  assert.equal(comparison.summary.regressed, 0);
  assert.equal(comparison.summary.lost_coverage, 1);
});

test("incompatible evaluator inputs withhold numeric deltas unless explicitly overridden", () => {
  const baseline = report("base", [item("R1", "pass")], 90, 90);
  const candidate = report("candidate", [item("R1", "fail")], 70, 80);
  candidate.receipt = receipt("different", "different-method");

  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.compatibility.status, "incompatible");
  assert.equal(comparison.overall.scorePct.delta, null);
  assert.match(comparison.compatibility.differences.join(" "), /configuration/);
  assert.match(comparisonFailures(comparison, { requireCompatible: true })[0], /incompatible/);

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
