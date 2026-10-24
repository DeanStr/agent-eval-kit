import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPromotedBaselines, loadPromotedBaseline, promoteBaseline } from "../src/baselines.js";
import { writeArtifactIndex } from "../src/integrity.js";
import type { EvalConfig, RunReceipt, RunReport } from "../src/types.js";

function receipt(): RunReceipt {
  return {
    schemaVersion: 1,
    evaluationFingerprint: "e".repeat(64),
    inputFingerprint: "i".repeat(64),
    inputs: {
      config: { sha256: "c".repeat(64), bytes: 1 },
      methodSha256: "m".repeat(64),
      specs: { core: { file: "core.yaml", sha256: "s".repeat(64), bytes: 1 } },
      selection: { areas: ["core"] },
      specMethods: { core: "s".repeat(64) },
    },
    target: { kind: "repository", git: { commit: "a".repeat(40), dirty: false } },
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

function report(): RunReport {
  return {
    schemaVersion: 1,
    runId: "source-run",
    project: "Baseline test",
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
        scorePct: 100,
        coveragePct: 100,
        items: [],
        defects: [],
        notes: "",
        scenarios: [],
        pendingManual: [],
        unproven: [],
        byTag: {},
        byStratum: {},
        gates: [],
        caseResults: [],
      },
    ],
    overallScorePct: 100,
    overallCoveragePct: 100,
    scoreWithheld: false,
    byTag: {},
    byStratum: {},
    manualPending: 0,
    receipt: receipt(),
    gates: { passed: true, blocking: [] },
  };
}

function writeRunState(runDir: string, status: "running" | "complete"): void {
  fs.writeFileSync(
    path.join(runDir, "run-state.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      status,
      runId: path.basename(runDir),
      pid: 0,
      configFile: path.join(path.dirname(runDir), "evalkit.yaml"),
      startedAt: "2026-01-01T00:00:00Z",
      selectedAreas: [],
      specHashes: {},
      inputFingerprint: "i".repeat(64),
    })}\n`,
  );
}

test("baseline promotion preserves immutable snapshots behind an atomic named pointer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-baseline-"));
  const runDir = path.join(root, "runs", "source-run");
  fs.mkdirSync(runDir, { recursive: true });
  const sourceReport = report();
  sourceReport.target.url = "https://private.example.test/app?token=report-secret";
  sourceReport.receipt.target.url = "https://private.example.test/app?token=receipt-secret";
  const tally = { attempted: 1, judgeable: 1, counts: { pass: 1 }, decision: "pass" };
  sourceReport.areas[0]!.items = [
    {
      id: "R1",
      verdict: "pass",
      confidence: "high",
      reasoning: "Repeated judge: pass",
      evidenceRefs: [],
      source: "llm",
      score: { earned: 1, judgeable: 1, total: 1, scorePct: 100, coveragePct: 100 },
      votes: {
        ...tally,
        ballots: [
          {
            verdict: "pass",
            confidence: "high",
            outcome: "pass",
            reasoning: "vote-reasoning-secret",
          },
        ],
      },
    },
  ];
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(sourceReport, null, 2)}\n`);
  writeArtifactIndex(runDir);
  const config = {
    paths: { runs: path.join(root, "runs"), baselines: path.join(root, "evals", "baselines") },
  } as EvalConfig;

  assert.throws(
    () =>
      promoteBaseline({
        config,
        runDir,
        name: "main",
        reviewer: "alice",
        mode: "milestone",
        reason: "Reviewed fixture",
      }),
    /Run state does not exist/,
  );
  writeRunState(runDir, "running");
  assert.throws(
    () =>
      promoteBaseline({
        config,
        runDir,
        name: "main",
        reviewer: "alice",
        mode: "milestone",
        reason: "Reviewed fixture",
      }),
    /Only complete runs can be promoted; run status is running/,
  );
  writeRunState(runDir, "complete");

  const first = promoteBaseline({
    config,
    runDir,
    name: "main",
    reviewer: "alice",
    mode: "milestone",
    reason: "Reviewed fixture",
  });
  const loadedFirst = loadPromotedBaseline(config, "main");
  assert.equal(loadedFirst.promotion.reviewer, "alice");
  assert.equal(loadedFirst.report.target.url, undefined);
  assert.equal(loadedFirst.report.receipt.target.url, undefined);
  assert.equal(loadedFirst.promotion.target.url, undefined);
  assert.deepEqual(loadedFirst.report.areas[0]!.items[0]!.votes, tally, "ballots carry reasoning");
  for (const file of fs.readdirSync(first.directory)) {
    const contents = fs.readFileSync(path.join(first.directory, file), "utf8");
    assert.doesNotMatch(
      contents,
      /private\.example\.test|report-secret|receipt-secret|vote-reasoning-secret/,
    );
  }
  const second = promoteBaseline({
    config,
    runDir,
    name: "main",
    reviewer: "bob",
    mode: "milestone",
    reason: "Reviewed fixture",
  });
  assert.notEqual(second.directory, first.directory);
  assert.equal(fs.existsSync(first.directory), true);
  assert.equal(
    requireDefined(listPromotedBaselines(config)[0], "listPromotedBaselines(config)[0]").reviewer,
    "bob",
  );

  const promotionFile = path.join(second.directory, "promotion.json");
  const promotionBytes = fs.readFileSync(promotionFile);
  const changedPromotion = JSON.parse(promotionBytes.toString("utf8"));
  changedPromotion.reviewer = "mallory";
  fs.writeFileSync(promotionFile, `${JSON.stringify(changedPromotion)}\n`);
  assert.throws(() => loadPromotedBaseline(config, "main"), /metadata checksum changed/);
  fs.writeFileSync(promotionFile, promotionBytes);
  fs.writeFileSync(second.file, "{}\n");
  assert.throws(() => loadPromotedBaseline(config, "main"), /checksum changed/);
});
