import { requireDefined, omitUndefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { attachDiagnostics, readDiagnostics } from "../src/browser/diagnostics.js";
import {
  captureSchema,
  controlledScreenshotLabels,
  distinctnessSchema,
  imageRegressionSchema,
  pairwiseSchema,
  votingSchema,
} from "../src/visual/contracts.js";
import { assertPairInspection } from "../src/visual/pairwise.js";
import { decideVotes, pairwiseVoteVerdict, rubricVoteVerdict } from "../src/visual/votes.js";
import { validateVisualInputs, visualEvidenceReader } from "../src/visual/inputs.js";
import { loadConfig } from "../src/config.js";
import { writeJson } from "../src/io.js";
import type { EvalSpec, Grader, ScenarioEvidence } from "../src/types.js";

test("non-abstaining pair judgements require both successful image views and valid transcripts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-inspection-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "evidence-transcript.ndjson");
  const entry = (reference: string, isError = false) =>
    JSON.stringify({
      at: new Date().toISOString(),
      tool: "view_screenshot",
      reference,
      result: "Viewed",
      isError,
    });
  assert.throws(() => assertPairInspection(directory, "A"), /contract violation.*missing A, B/);
  assert.doesNotThrow(() => assertPairInspection(directory, "abstain"));
  fs.writeFileSync(file, `${entry("A")}\n${entry("B", true)}\n`);
  assert.throws(() => assertPairInspection(directory, "equivalent"), /missing B/);
  fs.appendFileSync(file, `${entry("B")}\n`);
  for (const preferred of ["A", "B", "equivalent", "abstain"] as const)
    assert.doesNotThrow(() => assertPairInspection(directory, preferred));
  fs.writeFileSync(file, '{"reference":"A"}\n');
  assert.throws(
    () => assertPairInspection(directory, "abstain"),
    /Invalid image-view transcript record/,
  );
  fs.writeFileSync(file, "not JSON\n");
  assert.throws(() => assertPairInspection(directory, "B"), /Invalid image-view transcript JSON/);
});

test("missing started streams and malformed diagnostics raise errors before ignored-event filtering", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-diagnostic-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = { failOn: ["http" as const], ignoreUrls: ["example.test"] };
  assert.deepEqual(readDiagnostics(directory, policy).checks, []);
  const page = Object.assign(new EventEmitter(), { url: () => "https://example.test" });
  attachDiagnostics(page as unknown as Page, directory, { count: 0 });
  const file = path.join(directory, "browser-diagnostics.ndjson");
  assert.equal(
    requireDefined(
      readDiagnostics(directory, policy).checks[0],
      "readDiagnostics(directory, policy).checks[0]",
    ).pass,
    true,
  );
  fs.rmSync(file);
  assert.throws(() => readDiagnostics(directory, policy), /missing after recording started/);
  assert.throws(
    () => attachDiagnostics(page as unknown as Page, directory, { count: 0 }),
    /missing after recording started/,
  );
  const good = {
    kind: "http",
    at: new Date().toISOString(),
    message: "HTTP 503",
    url: "https://example.test",
    status: 503,
  };
  for (const invalid of [
    null,
    { ...good, kind: "htp" },
    { ...good, at: undefined },
    { ...good, status: undefined },
    { ...good, status: "503" },
    { ...good, extra: true },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid) + "\n");
    assert.throws(
      () => readDiagnostics(directory, policy),
      /Invalid browser diagnostic record:.*:1:/,
    );
  }
  fs.writeFileSync(file, "{\n");
  assert.throws(() => readDiagnostics(directory, policy), /Invalid browser diagnostic JSON/);
  fs.writeFileSync(file, JSON.stringify(good) + "\n");
  assert.equal(
    requireDefined(
      readDiagnostics(directory, policy).checks[0],
      "readDiagnostics(directory, policy).checks[0]",
    ).pass,
    true,
    "valid ignored errors remain excluded",
  );
  assert.equal(
    requireDefined(
      readDiagnostics(directory, { ...policy, ignoreUrls: [] }).checks[0],
      "readDiagnostics(directory, { ...policy, ignoreUrls: [] }).checks[0]",
    ).pass,
    false,
  );
});

test("controlled screenshot labels are validated before reference resolution for every image grader", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-label-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    "version: 1\nproject: {name: Labels}\ntarget: {kind: web, url: 'http://127.0.0.1:4188'}\nagent: {provider: mock}\njudge: {provider: mock}\n",
  );
  const config = loadConfig(configFile),
    capture = captureSchema.parse({ frames: 2, passes: 2 });
  assert.deepEqual(controlledScreenshotLabels(capture), [
    "frame-001",
    "frame-002",
    "contact-sheet",
    "pass-02/frame-001",
    "pass-02/frame-002",
    "pass-02/contact-sheet",
  ]);
  assert.deepEqual(controlledScreenshotLabels(captureSchema.parse({})), [
    "frame-001",
    "pass-02/frame-001",
  ]);
  const graders: Grader[] = [
    distinctnessSchema.parse({
      type: "image-distinctness",
      candidate: "frame-999",
      minimumDistance: 0.01,
    }),
    imageRegressionSchema.parse({
      type: "image-regression",
      candidate: "frame-999",
      baseline: "missing",
      metrics: { entropy: { mean: { min: -0.1 } } },
    }),
    pairwiseSchema.parse({
      type: "pairwise",
      candidate: "frame-999",
      references: [{ file: "missing.png" }],
      policy: "preference",
    }),
  ];
  const spec = {
    scenarios: [{ id: "SCENE", capture, dependsOn: [] }],
    rubric: [],
  } as unknown as EvalSpec;
  for (const grader of graders) {
    spec.rubric = [{ id: "CHECK", scenarios: ["SCENE"], grader } as EvalSpec["rubric"][number]];
    await assert.rejects(
      validateVisualInputs(config, [spec]),
      /invalid controlled screenshot label frame-999/,
    );
  }
  const grader = requireDefined(graders[0], "graders[0]");
  if (grader.type !== "image-distinctness") throw new Error("Expected distinctness grader");
  requireDefined(spec.rubric[0], "spec.rubric[0]").grader = grader;
  for (const label of controlledScreenshotLabels(capture)) {
    grader.candidate = label;
    await validateVisualInputs(config, [spec]);
  }
  for (const label of ["frame-1", "pass-01/frame-001", "pass-03/frame-001"]) {
    grader.candidate = label;
    await assert.rejects(
      validateVisualInputs(config, [spec]),
      /invalid controlled screenshot label/,
    );
  }
});

test("completed controlled captures require their screenshot while agent and blocked evidence can be unavailable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-required-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, "receipt.json"), { inputs: {} });
  writeJson(path.join(root, "artifact-index.json"), { entries: [] });
  const reader = visualEvidenceReader(root);
  const controlled = {
    scenarioId: "SCENE",
    collector: "controlled",
    outcome: "completed",
    screenshots: [],
  } as unknown as ScenarioEvidence;
  assert.throws(
    () => reader.candidate(controlled, "frame-001"),
    /Completed controlled capture SCENE is missing required screenshot/,
  );
  assert.equal(
    reader.candidate(omitUndefined({ ...controlled, collector: undefined }), "frame-001"),
    undefined,
  );
  assert.equal(reader.candidate({ ...controlled, outcome: "blocked" }, "frame-001"), undefined);
});

test("vote conversion handles only valid terminal decisions and rejects unexpected outcomes", () => {
  for (const value of ["pass", "partial", "fail", "not_found"] as const)
    assert.equal(rubricVoteVerdict(value), value);
  assert.equal(rubricVoteVerdict("inconclusive"), "cannot_judge");
  for (const value of ["continue", "abstain", "unknown", "loss"])
    assert.throws(() => rubricVoteVerdict(value), /Unexpected terminal rubric/);
  for (const policy of ["preference", "non_regression"] as const) {
    assert.equal(pairwiseVoteVerdict("pass", policy), "pass");
    assert.equal(pairwiseVoteVerdict("loss", policy), "fail");
    assert.equal(pairwiseVoteVerdict("inconclusive", policy), "cannot_judge");
    for (const value of ["continue", "fail", "win", "abstain", "unknown"])
      assert.throws(() => pairwiseVoteVerdict(value, policy), /Unexpected terminal pairwise/);
  }
  assert.equal(pairwiseVoteVerdict("equivalent", "preference"), "fail");
  assert.throws(
    () => pairwiseVoteVerdict("equivalent", "non_regression"),
    /Unexpected equivalent decision/,
  );
  const policy = votingSchema.parse({});
  assert.throws(() => decideVotes(["unknown"], policy, ["pass"]), /Unexpected vote outcome/);
  assert.throws(
    () => decideVotes(["abstain"], policy, ["abstain"]),
    /Invalid accepted vote outcomes/,
  );
  assert.throws(() => decideVotes([], policy, ["pass", "pass"]), /Invalid accepted vote outcomes/);
  assert.throws(
    () => decideVotes(Array(10).fill("pass"), policy, ["pass"]),
    /exceeds maximumVotes/,
  );
});
