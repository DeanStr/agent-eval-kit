import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { judgeValidationHtml } from "../src/judge-validation-report.js";
import {
  validationConfigurationResults,
  type ValidationDataset,
  type ValidationLabels,
  type ValidationObservation,
} from "../src/judge-validation.js";
import { evidencePreviews } from "../src/report-presentation.js";
import type { ScenarioEvidence } from "../src/types.js";

test("validation HTML uses verified metadata for reviewer citations and retains error and pending semantics", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-validation-html-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const runDir = path.join(output, "attempts/first/one/runs/run");
  const collection = path.join(root, "collection");
  const reviewedDirectory = path.join(output, "review/evidence/one");
  for (const directory of [runDir, collection, reviewedDirectory]) {
    fs.mkdirSync(path.join(directory, "S1/shots"), { recursive: true });
    fs.writeFileSync(path.join(directory, "S1/evidence.json"), '{"unrelated":"UNRELATED_PASSAGE"}');
    fs.writeFileSync(path.join(directory, "S1/shots/selected.png"), "image fixture");
  }
  // Rendering must use the already-verified snapshot instead of reloading runs.
  fs.writeFileSync(path.join(runDir, "report.json"), "CORRUPTED_REPORT_DO_NOT_READ");
  const scenarios = [
    {
      scenarioId: "S1",
      kind: "browser",
      outcome: "completed",
      observations: ["UNRELATED_OBSERVATION", "The reviewed passage <quoted>"],
      checkpoints: { checked: { step: 3, evidenceRefs: ["step:1"] } },
      screenshots: [
        { path: "shots/selected.png", step: 1 },
        { path: "shots/unrelated.png", step: 2 },
      ],
      transcript: [{ step: 1, tool: "snapshot", result: "Selected checkpoint evidence" }],
    } as unknown as ScenarioEvidence,
  ];
  const refs = ["S1/evidence.json#observation-2", "S1/evidence.json#checkpoint-checked"];
  const dataset: ValidationDataset = {
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence: { directory: collection, rootSha256: "a".repeat(64) },
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
    ],
  };
  const labels: ValidationLabels = {
    version: 1,
    labels: [
      {
        caseId: "one",
        evidenceRootSha256: "a".repeat(64),
        area: "core",
        rubric: "CHECK",
        reviewer: { name: "Reviewer", kind: "human" },
        application: {
          verdict: "unknown",
          rationale: "No independent application observation",
          sources: ["Review note"],
        },
        evidence: { verdict: "pass", rationale: "Checkpoint supports the requirement", refs },
      },
    ],
  };
  const observations: ValidationObservation[] = [
    {
      caseId: "one",
      configuration: "first",
      split: "development",
      evidenceRootSha256: "a".repeat(64),
      status: "judged",
      actual: "partial",
      reasoning: "Configuration explanation <quoted>",
      evidenceRefs: refs,
      evaluationFingerprint: "b".repeat(64),
      runDir,
    },
    {
      caseId: "one",
      configuration: "error",
      split: "development",
      evidenceRootSha256: "a".repeat(64),
      status: "execution_error",
      error: "Provider failed <transport>",
    },
  ];
  const report = {
    inputs: { dataset: { path: path.join(root, "cases.json") } },
    plannedObservations: 3,
    observations,
    results: validationConfigurationResults(["first", "error", "pending"], observations, labels),
    limitations: [],
  };
  const evidence = new Map([[runDir, { scenarios, citations: evidencePreviews(refs, scenarios) }]]);
  const reviewedEvidence = new Map([
    ["one", { directory: reviewedDirectory, citations: evidencePreviews(refs, scenarios) }],
  ]);
  const html = judgeValidationHtml(report, dataset, labels, output, evidence, reviewedEvidence);
  const reviewed = html.slice(
    html.indexOf("<h3>Reviewed expectations"),
    html.indexOf('<div class="decisions">'),
  );
  assert.match(reviewed, /The reviewed passage &lt;quoted&gt;/);
  assert.match(reviewed, /Selected checkpoint evidence/);
  assert.match(reviewed, /src="review\/evidence\/one\/S1\/shots\/selected.png"/);
  assert.doesNotMatch(reviewed, /UNRELATED|unrelated.png/);
  assert.match(html, /Configuration explanation &lt;quoted&gt;/);
  assert.match(html, /Provider failed &lt;transport&gt;/);
  assert.match(html, /decision-coverage denominator/);
  assert.match(html, /Not attempted/);
  assert.match(html, /Comparison incomplete/);
  assert.match(html, /0\/0 \(unavailable\)/);
  assert.equal(report.results[1]!.metrics.decisionCoverage.denominator, 1);
  assert.equal(report.results[1]!.metrics.abstentions.count, 0);
  assert.equal(report.results[2]!.metrics.attempted, 0);
  assert.throws(
    () => judgeValidationHtml(report, dataset, labels, output, new Map(), reviewedEvidence),
    /Missing verified validation evidence for first\/one/,
  );
  fs.mkdirSync(path.join(collection, "areas/core/graders"), { recursive: true });
  fs.writeFileSync(
    path.join(collection, "areas/core/graders/CHECK.stdout.txt"),
    "TAMPERED_SOURCE_BYTES",
  );
  const failedLabels = structuredClone(labels);
  failedLabels.labels[0]!.evidence.refs = ["graders/CHECK.stdout.txt"];
  const failedObservations = observations.filter(
    (observation) => observation.status === "execution_error",
  );
  const failedReport = {
    ...report,
    observations: failedObservations,
    results: validationConfigurationResults(["error"], failedObservations, failedLabels),
  };
  const failedHtml = judgeValidationHtml(
    failedReport,
    dataset,
    failedLabels,
    output,
    new Map(),
    new Map(),
  );
  assert.match(failedHtml, /Reviewer evidence previews unavailable/);
  assert.doesNotMatch(failedHtml, /TAMPERED_SOURCE_BYTES/);
});
