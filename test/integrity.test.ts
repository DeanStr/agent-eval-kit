import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifactIndex, writeArtifactIndex } from "../src/integrity.js";
import { sha256 } from "../src/io.js";

test("artifact indexes detect changed, missing, and unindexed outputs while allowing manual input edits", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-integrity-"));
  fs.mkdirSync(path.join(runDir, "S1"));
  fs.writeFileSync(path.join(runDir, "report.json"), "original report\n");
  fs.writeFileSync(path.join(runDir, "S1", "evidence.json"), "original evidence\n");
  fs.writeFileSync(path.join(runDir, "manual-results.json"), "{}\n");
  const index = writeArtifactIndex(runDir);
  assert.equal(index.entries.length, 2);
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);

  const indexFile = path.join(runDir, "artifact-index.json");
  const originalIndex = fs.readFileSync(indexFile);
  const metadataTamper = JSON.parse(originalIndex.toString("utf8"));
  metadataTamper.exclusions = ["everything"];
  fs.writeFileSync(indexFile, JSON.stringify(metadataTamper));
  assert.match(verifyArtifactIndex(runDir, { require: true }).errors.join(" "), /root checksum/);
  fs.writeFileSync(indexFile, originalIndex);

  fs.writeFileSync(path.join(runDir, "manual-results.json"), '{"R1":{"verdict":"pass"}}\n');
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);

  fs.writeFileSync(path.join(runDir, "report.json"), "tampered report\n");
  assert.match(verifyArtifactIndex(runDir, { require: true }).errors.join(" "), /checksum changed/);
  writeArtifactIndex(runDir);
  fs.writeFileSync(path.join(runDir, "unexpected.txt"), "not indexed\n");
  assert.match(
    verifyArtifactIndex(runDir, { require: true }).errors.join(" "),
    /Unindexed artifact/,
  );
});

test("artifact verification distinguishes optional from required missing indexes", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-integrity-missing-"));
  assert.equal(verifyArtifactIndex(runDir).ok, true);
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, false);
});

test("artifact indexes incrementally hash multi-megabyte files", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-integrity-large-"));
  const payload = Buffer.alloc(3 * 1024 * 1024, 0xab);
  fs.writeFileSync(path.join(runDir, "provider-events.ndjson"), payload);
  const index = writeArtifactIndex(runDir);
  assert.equal(requireDefined(index.entries[0], "index.entries[0]").bytes, payload.length);
  assert.equal(requireDefined(index.entries[0], "index.entries[0]").sha256, sha256(payload));
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);
});

test("every retryable scenario support file is classified as evidence", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-integrity-scenario-"));
  const scenario = path.join(runDir, "S1");
  fs.mkdirSync(path.join(scenario, "screenshots"), { recursive: true });
  for (const relative of [
    ".mcp.json",
    "scenario-output.schema.json",
    "observations.json",
    "outputs.json",
    "screenshots.json",
    ".storage-state.candidate.json",
    "screenshots/final.jpg",
  ]) {
    fs.writeFileSync(path.join(scenario, relative), "scenario output\n");
  }
  const index = writeArtifactIndex(runDir);
  assert.ok(index.entries.length > 0);
  assert.ok(
    index.entries.every((entry) => entry.role === "evidence"),
    JSON.stringify(index.entries, null, 2),
  );
});

test("valid artifact path components containing .tmp- remain integrity protected", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-integrity-tmp-id-"));
  const scenario = path.join(runDir, "checkout.tmp-v2");
  fs.mkdirSync(scenario);
  const evidence = path.join(scenario, "evidence.json");
  fs.writeFileSync(evidence, "original evidence\n");
  const index = writeArtifactIndex(runDir);
  assert.deepEqual(
    index.entries.map((entry) => entry.path),
    ["checkout.tmp-v2/evidence.json"],
  );
  fs.writeFileSync(evidence, "tampered evidence\n");
  assert.match(verifyArtifactIndex(runDir, { require: true }).errors.join(" "), /checksum changed/);
});
