import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactHref, evidenceHtml, evidencePreviews } from "../src/report-presentation.js";
import type { ScenarioEvidence } from "../src/types.js";

test("artifact previews escape content, bound text, and reject references outside the run", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-report-presentation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run");
  fs.mkdirSync(path.join(runDir, "areas/core/graders"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "areas/core/graders/check.stdout.txt"),
    `<img onerror="unsafe">${"x".repeat(5000)}END`,
  );
  fs.writeFileSync(path.join(root, "private.txt"), "SECRET");
  const context = { outputDir: path.join(root, "output"), runDir, areaId: "core" };
  const html = evidenceHtml(
    [
      "graders/check.stdout.txt",
      "../private.txt",
      "javascript:alert(1)",
      "/private.txt",
      "missing.png",
    ].map((ref) => ({
      ref,
      scope: ref.startsWith("graders/") ? ("area" as const) : ("run" as const),
    })),
    context,
  );
  assert.match(html, /href="\.\.\/run\/areas\/core\/graders\/check.stdout.txt"/);
  assert.match(html, /&lt;img onerror=&quot;unsafe&quot;&gt;/);
  assert.match(html, /preview truncated/);
  assert.match(html, /artifact unavailable/);
  assert.doesNotMatch(html, /SECRET|END|<img|href="javascript/);
  assert.equal(artifactHref(context.outputDir, runDir, "../private.txt"), undefined);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(root, "private.txt"), path.join(runDir, "escape.txt"));
    assert.equal(artifactHref(context.outputDir, runDir, "escape.txt"), undefined);
  }
});

test("checkpoint previews expand only the exercised evidence steps", () => {
  const scenario = {
    scenarioId: "S1",
    kind: "browser",
    outcome: "completed",
    checkpoints: { checked: { step: 3, evidenceRefs: ["step:1"] } },
    screenshots: [
      { path: "shots/selected.png", step: 1 },
      { path: "shots/unrelated.png", step: 2 },
    ],
    transcript: [{ step: 1, tool: "snapshot", result: "Observed checkpoint" }],
  } as unknown as ScenarioEvidence;
  const previews = evidencePreviews(["S1/evidence.json#checkpoint-checked"], [scenario]);
  assert.ok(previews.some(({ ref }) => ref === "S1/shots/selected.png"));
  assert.ok(!previews.some(({ ref }) => ref.includes("unrelated")));
  assert.match(previews.find(({ ref }) => ref.endsWith("#step-1"))!.text!, /Observed checkpoint/);
});

test("unresolved fragment citations never preview a different passage", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-fragment-preview-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runDir, "evidence.json"), '{"unrelated":"DO_NOT_PREVIEW"}');
  const html = evidenceHtml(
    [
      "evidence.json#observation-20",
      "evidence.json#checkpoint-export.json",
      "evidence.json#checkpoint-notes.txt",
      "evidence.json#checkpoint-capture.png",
    ].map((ref) => ({ ref, scope: "run" as const })),
    {
      outputDir: runDir,
      runDir,
      areaId: "core",
    },
  );
  assert.match(html, /href="evidence.json#observation-20"/);
  assert.match(html, /href="evidence.json#checkpoint-export.json"/);
  assert.doesNotMatch(html, /DO_NOT_PREVIEW|<pre>|<img/);
});

test("Unicode and collected text previews preserve truncation notices", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-unicode-preview-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runDir, "unicode.txt"), "é".repeat(9000));
  const context = { outputDir: runDir, runDir, areaId: "core" };
  const html = evidenceHtml([{ ref: "unicode.txt", scope: "run" }], context);
  assert.match(html, /preview truncated/);
  assert.doesNotMatch(html, /�/);
  const scenario = {
    scenarioId: "S1",
    screenshots: [],
    transcript: [],
    files: [
      {
        path: "files/opaque",
        mediaType: "text/plain",
        text: { content: "collected excerpt", truncated: true },
      },
    ],
  } as unknown as ScenarioEvidence;
  const collected = evidenceHtml(evidencePreviews(["S1/files/opaque"], [scenario]));
  assert.match(collected, /collected excerpt/);
  assert.match(collected, /preview truncated/);
});

test("collected images with opaque artifact names retain image previews", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-image-preview-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runDir, "S1/files"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "S1/files/opaque"), "image fixture");
  const scenario = {
    scenarioId: "S1",
    screenshots: [],
    transcript: [],
    files: [{ path: "files/opaque", mediaType: "image/png" }],
  } as unknown as ScenarioEvidence;
  const html = evidenceHtml(evidencePreviews(["S1/files/opaque"], [scenario]), {
    outputDir: runDir,
    runDir,
    areaId: "core",
  });
  assert.match(html, /<img[^>]*src="S1\/files\/opaque"/);
});

test("a scenario named graders keeps run scope alongside area-local command evidence", (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-grader-scenario-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runDir, "graders/shots"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "areas/core/graders"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "graders/shots/cited.png"), "image fixture");
  fs.writeFileSync(path.join(runDir, "graders/evidence.json"), "{}");
  fs.writeFileSync(path.join(runDir, "areas/core/graders/CHECK.stdout.txt"), "Command output");
  const scenario = {
    scenarioId: "graders",
    kind: "browser",
    summary: "Scenario evidence",
    observations: [],
    transcript: [],
    screenshots: [{ path: "shots/cited.png", step: 1 }],
  } as unknown as ScenarioEvidence;
  const evidence = evidencePreviews(
    ["graders/shots/cited.png", "graders/evidence.json", "graders/CHECK.stdout.txt"],
    [scenario],
  );
  assert.deepEqual(
    evidence.map(({ scope }) => scope),
    ["run", "run", "area"],
  );
  const html = evidenceHtml(evidence, { outputDir: runDir, runDir, areaId: "core" });
  assert.match(html, /src="graders\/shots\/cited.png"/);
  assert.match(html, /href="graders\/evidence.json"/);
  assert.match(html, /href="areas\/core\/graders\/CHECK.stdout.txt"/);
  assert.match(html, /Command output/);
  assert.doesNotMatch(html, /artifact unavailable/);
});
