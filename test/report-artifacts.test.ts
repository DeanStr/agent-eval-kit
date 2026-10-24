import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { shellQuote } from "../src/cli-recovery.js";
import {
  formatDuration,
  formatPct,
  formatPctDelta,
  formatTimestamp,
  plural,
} from "../src/format.js";
import { assertArtifactIntegrity } from "../src/integrity.js";
import {
  recoverInterruptedReportUpdate,
  writeReportArtifacts,
  writeReportArtifactsRecoverably,
} from "../src/report.js";
import { buildReport, scoreArea } from "../src/scoring.js";
import type {
  EvalConfig,
  EvalSpec,
  JudgedItem,
  RubricItem,
  RunReceipt,
  RunReport,
  ScenarioEvidence,
} from "../src/types.js";

const receipt: RunReceipt = {
  schemaVersion: 1,
  evaluationFingerprint: "e".repeat(64),
  inputFingerprint: "i".repeat(64),
  inputs: {
    config: { sha256: "c".repeat(64), bytes: 1 },
    methodSha256: "m".repeat(64),
    specs: { shop: { file: "shop.yaml", sha256: "s".repeat(64), bytes: 1 } },
    selection: { areas: ["shop"] },
    specMethods: { shop: "s".repeat(64) },
  },
  target: { kind: "repository" },
  providers: {
    agent: { provider: "mock", cliVersion: "mock 0.1.0" },
    judge: { provider: "mock", cliVersion: "mock 0.1.0" },
  },
  runtime: { kitVersion: "0.1.0", node: process.version, platform: "linux", arch: "x64" },
};

const evidence: ScenarioEvidence = {
  scenarioId: "S1",
  scenarioName: "Checkout",
  kind: "workspace",
  outcome: "completed",
  summary: "Checked out",
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

const criterion = (id: string, rest: Partial<RubricItem> = {}): RubricItem => ({
  id,
  criterion: `Criterion ${id}`,
  weight: 1,
  tags: ["general"],
  scenarios: ["S1"],
  grader: { type: "llm" },
  passCriteria: `${id} holds`,
  ...rest,
});

const judged = (id: string, verdict: JudgedItem["verdict"], rest: Partial<JudgedItem> = {}) =>
  ({
    id,
    verdict,
    confidence: "high",
    reasoning: `${id} reasoning`,
    evidenceRefs: [],
    source: "llm",
    ...rest,
  }) satisfies JudgedItem;

function fixture(t: TestContext, rubric: RubricItem[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-report-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // An apostrophe and a space prove printed commands are shell-quoted.
  const runDir = path.join(root, "owner's run");
  fs.mkdirSync(runDir);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Shop", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root, references: path.join(root, "references") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 50 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "shop",
    title: "Shop",
    weight: 100,
    optional: false,
    description: "Report artifacts",
    sourceFile: path.join(root, "shop.yaml"),
    scenarios: [
      {
        id: "S1",
        name: "Checkout",
        instructions: "Check out",
        successSignals: [],
        dependsOn: [],
        requiresAuth: false,
      },
    ],
    rubric,
  };
  const report = (judgements: JudgedItem[]): RunReport => ({
    ...buildReport({
      runId: "run-1",
      startedAt: "2026-01-01T00:00:00Z",
      config,
      areas: [scoreArea({ spec, judgements, evidence: [evidence], config })],
      receipt,
    }),
    finishedAt: "2026-01-01T00:01:05Z",
  });
  return { runDir, spec, report };
}

const read = (directory: string, file: string) =>
  fs.readFileSync(path.join(directory, file), "utf8");

test("display formatting rounds to one decimal and keeps exact values out of the way", () => {
  assert.equal(formatPct(86.66666), "86.7%");
  assert.equal(formatPct(100), "100%");
  assert.equal(formatPct(25.04), "25%");
  assert.equal(formatPct(null), "n/a");
  assert.equal(formatPctDelta(-13.333), "-13.3");
  assert.equal(formatPctDelta(12.5), "+12.5");
  assert.equal(formatPctDelta(0.01), "0");
  assert.equal(formatPctDelta(null), "n/a");
  assert.equal(formatTimestamp("2026-10-22T02:33:52.259Z"), "22 Oct 2026, 02:33 UTC");
  assert.equal(formatTimestamp("not recorded"), "not recorded");
  assert.equal(formatDuration(103), "0.1 s");
  assert.equal(formatDuration(295_051), "4 min 55 s");
  assert.equal(formatDuration(7_500_000), "2 h 5 min");
  assert.equal(plural(1, "item awaits", "items await"), "1 item awaits");
  assert.equal(plural(2, "vote"), "2 votes");
});

test("run reports lead with the project, explain gates, and collapse repeated-vote details", (t) => {
  const { runDir, spec, report } = fixture(t, [
    criterion("TOTAL", { gate: true }),
    criterion("QUANTITY", { gate: true }),
    criterion("EMPTY"),
    criterion("RECEIPT", { grader: { type: "manual" } }),
    criterion("REFUND", { grader: { type: "manual" } }),
  ]);
  const ballot = (verdict: "pass" | "partial", outcome: string, reasoning: string) => ({
    verdict,
    confidence: outcome === "abstain" ? ("low" as const) : ("high" as const),
    outcome,
    reasoning,
  });
  const result = report([
    judged("TOTAL", "pass", {
      reasoning: "Repeated judge: pass; 2/3 judgeable votes (pass 2, abstain 1). First vote",
      votes: {
        attempted: 3,
        judgeable: 2,
        counts: { pass: 2, abstain: 1 },
        decision: "pass",
        ballots: [
          ballot("pass", "pass", "First vote"),
          ballot("pass", "pass", "Second vote"),
          ballot("partial", "abstain", "Uncertain <third> vote"),
        ],
      },
    }),
    judged("QUANTITY", "fail"),
    judged("EMPTY", "pass"),
  ]);
  writeReportArtifacts(runDir, result, [spec]);
  const html = read(runDir, "report.html");
  assert.match(html, /<title>Shop · Evaluation report<\/title>/);
  assert.match(html, /<h1>Shop<\/h1><p class="subtitle">Evaluation report<\/p>/);
  assert.doesNotMatch(html, /Shop evaluation/);
  assert.match(html, /Started <time[^>]*>1 Jan 2026, 00:00 UTC<\/time> · took 1 min 5 s/);
  assert.equal(result.overallScorePct, 66.667, "JSON keeps the exact value");
  assert.match(html, /Score 66\.7%/);
  assert.doesNotMatch(html, /66\.667/);
  assert.match(html, /<div class="error"><p class="headline">Critical gate failure<\/p>/);
  assert.match(
    html,
    /<code>shop\/QUANTITY<\/code><\/a> Criterion QUANTITY — <strong>failed<\/strong>: Critical criterion received fail; critical gates require a full pass\./,
  );
  assert.doesNotMatch(html, /failed \(fail\)/);
  assert.match(
    html,
    /<span class="good"[^>]*>TOTAL — passed<\/span>, <span class="bad"[^>]*>QUANTITY — failed<\/span>/,
  );
  assert.match(html, /2 items await manual verification\./);
  assert.match(html, /<th>Earned \/ judged \/ total weight<\/th>/);
  assert.match(html, /<td>2 \/ 3 \/ 5<\/td>/);
  assert.doesNotMatch(html, /<h2>Tags<\/h2>|Diagnostic breakdown/, "the implicit tag is no slice");
  assert.match(
    html,
    /<details class="votes"><summary>3 votes: pass 2 · abstain 1 \(2 judgeable\)<\/summary><ol class="ballots">/,
  );
  assert.match(html, /low confidence · counted as abstain<br>Uncertain &lt;third&gt; vote/);
  assert.match(html, /\.criterion\{min-width:14rem\}/);
  assert.match(html, /body\{[^}]*overflow-wrap:break-word\}/);
  assert.doesNotMatch(html, /body\{[^}]*overflow-wrap:anywhere/);

  const checklist = read(runDir, "manual-checklist.md");
  assert.ok(checklist.includes(`aek finalize --run ${shellQuote(runDir)}`), checklist);
  assert.doesNotMatch(checklist, /<run-dir>/);
  assert.equal(fs.existsSync(path.join(runDir, "adjudication-checklist.md")), false);
});

test("the adjudication checklist exists only while automatic abstentions need review", (t) => {
  const { runDir, spec, report } = fixture(t, [criterion("R1"), criterion("R2")]);
  const checklist = path.join(runDir, "adjudication-checklist.md");
  writeReportArtifacts(runDir, report([judged("R1", "cannot_judge"), judged("R2", "pass")]), [
    spec,
  ]);
  assert.ok(
    read(runDir, "adjudication-checklist.md").includes(
      `aek adjudicate --run ${shellQuote(runDir)} --input <decisions.json> --reviewer <name>`,
    ),
  );
  let html = read(runDir, "report.html");
  assert.match(html, /href="adjudication-checklist.md"/);
  assert.doesNotMatch(html, /await manual verification|item\(s\)/);

  // A report update that leaves nothing to adjudicate removes the stale checklist atomically.
  const resolved = report([judged("R1", "pass"), judged("R2", "pass")]);
  const remove = fs.rmSync;
  let interrupted = false;
  fs.rmSync = ((target, options) => {
    if (!interrupted && String(target) === checklist) {
      interrupted = true;
      throw new Error("simulated interruption");
    }
    return remove(target, options);
  }) as typeof fs.rmSync;
  try {
    assert.throws(
      () => writeReportArtifactsRecoverably(runDir, resolved, [spec]),
      /simulated interruption/,
    );
  } finally {
    fs.rmSync = remove;
  }
  assert.ok(fs.existsSync(checklist));
  assert.equal(recoverInterruptedReportUpdate(runDir), true);
  assert.equal(fs.existsSync(checklist), false);
  assert.doesNotThrow(() => assertArtifactIntegrity(runDir, { require: true }));
  html = read(runDir, "report.html");
  assert.doesNotMatch(html, /adjudication-checklist\.md|lack sufficient evidence/);

  writeReportArtifactsRecoverably(runDir, report([judged("R1", "cannot_judge")]), [spec]);
  assert.ok(fs.existsSync(checklist), "a later abstention restores the checklist");
  assert.doesNotThrow(() => assertArtifactIntegrity(runDir, { require: true }));
});
