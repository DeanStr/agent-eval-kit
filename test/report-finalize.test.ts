import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertArtifactIntegrity } from "../src/integrity.js";
import {
  finalizeReport,
  recoverInterruptedReportUpdate,
  writeManualFiles,
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

const receipt: RunReceipt = {
  schemaVersion: 1,
  evaluationFingerprint: "e".repeat(64),
  inputFingerprint: "i".repeat(64),
  inputs: {
    config: { sha256: "c".repeat(64), bytes: 1 },
    methodSha256: "m".repeat(64),
    specs: { area: { file: "spec.yaml", sha256: "s".repeat(64), bytes: 1 } },
    selection: { areas: ["area"] },
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

test("finalizing an unproven hybrid result scores only its manual share", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-finalize-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Finalize", root: runDir },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: runDir, runs: runDir, auth: runDir },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "area",
    title: "Area",
    weight: 100,
    optional: false,
    description: "Hybrid finalization",
    sourceFile: path.join(runDir, "spec.yaml"),
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
        id: "H1",
        criterion: "Side effect happened",
        weight: 4,
        tags: ["side-effect"],
        scenarios: ["S1"],
        grader: { type: "hybrid", autoShare: 0.25 },
        passCriteria: "It happened",
        manualInstructions: "Verify externally",
      },
    ],
  };
  const blocked: ScenarioEvidence = {
    scenarioId: "S1",
    scenarioName: "Blocked",
    kind: "workspace",
    outcome: "blocked",
    summary: "Could not reach the feature",
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
    id: "H1",
    verdict: "fail",
    confidence: "low",
    reasoning: "Not observed because the scenario was blocked",
    evidenceRefs: [],
    source: "llm",
  };
  const area = scoreArea({ spec, judgements: [automatic], evidence: [blocked], config });
  const report = buildReport({
    runId: "run",
    startedAt: blocked.startedAt,
    config,
    areas: [area],
    receipt,
  });
  for (const items of [
    [],
    [{ ...area.items[0], components: undefined }],
    [{ ...area.items[0], components: { automatic: "invalid" as "pass" } }],
  ]) {
    const malformed = { ...report, areas: [{ ...area, items }] };
    assert.throws(
      () => finalizeReport({ runDir, report: malformed, specs: [spec], config, reviewer: "alice" }),
      /missing a valid automatic component/,
    );
    assert.equal(fs.existsSync(path.join(runDir, "manual-revisions.ndjson")), false);
  }
  const retainedEvidence = path.join(runDir, "retained-evidence.txt");
  fs.writeFileSync(retainedEvidence, "trusted evidence");

  const prototypeSpec: EvalSpec = {
    ...spec,
    rubric: [{ ...spec.rubric[0], id: "__proto__", grader: { type: "manual" } }],
  };
  writeManualFiles(
    runDir,
    {
      ...report,
      areas: [{ ...area, items: [], pendingManual: ["__proto__"] }],
    },
    [prototypeSpec],
  );
  const prototypeManual = JSON.parse(
    fs.readFileSync(path.join(runDir, "manual-results.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(prototypeManual, "__proto__"), true);
  // biome-ignore lint/suspicious/noProto: Verify an own property named __proto__ survives serialization.
  assert.equal(prototypeManual.__proto__.verdict, "pass | partial | fail | not_found");

  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ UNKNOWN: { verdict: "pass" } }),
  );
  assert.throws(
    () => finalizeReport({ runDir, report, specs: [spec], config, reviewer: "alice" }),
    /Unknown or non-manual rubric.*UNKNOWN/,
  );
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ H1: { verdict: "approved" } }),
  );
  assert.throws(
    () => finalizeReport({ runDir, report, specs: [spec], config, reviewer: "alice" }),
    /Invalid manual verdict for H1/,
  );
  const originalUser = process.env.USER;
  const originalUsername = process.env.USERNAME;
  delete process.env.USER;
  delete process.env.USERNAME;
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ H1: { verdict: "pass" } }),
  );
  try {
    assert.throws(
      () => finalizeReport({ runDir, report, specs: [spec], config }),
      /requires --reviewer/,
    );
  } finally {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalUsername === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = originalUsername;
  }
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ H1: { verdict: "pass", notes: "Verified" } }),
  );

  const changedConfig: EvalConfig = {
    ...config,
    project: { ...config.project, name: "Renamed after the run" },
    target: { ...config.target, url: "https://different.example.test" },
  };
  const finalized = finalizeReport({
    runDir,
    report,
    specs: [spec],
    config: changedConfig,
    reviewer: "alice",
  });
  assert.equal(finalized.project, "Finalize");
  assert.deepEqual(finalized.target, report.target);
  assert.deepEqual(finalized.providers, report.providers);
  assert.deepEqual(finalized.areas[0].items[0].components, {
    automatic: "cannot_judge",
    manual: "pass",
  });
  assert.equal(finalized.areas[0].items[0].verdict, "cannot_judge");
  assert.equal(finalized.areas[0].earned, 3);
  assert.equal(finalized.areas[0].judgeable, 3);
  assert.equal(finalized.areas[0].scorePct, 100);
  assert.equal(finalized.areas[0].coveragePct, 75);
  assert.equal(finalized.areas[0].pendingManual.length, 0);
  const firstRevision = JSON.parse(
    fs.readFileSync(path.join(runDir, "manual-revisions.ndjson"), "utf8").trim(),
  );
  assert.equal(firstRevision.reviewer, "alice");
  assert.equal(firstRevision.previousHash, undefined);
  assert.match(firstRevision.revisionHash, /^[a-f0-9]{64}$/);
  const manual = JSON.parse(fs.readFileSync(path.join(runDir, "manual-results.json"), "utf8"));
  manual.H1.verdict = "fail";
  manual.H1.notes = "A second reviewer found no delivery";
  fs.writeFileSync(path.join(runDir, "manual-results.json"), JSON.stringify(manual));

  const revised = finalizeReport({
    runDir,
    report: finalized,
    specs: [spec],
    config,
    reviewer: "bob",
  });
  assert.equal(revised.areas[0].items[0].components?.manual, "fail");
  const revisions = fs
    .readFileSync(path.join(runDir, "manual-revisions.ndjson"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].reviewer, "bob");
  assert.equal(revisions[1].previousHash, revisions[0].revisionHash);

  manual.H1.verdict = "pass";
  manual.H1.notes = "Recovery confirmed delivery";
  fs.writeFileSync(path.join(runDir, "manual-results.json"), JSON.stringify(manual));
  const reportFile = path.join(runDir, "report.json");
  const reportBackup = path.join(
    os.tmpdir(),
    `aek-report-backup-${process.pid}-${Date.now()}.json`,
  );
  fs.renameSync(reportFile, reportBackup);
  fs.mkdirSync(reportFile);
  try {
    assert.throws(
      () => finalizeReport({ runDir, report: revised, specs: [spec], config, reviewer: "carol" }),
      /EISDIR|directory|exist/i,
    );
  } finally {
    fs.rmdirSync(reportFile);
    fs.renameSync(reportBackup, reportFile);
  }
  assert.throws(
    () => assertArtifactIntegrity(runDir, { require: true }),
    /integrity verification failed/i,
  );
  fs.writeFileSync(retainedEvidence, "tampered evidence");
  assert.throws(() => recoverInterruptedReportUpdate(runDir), /other artifacts changed/i);
  fs.writeFileSync(retainedEvidence, "trusted evidence");
  assert.equal(recoverInterruptedReportUpdate(runDir), true);
  assert.doesNotThrow(() => assertArtifactIntegrity(runDir, { require: true }));
  const recovered = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  assert.equal(recovered.areas[0].items[0].components.manual, "pass");
  assert.equal(
    fs.readFileSync(path.join(runDir, "manual-revisions.ndjson"), "utf8").trim().split(/\r?\n/)
      .length,
    3,
  );

  const rescoredLike = {
    ...recovered,
    areas: recovered.areas.map((candidate: { notes: string }) => ({
      ...candidate,
      notes: "rescored transaction",
    })),
  };
  const receiptFile = path.join(runDir, "receipt.json");
  const receiptBackup = path.join(
    os.tmpdir(),
    `aek-receipt-backup-${process.pid}-${Date.now()}.json`,
  );
  fs.renameSync(receiptFile, receiptBackup);
  fs.mkdirSync(receiptFile);
  try {
    assert.throws(
      () => writeReportArtifactsRecoverably(runDir, rescoredLike, [spec]),
      /EISDIR|directory|exist/i,
    );
  } finally {
    fs.rmdirSync(receiptFile);
    fs.renameSync(receiptBackup, receiptFile);
  }
  assert.equal(recoverInterruptedReportUpdate(runDir), true);
  assert.doesNotThrow(() => assertArtifactIntegrity(runDir, { require: true }));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8")).areas[0].notes,
    "rescored transaction",
  );
});

test("a zero automatic share can fully pass through manual finalization", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-manual-only-hybrid-"));
  const config = {
    version: 1,
    project: { name: "Manual hybrid", root: runDir },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: runDir, runs: runDir, auth: runDir },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 0 },
    variables: {},
  } satisfies EvalConfig;
  const spec: EvalSpec = {
    id: "area",
    title: "Area",
    weight: 100,
    optional: false,
    description: "Manual-only hybrid",
    sourceFile: "spec.yaml",
    scenarios: [],
    rubric: [
      {
        id: "H0",
        criterion: "Human check",
        weight: 1,
        tags: [],
        scenarios: [],
        gate: true,
        grader: { type: "hybrid", autoShare: 0 },
        passCriteria: "A human confirms it",
        manualInstructions: "Confirm it",
      },
    ],
  };
  const area = scoreArea({
    spec,
    judgements: [],
    evidence: [],
    config,
  });
  const report = buildReport({
    runId: "run",
    startedAt: "2026-01-01T00:00:00Z",
    config,
    areas: [area],
    receipt,
  });
  fs.writeFileSync(
    path.join(runDir, "manual-results.json"),
    JSON.stringify({ H0: { verdict: "pass", notes: "Confirmed" } }),
  );
  const finalized = finalizeReport({ runDir, report, specs: [spec], config, reviewer: "alice" });
  assert.equal(finalized.areas[0].items[0].verdict, "pass");
  assert.equal(finalized.areas[0].coveragePct, 100);
  assert.equal(finalized.areas[0].gates?.[0].status, "passed");
  assert.equal(finalized.gates?.passed, true);
});
