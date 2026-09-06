import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import type { Page } from "playwright";
import { attachDiagnostics, readDiagnostics } from "../src/browser/diagnostics.js";
import { snapshotVisualInputs, visualInputs } from "../src/visual/inputs.js";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { assertArtifactIntegrity } from "../src/integrity.js";

test("visual graders preserve unavailable coverage when earlier areas are skipped or dependency-blocked", async (t) => {
  for (const includeDependent of [false, true])
    await t.test(includeDependent ? "dependency-blocked" : "all skipped", async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-selected-visual-review-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.mkdirSync(path.join(root, "specs"));
      const configFile = path.join(root, "evalkit.yaml");
      fs.writeFileSync(
        configFile,
        "version: 1\nproject: {name: Selection}\ntarget: {kind: web, url: 'http://127.0.0.1:4188'}\nagent: {provider: mock}\njudge: {provider: mock}\npaths: {specs: specs}\n",
      );
      fs.writeFileSync(
        path.join(root, "specs/first.yaml"),
        `id: first
title: First
weight: 50
description: Unavailable visual area
scenarios:
  - {id: FIRST, name: First, instructions: Inspect}
  - {id: DEPENDENT, name: Dependent, instructions: Inspect, dependsOn: [FIRST]}
rubric:
  - id: DISTINCT
    criterion: Distinct images
    weight: 1
    scenarios: [FIRST, DEPENDENT]
    passCriteria: Distinct images
    grader: {type: image-distinctness, candidate: frame, minimumDistance: 0.01}
  - id: PAIR
    criterion: Readable image
    weight: 1
    scenarios: [FIRST, DEPENDENT]
    passCriteria: Readable image
    grader: {type: pairwise, candidate: frame, policy: non_regression, references: [{file: reference.png}]}
`,
      );
      fs.writeFileSync(
        path.join(root, "specs/second.yaml"),
        `id: second
title: Second
weight: 50
description: Selected area
scenarios:
  - {id: SELECTED, name: Selected, instructions: Inspect}
rubric:
  - id: CHECK
    criterion: Inspect
    weight: 1
    scenarios: [SELECTED]
    passCriteria: Inspected
`,
      );
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
        .png()
        .toFile(path.join(root, "reference.png"));
      const config = loadConfig(configFile),
        specs = loadSpecs(config.paths.specs);
      const result = await runEvaluation({
        config,
        configFile,
        specs,
        fixtures: {},
        scenarioIds: includeDependent ? ["DEPENDENT", "SELECTED"] : ["SELECTED"],
      });
      const [first, second] = result.report!.areas;
      assert.equal(requireDefined(first, "first").id, "first");
      assert.equal(requireDefined(first, "first").coveragePct, 0);
      assert.ok(
        requireDefined(first, "first").items.every((item) => item.verdict === "cannot_judge"),
      );
      assert.ok(
        requireDefined(first, "first").scenarios.every(
          (scenario) => scenario.outcome === "blocked",
        ),
      );
      assert.equal(
        requireDefined(requireDefined(second, "second").scenarios[0], "second.scenarios[0]")
          .outcome,
        "completed",
      );
      assertArtifactIntegrity(result.runDir, { require: true });
    });
});

test("browser diagnostics distinguish unobserved from quiet and share the event limit across pages", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-diagnostic-review-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = { failOn: ["pageerror" as const], ignoreUrls: [] };
  assert.deepEqual(readDiagnostics(directory, policy).checks, []);
  const budget = { count: 0 };
  const pages = [0, 1].map(() =>
    Object.assign(new EventEmitter(), { url: () => "https://example.test" }),
  );
  for (const page of pages) attachDiagnostics(page as unknown as Page, directory, budget);
  assert.deepEqual(readDiagnostics(directory, policy).checks, [
    { name: "browser.pageerror", pass: true, actual: 0, expected: 0 },
  ]);
  for (const page of pages)
    for (let i = 0; i < 600; i++) page.emit("pageerror", new Error("broken render"));
  assert.equal(
    fs.readFileSync(path.join(directory, "browser-diagnostics.ndjson"), "utf8").trim().split("\n")
      .length,
    1000,
  );
  assert.throws(() => readDiagnostics(directory, policy), /overflow/);
});

test("visual snapshots reject changed reference bytes against the already-created receipt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-snapshot-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "evalkit.yaml"),
    `version: 1\nproject: {name: Snapshot}\ntarget: {kind: web, url: 'http://127.0.0.1:4188'}\nagent: {provider: mock}\njudge: {provider: mock}\npaths: {specs: spec.yaml}\n`,
  );
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    `id: visual\ntitle: Visual\nweight: 100\ndescription: Snapshot reference\nscenarios:\n  - {id: SCENE, name: Scene, instructions: Capture}\nrubric:\n  - id: DESIGN\n    criterion: Readable\n    weight: 1\n    scenarios: [SCENE]\n    passCriteria: Readable\n    grader:\n      type: pairwise\n      candidate: frame\n      policy: non_regression\n      references: [{file: reference.png}]\n`,
  );
  const reference = path.join(root, "reference.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
    .png()
    .toFile(reference);
  const config = loadConfig(path.join(root, "evalkit.yaml")),
    specs = loadSpecs(path.join(root, "spec.yaml"));
  const receipt = visualInputs(config, specs);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000000" } })
    .png()
    .toFile(reference);
  const runDir = path.join(root, "run");
  assert.throws(
    () => snapshotVisualInputs(config, specs, runDir, "all", receipt),
    /changed after receipt creation/,
  );
  assert.equal(fs.existsSync(path.join(runDir, "inputs/visual")), false);
  snapshotVisualInputs(config, specs, runDir, "all", visualInputs(config, specs));
  assert.equal(fs.readdirSync(path.join(runDir, "inputs/visual")).length, 1);
});

test("resume cannot reuse sealed scenarios on a changed startup target before the first area report", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aek-partial-target-review-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const ready = path.join(base, "ready"),
    fail = path.join(base, "fail");
  fs.writeFileSync(fail, "fail first judge");
  fs.writeFileSync(path.join(root, "application.txt"), "0");
  fs.writeFileSync(
    path.join(root, "start.cjs"),
    `const fs=require('node:fs');fs.writeFileSync('application.txt',String(Number(fs.readFileSync('application.txt','utf8'))+1));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    path.join(root, "ready.cjs"),
    `process.exit(require('node:fs').existsSync(${JSON.stringify(ready)})?0:1);`,
  );
  fs.writeFileSync(
    path.join(root, "grade.cjs"),
    `process.exit(require('node:fs').existsSync(${JSON.stringify(fail)})?19:0);`,
  );
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    `version: 1\nproject: {name: Partial target}\ntarget:\n  kind: repository\n  start: {command: 'node start.cjs'}\n  ready: {command: 'node ready.cjs', timeoutSeconds: 5, intervalMs: 20}\nagent: {provider: mock}\njudge: {provider: mock}\npaths: {specs: spec.yaml}\n`,
  );
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    `id: core\ntitle: Core\nweight: 100\ndescription: First-area failure\nscenarios:\n  - {id: SCENE, name: Scene, instructions: Inspect}\nrubric:\n  - id: CHECK\n    criterion: Check\n    weight: 1\n    scenarios: [SCENE]\n    passCriteria: Check passes\n    grader: {type: command, methodFiles: [], output: exit-code, command: 'node grade.cjs'}\n`,
  );
  const config = loadConfig(configFile),
    specs = loadSpecs(config.paths.specs);
  const options = { config, configFile, specs, fixtures: {} };
  await assert.rejects(runEvaluation(options), /unexpected exit code 19/);
  const runDir = path.join(
    config.paths.runs,
    requireDefined(fs.readdirSync(config.paths.runs)[0], "fs.readdirSync(config.paths.runs)[0]"),
  );
  assert.equal(fs.existsSync(path.join(runDir, "SCENE/evidence.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "report.json")), false);
  fs.rmSync(fail);
  fs.rmSync(ready);
  await assert.rejects(
    runEvaluation({ ...options, resumeDir: runDir }),
    /Target startup changed the target revision while prior evidence was eligible for reuse/,
  );
});
