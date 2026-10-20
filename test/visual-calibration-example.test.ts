import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertArtifactIntegrity } from "../src/integrity.js";

test("visual calibration rejects ambiguous and invalid options before creating evidence", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-visual-options-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const args of [
    ["--provider", "mock", "--provider", "codex"],
    ["--prepare-only", "--prepare-only"],
    ["--provider"],
    ["--unknown"],
  ]) {
    const destination = path.join(scratch, "experiment");
    const result = spawnSync(
      process.execPath,
      ["examples/visual/calibrate.mjs", destination, ...args],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Duplicate option|requires a value|Unknown option/);
    assert.equal(fs.existsSync(destination), false);
  }
});

test("visual calibration prepares sealed observations and separate criterion-bound reviewer labels without model calls", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-visual-labels-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const destination = path.join(scratch, "experiment");
  const result = spawnSync(
    process.execPath,
    ["examples/visual/calibrate.mjs", destination, "--prepare-only", "--provider", "mock"],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dataset = JSON.parse(fs.readFileSync(path.join(destination, "cases.json"), "utf8"));
  const labels = JSON.parse(fs.readFileSync(path.join(destination, "labels.json"), "utf8"));
  assert.equal(dataset.cases.length, 6);
  assert.equal(labels.labels.length, 6);
  assert.equal(
    new Set(
      dataset.cases.map((item: { evidence: { directory: string } }) => item.evidence.directory),
    ).size,
    3,
  );
  for (const item of dataset.cases) {
    const index = assertArtifactIntegrity(item.evidence.directory, { require: true })!;
    assert.equal(index.rootSha256, item.evidence.rootSha256);
    const label = labels.labels.find((entry: { caseId: string }) => entry.caseId === item.id);
    assert.equal(label.reviewer.kind, "agent");
    assert.equal(label.area, item.area);
    assert.equal(label.rubric, item.rubric);
    assert.equal(fs.existsSync(path.join(item.evidence.directory, "labels.json")), false);
  }
  const expected = Object.fromEntries(
    labels.labels.map((item: { caseId: string; evidence: { verdict: string } }) => [
      item.caseId,
      item.evidence.verdict,
    ]),
  );
  assert.equal(expected["blurred-world-fidelity"], "fail");
  assert.equal(expected["blurred-world-ui"], "pass");
  assert.equal(expected["unreadable-ui-fidelity"], "pass");
  assert.equal(expected["unreadable-ui-ui"], "fail");
});
