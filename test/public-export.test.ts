import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifactIndex, writeArtifactIndex } from "../src/integrity.js";
import { writeJson } from "../src/io.js";
import { createPublicExport, privacyLint } from "../src/public-export.js";
import type { RunReceipt, RunReport } from "../src/types.js";

const receipt: RunReceipt = {
  schemaVersion: 1,
  evaluationFingerprint: "e".repeat(64),
  inputFingerprint: "i".repeat(64),
  inputs: {
    config: { sha256: "c".repeat(64), bytes: 1 },
    methodSha256: "m".repeat(64),
    specs: { core: { file: "core.yaml", sha256: "s".repeat(64), bytes: 1 } },
    selection: { areas: ["core"], split: "evaluation" },
  },
  target: { kind: "repository" },
  providers: {
    agent: { provider: "mock", cliVersion: "mock" },
    judge: { provider: "mock", cliVersion: "mock" },
  },
  runtime: { kitVersion: "0.1.0", node: process.version, platform: process.platform, arch: process.arch },
};

test("public export keeps aggregate and case results while excluding raw evidence and paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-public-"));
  const runDir = path.join(root, "runs", "run-one");
  fs.mkdirSync(runDir, { recursive: true });
  const report: RunReport = {
    schemaVersion: 1, runId: "run-one", project: "Demo", target: { kind: "repository", root: "/home/private/project" },
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z", kitVersion: "0.1.0",
    providers: { agent: { provider: "mock" }, judge: { provider: "mock" } },
    areas: [{
      id: "core", title: "Core", weight: 100, optional: false, earned: 1, judgeable: 1, total: 1, scorePct: 100, coveragePct: 100,
      items: [{ id: "R1", verdict: "pass", confidence: "high", reasoning: "secret internal reasoning", evidenceRefs: ["private/evidence"], source: "llm", score: { total: 1, earned: 1, judgeable: 1, scorePct: 100, coveragePct: 100 } }],
      caseResults: [{ areaId: "core", rubricId: "R1", caseId: "annual", scenarioIds: ["S--annual"], strata: ["plan=annual"], split: "evaluation", verdict: "pass", confidence: "high", reasoning: "private case reasoning", evidenceRefs: ["private/evidence"], source: "llm", points: 1 }],
      defects: [], notes: "private note", scenarios: [], pendingManual: [], unproven: [], byTag: {}, byStratum: {}, gates: [],
    }],
    overallScorePct: 100, overallCoveragePct: 100, scoreWithheld: false, byTag: {}, byStratum: {}, manualPending: 0,
    receipt, gates: { passed: true, blocking: [] },
  };
  report.areas[0].unproven = ["R1"];
  const runState = {
    schemaVersion: 1 as const,
    status: "failed" as "failed" | "complete",
    runId: "run-one",
    pid: 0,
    configFile: "evalkit.yaml",
    startedAt: report.startedAt,
    selectedAreas: ["core"],
    specHashes: { core: "test" },
    inputFingerprint: receipt.inputFingerprint,
  };
  writeJson(path.join(runDir, "run-state.json"), runState);
  fs.writeFileSync(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeArtifactIndex(runDir);
  assert.throws(
    () => createPublicExport({ runDir, output: path.join(runDir, "public") }),
    /must be outside the source run/,
  );
  assert.throws(
    () => createPublicExport({ runDir, output: path.join(root, "incomplete-public") }),
    /Only complete runs can be exported; run status is failed/,
  );
  runState.status = "complete";
  writeJson(path.join(runDir, "run-state.json"), runState);
  if (process.platform !== "win32") {
    const linkedRun = path.join(root, "run-link");
    fs.symlinkSync(runDir, linkedRun, "dir");
    assert.throws(
      () => createPublicExport({ runDir, output: path.join(linkedRun, "public") }),
      /must be outside the source run/,
    );
    assert.equal(fs.existsSync(path.join(runDir, "public")), false);
    assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);
  }
  const output = path.join(root, "public");
  createPublicExport({ runDir, output });
  const text = fs.readFileSync(path.join(output, "public-report.json"), "utf8");
  const publicReport = JSON.parse(text);
  assert.match(text, /plan=annual/);
  assert.doesNotMatch(text, /secret internal|private case|private\/evidence|\/home\/private/);
  assert.equal(publicReport.areas[0].items[0].verdict, "cannot_judge");
  assert.equal(publicReport.areas[0].cases[0].verdict, "cannot_judge");
  assert.equal(publicReport.areas[0].cases[0].points, null);
  assert.equal(privacyLint(output).status, "passed");
});

test("privacy lint reports locations without echoing sensitive values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-privacy-"));
  fs.writeFileSync(path.join(root, "unsafe.txt"), "contact someone@example.com\n\"password\": \"correct-horse-battery\"\n");
  const lint = privacyLint(root);
  assert.equal(lint.status, "failed");
  assert.deepEqual(lint.findings.map((item) => item.rule).sort(), ["email-address", "secret-assignment"]);
  assert.equal(JSON.stringify(lint).includes("correct-horse-battery"), false);
});

test("privacy lint streams large text, skips large binary files, and bounds individual lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-privacy-large-"));
  try {
    const textFile = path.join(root, "large.log");
    const descriptor = fs.openSync(textFile, "w");
    const chunk = Buffer.from("ordinary log entry\n".repeat(4_000));
    try {
      for (let index = 0; index < 300; index++) fs.writeSync(descriptor, chunk);
    } finally {
      fs.closeSync(descriptor);
    }
    const binaryFile = path.join(root, "large.bin");
    fs.writeFileSync(binaryFile, Buffer.from([0]));
    fs.truncateSync(binaryFile, 64 * 1024 * 1024);

    const lint = privacyLint(root);
    assert.equal(lint.status, "passed");
    assert.equal(lint.scannedFiles, 1);
    assert.equal(lint.skippedBinaryFiles, 1);

    fs.writeFileSync(path.join(root, "one-line.txt"), "x".repeat(1024 * 1024 + 1));
    assert.throws(() => privacyLint(root), /refuses a text line larger than 1048576 bytes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
