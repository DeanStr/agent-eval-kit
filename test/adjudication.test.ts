import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadComparisonInput } from "../src/compare.js";
import { assertArtifactIntegrity, writeArtifactIndex } from "../src/integrity.js";
import { sha256, stableJson, writeJson } from "../src/io.js";
import {
  adjudicateReport,
  finalizeReport,
  recoverInterruptedReportUpdate,
  writeReportArtifactsRecoverably,
} from "../src/report.js";
import { buildReport, scoreArea } from "../src/scoring.js";
import type {
  EvalConfig,
  EvalSpec,
  JudgedItem,
  RunReceipt,
  ScenarioEvidence,
} from "../src/types.js";

function fixture(t: { after(fn: () => void): void }, hybrid = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-adjudication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Adjudication", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root, references: path.join(root, "text-references") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "area",
    title: "Area",
    weight: 100,
    optional: false,
    description: "Review",
    sourceFile: path.join(root, "spec.yaml"),
    scenarios: [
      {
        id: "S1",
        name: "Blocked",
        instructions: "Try",
        successSignals: [],
        dependsOn: [],
        requiresAuth: false,
      },
    ],
    rubric: [
      {
        id: "R1",
        criterion: "The capability works",
        weight: 4,
        tags: ["capability"],
        scenarios: ["S1"],
        grader: hybrid ? { type: "hybrid", autoShare: 0.25 } : { type: "llm" },
        passCriteria: "Demonstrate the capability",
        gate: true,
      },
    ],
  };
  const scenario: ScenarioEvidence = {
    scenarioId: "S1",
    scenarioName: "Blocked",
    kind: "workspace",
    outcome: "blocked",
    summary: "Authentication unavailable",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
  };
  const automatic: JudgedItem = {
    id: "R1",
    verdict: "cannot_judge",
    confidence: "low",
    reasoning: "No authenticated observation",
    evidenceRefs: ["S1/evidence.json"],
    source: "llm",
  };
  const receipt: RunReceipt = {
    schemaVersion: 1,
    evaluationFingerprint: "e".repeat(64),
    inputFingerprint: "f".repeat(64),
    inputs: {
      config: { sha256: "c".repeat(64), bytes: 1 },
      methodSha256: "a".repeat(64),
      specs: { area: { file: "spec.yaml", sha256: "b".repeat(64), bytes: 1 } },
      selection: { areas: ["area"] },
      specMethods: { area: "b".repeat(64) },
    },
    target: { kind: "repository" },
    providers: {
      agent: { provider: "mock", cliVersion: "mock" },
      judge: { provider: "mock", cliVersion: "mock" },
    },
    runtime: {
      kitVersion: "0.4.0",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
  const area = scoreArea({
    spec,
    judgements: [automatic],
    evidence: [scenario],
    config,
    caseResults: [
      {
        areaId: "area",
        source: "llm",
        rubricId: "R1",
        caseId: "case-1",
        scenarioIds: ["S1"],
        strata: ["auth"],
        verdict: "cannot_judge",
        confidence: "low",
        reasoning: "Unavailable",
        evidenceRefs: [],
      },
    ],
  });
  const report = buildReport({
    runId: "run",
    startedAt: scenario.startedAt,
    config,
    areas: [area],
    receipt,
  });
  fs.mkdirSync(path.join(runDir, "S1"));
  writeJson(path.join(runDir, "S1/evidence.json"), scenario);
  writeReportArtifactsRecoverably(runDir, report, [spec]);
  const inputFile = path.join(root, "decisions.json");
  fs.writeFileSync(
    path.join(root, "review.txt"),
    "Verified authenticated capability with a fresh session",
  );
  const decision = {
    areaId: "area",
    itemId: "R1",
    previousRevision: null as string | null,
    verdict: "pass",
    rationale: "Verified the complete criterion",
    evidence: [
      {
        kind: "human",
        path: "review.txt",
        description: "Verification transcript",
        observedAt: "2026-01-02T00:00:00Z",
      },
    ] as Array<Record<string, string>>,
  };
  const write = (decisions = [decision]) => writeJson(inputFile, { schemaVersion: 1, decisions });
  write();
  const options = { runDir, report, config, specs: [spec], inputFile, reviewer: "alice" };
  return { root, runDir, config, spec, report, inputFile, decision, write, options };
}

test("human evidence resolves a blocked automatic abstention with retained provenance", (t) => {
  const f = fixture(t);
  const original = structuredClone(f.report.areas[0]!.items[0]!);
  const report = adjudicateReport(f.options);
  const item = report.areas[0]!.items[0]!;
  assert.equal(report.overallScorePct, 100);
  assert.equal(report.overallCoveragePct, 100);
  assert.equal(report.gates.passed, true);
  assert.equal(item.source, "adjudication");
  assert.deepEqual(item.adjudication!.original, original);
  assert.equal(item.adjudication!.originalSha256, sha256(stableJson(original)));
  assert.deepEqual(report.areas[0]!.scenarios, f.report.areas[0]!.scenarios);
  assert.deepEqual(report.byStratum, f.report.byStratum);
  assert.deepEqual(report.areas[0]!.caseResults, f.report.areas[0]!.caseResults);
  const artifact = item.adjudication!.evidence[0]!;
  assert.equal(artifact.kind, "human");
  assert.equal(
    fs.readFileSync(path.join(f.runDir, artifact.path), "utf8"),
    fs.readFileSync(path.join(f.root, "review.txt"), "utf8"),
  );
  const index = assertArtifactIntegrity(f.runDir, { require: true })!;
  assert.equal(index.entries.find((entry) => entry.path === artifact.path)!.role, "review");
  assert.deepEqual(loadComparisonInput(path.join(f.runDir, "report.json")).report, report);
  const html = fs.readFileSync(path.join(f.runDir, "report.html"), "utf8");
  assert.match(html, /Human adjudication: pass/);
  assert.match(html, /Original automatic result/);
  assert.match(
    fs.readFileSync(path.join(f.runDir, "adjudication-checklist.md"), "utf8"),
    new RegExp(item.adjudication!.revisionHash),
  );
});

test("hybrid adjudication preserves separate manual coverage through finalization and rescore", (t) => {
  const f = fixture(t, true);
  const reviewed = adjudicateReport(f.options);
  assert.equal(reviewed.overallCoveragePct, 25);
  assert.equal(reviewed.gates.passed, false);
  assert.equal(reviewed.manualPending, 1);
  assert.deepEqual(reviewed.areas[0]!.items[0]!.components, { automatic: "cannot_judge" });
  writeJson(path.join(f.runDir, "manual-results.json"), {
    R1: { verdict: "pass", notes: "Separate manual criterion verified" },
  });
  const finalized = finalizeReport({ ...f.options, report: reviewed, reviewer: "bob" });
  assert.equal(finalized.overallCoveragePct, 100);
  assert.equal(finalized.gates.passed, true);
  assert.equal(finalized.manualPending, 0);
  assert.deepEqual(
    finalized.areas[0]!.items[0]!.adjudication,
    reviewed.areas[0]!.items[0]!.adjudication,
  );
  const spec = structuredClone(f.spec);
  spec.rubric[0]!.grader = { type: "hybrid", autoShare: 0.5 };
  spec.rubric[0]!.weight = 8;
  const rescored = scoreArea({
    spec,
    config: f.config,
    judgements: finalized.areas[0]!.items,
    evidence: finalized.areas[0]!.scenarios,
  });
  assert.equal(rescored.earned, 8);
  assert.equal(rescored.coveragePct, 100);
  spec.rubric[0]!.criterion = "Different capability";
  assert.throws(
    () =>
      scoreArea({
        spec,
        config: f.config,
        judgements: rescored.items,
        evidence: rescored.scenarios,
      }),
    /does not match the automatic criterion/,
  );
});

test("corrections and withdrawal require the current revision and retain the original result", (t) => {
  const f = fixture(t);
  let report = adjudicateReport(f.options);
  const original = report.areas[0]!.items[0]!.adjudication!.original;
  assert.throws(() => adjudicateReport({ ...f.options, report }), /Stale previousRevision/);
  for (const verdict of ["partial", "fail", "cannot_judge", "pass"]) {
    f.decision.previousRevision = report.areas[0]!.items[0]!.adjudication!.revisionHash;
    f.decision.verdict = verdict;
    f.decision.evidence =
      verdict === "cannot_judge"
        ? []
        : [{ kind: "collected", path: "S1/evidence.json", description: "Reviewed collection" }];
    f.write();
    report = adjudicateReport({ ...f.options, report, reviewer: "bob" });
    assert.equal(report.overallCoveragePct, verdict === "cannot_judge" ? 0 : 100);
    assert.equal(
      report.overallScorePct,
      verdict === "pass" ? 100 : verdict === "partial" ? 50 : verdict === "fail" ? 0 : null,
    );
    assert.deepEqual(report.areas[0]!.items[0]!.adjudication!.original, original);
  }
  const revisions = fs
    .readFileSync(path.join(f.runDir, "adjudications.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(revisions.length, 5);
  assert.equal(revisions[1].previousHash, revisions[0].revisionHash);
  assert.equal(revisions[1].supersedes, revisions[0].revisionHash);
  assertArtifactIntegrity(f.runDir, { require: true });
});

test("invalid adjudication batches fail before publishing any changes", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.runDir, "artifact-index.json"));
  for (const change of [
    { verdict: "cannot_judge", evidence: [] },
    { verdict: "pass", evidence: [] },
    { rationale: " " },
    { itemId: "missing" },
    {
      evidence: [
        {
          kind: "collected",
          path: "report.json",
          description: "A report is not collection evidence",
        },
      ],
    },
    {
      evidence: [
        {
          kind: "human",
          path: "review.txt",
          description: "Future",
          observedAt: "2999-01-01T00:00:00Z",
        },
      ],
    },
    {
      evidence: [
        {
          kind: "human",
          path: "missing.txt",
          description: "Missing",
          observedAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
  ]) {
    writeJson(f.inputFile, { schemaVersion: 1, decisions: [{ ...f.decision, ...change }] });
    assert.throws(() => adjudicateReport(f.options));
    assert.deepEqual(fs.readFileSync(path.join(f.runDir, "artifact-index.json")), before);
    assert.equal(fs.existsSync(path.join(f.runDir, "adjudications.ndjson")), false);
    assert.equal(fs.existsSync(path.join(f.runDir, "adjudication-evidence")), false);
  }
  f.write([f.decision, { ...f.decision, itemId: "missing" }]);
  assert.throws(() => adjudicateReport(f.options), /Only existing automatic cannot_judge/);
  assert.deepEqual(fs.readFileSync(path.join(f.runDir, "artifact-index.json")), before);
  assert.equal(fs.existsSync(path.join(f.runDir, "adjudication-evidence")), false);
  f.write();
  assert.throws(() => adjudicateReport({ ...f.options, reviewer: " " }));
  const insideInput = path.join(f.runDir, "manual-results.json");
  fs.copyFileSync(f.inputFile, insideInput);
  assert.throws(
    () => adjudicateReport({ ...f.options, inputFile: insideInput }),
    /input must be outside the run directory/,
  );
  const invented = structuredClone(f.report);
  invented.areas[0]!.items[0]!.reasoning = "Changed";
  assert.throws(
    () => adjudicateReport({ ...f.options, report: invented }),
    /current indexed report/,
  );
});

test("decisive automatic results and declared manual criteria cannot be adjudicated", (t) => {
  for (const manual of [false, true]) {
    const f = fixture(t);
    const report = structuredClone(f.report);
    if (manual) f.spec.rubric[0]!.grader = { type: "manual" };
    else report.areas[0]!.items[0]!.verdict = "fail";
    writeJson(path.join(f.runDir, "report.json"), report);
    writeArtifactIndex(f.runDir);
    assert.throws(
      () => adjudicateReport({ ...f.options, report }),
      /Only existing automatic cannot_judge/,
    );
  }
});

test("changed attachments and broken audit history fail integrity and chain validation", (t) => {
  const f = fixture(t);
  const report = adjudicateReport(f.options);
  const record = report.areas[0]!.items[0]!.adjudication!;
  f.decision.previousRevision = record.revisionHash;
  f.write();
  const artifact = path.join(f.runDir, record.evidence[0]!.path);
  const original = fs.readFileSync(artifact);
  fs.writeFileSync(artifact, "tampered");
  assert.throws(
    () => adjudicateReport({ ...f.options, report }),
    /Artifact integrity verification failed/,
  );
  fs.writeFileSync(artifact, original);
  fs.writeFileSync(
    path.join(f.runDir, "adjudications.ndjson"),
    JSON.stringify({ ...record, rationale: "tampered" }) + "\n",
  );
  writeArtifactIndex(f.runDir);
  assert.throws(() => adjudicateReport({ ...f.options, report }), /checksum/);
});

test("an interrupted adjudication transaction recovers the report, history, and evidence together", (t) => {
  const f = fixture(t);
  const rename = fs.renameSync;
  let interrupted = false;
  fs.renameSync = (source, destination) => {
    if (!interrupted && String(destination) === path.join(f.runDir, "report.json")) {
      interrupted = true;
      throw new Error("simulated interruption");
    }
    return rename(source, destination);
  };
  try {
    assert.throws(() => adjudicateReport(f.options), /simulated interruption/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(interrupted, true);
  assert.equal(recoverInterruptedReportUpdate(f.runDir), true);
  const report = loadComparisonInput(path.join(f.runDir, "report.json")).report;
  assert.equal(report.overallCoveragePct, 100);
  assert.equal(report.areas[0]!.items[0]!.adjudication!.reviewer, "alice");
  assert.equal(
    fs.readFileSync(path.join(f.runDir, "adjudications.ndjson"), "utf8").trim().split("\n").length,
    1,
  );
  assertArtifactIntegrity(f.runDir, { require: true });
});

test("multi-item batches maintain a global history and independent per-item revisions", (t) => {
  const f = fixture(t);
  f.spec.rubric.push({ ...f.spec.rubric[0]!, id: "R2" });
  const area = f.report.areas[0]!;
  const original = area.items[0]!;
  const report = buildReport({
    runId: f.report.runId,
    startedAt: f.report.startedAt,
    config: f.config,
    receipt: f.report.receipt,
    areas: [
      scoreArea({
        spec: f.spec,
        config: f.config,
        evidence: area.scenarios,
        judgements: [original, { ...original, id: "R2" }],
      }),
    ],
  });
  writeReportArtifactsRecoverably(f.runDir, report, [f.spec]);
  f.write([f.decision, { ...f.decision, itemId: "R2", verdict: "not_found" }]);
  const reviewed = adjudicateReport({ ...f.options, report });
  assert.equal(reviewed.overallCoveragePct, 100);
  assert.equal(reviewed.overallScorePct, 50);
  const first = reviewed.areas[0]!.items[0]!.adjudication!;
  const second = reviewed.areas[0]!.items[1]!.adjudication!;
  assert.equal(first.previousHash, null);
  assert.equal(second.previousHash, first.revisionHash);
  assert.equal(second.supersedes, null);
  f.decision.previousRevision = first.revisionHash;
  f.decision.verdict = "fail";
  f.write();
  const corrected = adjudicateReport({ ...f.options, report: reviewed });
  const third = corrected.areas[0]!.items[0]!.adjudication!;
  assert.equal(third.previousHash, second.revisionHash);
  assert.equal(third.supersedes, first.revisionHash);
  assert.equal(corrected.overallScorePct, 0);
});

test("a prior adjudication remains withdrawable after rescore removes its automatic weight", (t) => {
  const f = fixture(t, true);
  const reviewed = adjudicateReport(f.options);
  f.spec.rubric[0]!.grader = { type: "hybrid", autoShare: 0 };
  const area = reviewed.areas[0]!;
  const report = buildReport({
    runId: reviewed.runId,
    startedAt: reviewed.startedAt,
    config: f.config,
    receipt: reviewed.receipt,
    areas: [
      scoreArea({
        spec: f.spec,
        config: f.config,
        evidence: area.scenarios,
        judgements: area.items,
      }),
    ],
  });
  writeReportArtifactsRecoverably(f.runDir, report, [f.spec]);
  f.decision.previousRevision = area.items[0]!.adjudication!.revisionHash;
  f.decision.verdict = "cannot_judge";
  f.decision.evidence = [];
  f.write();
  const withdrawn = adjudicateReport({ ...f.options, report });
  assert.equal(withdrawn.overallCoveragePct, 0);
  assert.equal(withdrawn.areas[0]!.items[0]!.adjudication!.verdict, "cannot_judge");
});

test("reindexing an altered review attachment does not replace its audited evidence receipt", (t) => {
  const f = fixture(t);
  const report = adjudicateReport(f.options);
  const record = report.areas[0]!.items[0]!.adjudication!;
  fs.writeFileSync(path.join(f.runDir, record.evidence[0]!.path), "changed evidence");
  writeArtifactIndex(f.runDir);
  f.decision.previousRevision = record.revisionHash;
  f.write();
  assert.throws(
    () => adjudicateReport({ ...f.options, report }),
    /no longer matches its recorded artifact/,
  );
});

test("manual finalization cannot turn an unproven decisive hybrid verdict into an adjudicable abstention", (t) => {
  const f = fixture(t, true);
  const area = f.report.areas[0]!;
  const item = {
    ...area.items[0]!,
    components: { automatic: "fail" as const },
    votes: { attempted: 1, judgeable: 1, counts: { fail: 1 }, decision: "decisive" },
  };
  const report = buildReport({
    runId: f.report.runId,
    startedAt: f.report.startedAt,
    config: f.config,
    receipt: f.report.receipt,
    areas: [
      scoreArea({ spec: f.spec, config: f.config, evidence: area.scenarios, judgements: [item] }),
    ],
  });
  writeReportArtifactsRecoverably(f.runDir, report, [f.spec]);
  writeJson(path.join(f.runDir, "manual-results.json"), {
    R1: { verdict: "pass", notes: "Verified manual share" },
  });
  const finalized = finalizeReport({ ...f.options, report });
  assert.equal(finalized.areas[0]!.items[0]!.components!.automatic, "fail");
  assert.deepEqual(finalized.areas[0]!.items[0]!.votes, item.votes);
  assert.equal(finalized.areas[0]!.items[0]!.verdict, "cannot_judge");
  assert.equal(finalized.overallCoveragePct, 75);
  assert.equal(finalized.gates.passed, false);
  assert.throws(
    () => adjudicateReport({ ...f.options, report: finalized }),
    /Only existing automatic cannot_judge/,
  );
});

test("finalizing a zero automatic share does not invent an abstention for a later rescore", (t) => {
  const f = fixture(t, true);
  f.spec.rubric[0]!.grader = { type: "hybrid", autoShare: 0 };
  const report = buildReport({
    runId: f.report.runId,
    startedAt: f.report.startedAt,
    config: f.config,
    receipt: f.report.receipt,
    areas: [scoreArea({ spec: f.spec, config: f.config, evidence: [], judgements: [] })],
  });
  writeReportArtifactsRecoverably(f.runDir, report, [f.spec]);
  writeJson(path.join(f.runDir, "manual-results.json"), {
    R1: { verdict: "pass", notes: "Verified manual share" },
  });
  const finalized = finalizeReport({ ...f.options, report });
  assert.deepEqual(finalized.areas[0]!.items[0]!.components, { manual: "pass" });
  f.spec.rubric[0]!.grader = { type: "hybrid", autoShare: 0.5 };
  assert.throws(
    () => adjudicateReport({ ...f.options, report: finalized }),
    /Only existing automatic cannot_judge/,
  );
});

test("report consumers reject missing, corrupted, or contradictory adjudication provenance", (t) => {
  const f = fixture(t);
  const report = adjudicateReport(f.options);
  for (const mutation of [
    (item: JudgedItem) => {
      delete item.adjudication;
    },
    (item: JudgedItem) => {
      item.adjudication!.rationale = "tampered";
    },
    (item: JudgedItem) => {
      item.verdict = "fail";
    },
  ]) {
    const changed = structuredClone(report);
    mutation(changed.areas[0]!.items[0]!);
    writeJson(path.join(f.runDir, "report.json"), changed);
    assert.throws(() => loadComparisonInput(f.runDir), /adjudication|Adjudication/);
  }
  const redacted = structuredClone(report);
  const item = redacted.areas[0]!.items[0]!;
  item.adjudicationReceipt = {
    verdict: item.adjudication!.verdict,
    revisionHash: item.adjudication!.revisionHash,
  };
  delete item.adjudication;
  writeJson(path.join(f.runDir, "report.json"), redacted);
  assert.deepEqual(loadComparisonInput(f.runDir).report, redacted);
  assert.throws(
    () =>
      scoreArea({
        spec: f.spec,
        config: f.config,
        judgements: [item],
        evidence: redacted.areas[0]!.scenarios,
      }),
    /Cannot score redacted adjudication provenance/,
  );
});

test("an aggregate abstention cannot replace a missing original automatic component", (t) => {
  const f = fixture(t, true);
  const report = adjudicateReport(f.options);
  for (const components of [{}, { manual: "cannot_judge" as const }]) {
    const changed = structuredClone(report);
    const record = changed.areas[0]!.items[0]!.adjudication!;
    record.original.components = components;
    record.originalSha256 = sha256(stableJson(record.original));
    const { revisionHash: _revisionHash, ...payload } = record;
    record.revisionHash = sha256(stableJson(payload));
    writeJson(path.join(f.runDir, "report.json"), changed);
    assert.throws(
      () => loadComparisonInput(f.runDir),
      /original result is missing its automatic component/,
    );
  }
});
