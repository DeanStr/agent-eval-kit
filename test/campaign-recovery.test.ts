import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import YAML from "yaml";
import { sha256, stableJson } from "../src/io.js";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { buildRunReceipt } from "../src/receipts.js";
import { verifyFailedRunArtifacts } from "../src/run/failed-artifacts.js";
import { assertArtifactIntegrity } from "../src/integrity.js";

const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
const argsFor = (args: string[]) => ["--import", import.meta.resolve("tsx"), cli, ...args];
const invoke = (root: string, args: string[]) =>
  spawnSync(process.execPath, argsFor(args), { cwd: root, encoding: "utf8", timeout: 20_000 });
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

function fixture(root: string, pause: boolean): void {
  fs.mkdirSync(path.join(root, "runs"));
  fs.writeFileSync(path.join(root, "target.txt"), "unchanged target");
  fs.writeFileSync(
    path.join(root, "check.cjs"),
    `const fs = require('node:fs');
const counter = 'runs/count';
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(n));
if (${pause} && n === 2) { fs.writeFileSync('runs/paused', String(process.pid)); setInterval(() => {}, 1000); }
`,
  );
  fs.writeFileSync(
    path.join(root, "evalkit.yaml"),
    YAML.stringify({
      version: 1,
      project: { name: "Recovery", root: "." },
      target: { kind: "command" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml", runs: "runs" },
      suite: "review",
      suites: { review: { instructions: "Review the command's observed result." } },
    }),
  );
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    YAML.stringify({
      id: "core",
      title: "Core",
      description: "Recovery",
      weight: 100,
      scenarios: [],
      rubric: [
        {
          id: "CHECK",
          criterion: "Checker completes",
          passCriteria: "Success",
          weight: 1,
          grader: {
            type: "command",
            command: `"${process.execPath}" check.cjs`,
            output: "exit-code",
            methodFiles: ["check.cjs"],
          },
        },
      ],
    }),
  );
}

test("campaign recovery preserves completed and interrupted attempts, restores options, and rejects changed inputs", {
  timeout: 60_000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, true);
  const directory = path.join(root, "campaign");
  const child = spawn(
    process.execPath,
    argsFor([
      "campaign",
      "--repetitions",
      "3",
      "--split",
      "all",
      "--suite",
      "review",
      "--agent-model",
      "calibration-model",
      "--fail-under-score",
      "100",
      "--output",
      directory,
    ]),
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  try {
    const deadline = Date.now() + 15_000;
    while (
      !fs.existsSync(path.join(root, "runs/paused")) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await delay(20);
    assert.ok(fs.existsSync(path.join(root, "runs/paused")), output);
    const locked = invoke(root, ["campaign", "--resume", directory]);
    assert.equal(locked.status, 1, locked.stderr);
    assert.match(locked.stderr, /locked by active process/);
    child.kill("SIGTERM");
    assert.equal(await exited, 143, output);
  } finally {
    child.kill("SIGKILL");
  }
  const original = read(path.join(directory, "campaign.json"));
  assert.deepEqual(
    original.runs.map((run: { status: string }) => run.status),
    ["complete", "failed"],
  );
  assert.ok(original.runs[1].runDir);
  const reportFile = path.join(original.runs[0].runDir, "report.json");
  const reportBytes = fs.readFileSync(reportFile);
  const stateFile = path.join(directory, "campaign-state.json");
  const stateBytes = fs.readFileSync(stateFile);
  assert.equal(fs.existsSync(path.join(directory, ".run.lock")), false);

  const overridden = invoke(root, ["campaign", "--resume", directory, "--repetitions", "4"]);
  assert.equal(overridden.status, 1);
  assert.match(overridden.stderr, /restores the original options/);
  fs.writeFileSync(path.join(root, "target.txt"), "changed");
  const changed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Campaign inputs changed/);
  assert.deepEqual(fs.readFileSync(stateFile), stateBytes);
  fs.writeFileSync(path.join(root, "target.txt"), "unchanged target");
  const specFile = path.join(root, "spec.yaml");
  const specBytes = fs.readFileSync(specFile);
  const spec = YAML.parse(specBytes.toString());
  spec.rubric[0].passCriteria = "Different grading requirement";
  fs.writeFileSync(specFile, YAML.stringify(spec));
  const changedMethod = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(changedMethod.status, 1);
  assert.match(changedMethod.stderr, /Campaign inputs changed/);
  fs.writeFileSync(specFile, specBytes);

  fs.appendFileSync(reportFile, " ");
  const corrupted = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(corrupted.status, 1);
  assert.match(corrupted.stderr, /integrity|hash|checksum/i);
  fs.writeFileSync(reportFile, reportBytes);
  fs.appendFileSync(stateFile, " "); // Whitespace is harmless; content alterations are not.
  const envelope = read(stateFile);
  envelope.state.plannedRepetitions = 4;
  fs.writeFileSync(stateFile, JSON.stringify(envelope));
  const invalidState = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(invalidState.status, 1);
  assert.match(invalidState.stderr, /checksum mismatch/);
  fs.writeFileSync(stateFile, stateBytes);

  const resumed = invoke(os.tmpdir(), ["campaign", "--resume", directory]);
  assert.equal(resumed.status, 1, resumed.stderr); // The failed attempt remains a failure.
  const completed = read(path.join(directory, "campaign.json"));
  assert.equal(completed.status, "complete");
  assert.equal(completed.coverage.pendingRuns, 0);
  assert.equal(completed.coverage.completedRuns, 2);
  assert.deepEqual(completed.runs.slice(0, 2), original.runs);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "3");
  assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
  const state = read(stateFile).state;
  assert.equal(state.selectedSplit, "all");
  assert.equal(state.thresholds.minimumScore, 100);
  assert.equal(state.configOverrides.suite, "review");
  assert.equal(state.configOverrides.agentModel, "calibration-model");
  const again = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(again.status, 1);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "3");
});

test("campaign recovers the completion/publication crash window without repeating a successful run", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-commit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const configFile = path.join(root, "evalkit.yaml");
  const rawConfig = YAML.parse(fs.readFileSync(configFile, "utf8"));
  rawConfig.target.setup = `"${process.execPath}" setup.cjs`;
  fs.writeFileSync(configFile, YAML.stringify(rawConfig));
  fs.writeFileSync(
    path.join(root, "setup.cjs"),
    "require('node:fs').writeFileSync('generated.txt', 'built target');",
  );
  const directory = path.join(root, "campaign");
  const config = loadConfig(configFile);
  const beforeSetup = buildRunReceipt({
    config,
    specs: loadSpecs(config.paths.specs),
    fixtures: {},
    split: "development",
    ignoredTargetPaths: [directory],
  });
  const result = invoke(root, ["campaign", "--repetitions", "2", "--output", directory]);
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(directory, "campaign-state.json");
  const { state } = read(file);
  const first = state.runs[0];
  state.runs = [];
  state.artifactRoots = {};
  state.inputFingerprint = beforeSetup.inputFingerprint;
  state.active = { ordinal: first.ordinal, runDir: first.runDir };
  fs.writeFileSync(file, JSON.stringify({ state, sha256: sha256(stableJson(state)) }));
  fs.writeFileSync(path.join(directory, "campaign.json"), "interrupted report publication");
  fs.writeFileSync(path.join(root, "generated.txt"), "unrelated edit after completion");
  const changed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Campaign inputs changed/);
  fs.writeFileSync(path.join(root, "generated.txt"), "built target");
  const resumed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(read(path.join(directory, "campaign.json")).coverage.completedRuns, 2);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "3");
});

test("campaign stops when a failed checker changes evaluator source bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-method-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  fs.appendFileSync(
    path.join(root, "check.cjs"),
    "fs.appendFileSync('spec.yaml', '\\n# changed by checker\\n');\n",
  );
  const directory = path.join(root, "campaign");
  const result = invoke(root, ["campaign", "--repetitions", "2", "--output", directory]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "1");
  const state = read(path.join(directory, "campaign-state.json")).state;
  assert.equal(state.runs.length, 1);
  assert.match(state.recoveryError, /inputs changed/i);
  assert.match(state.runs[0].error, /changed evaluator specs/);
  const resumed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /Campaign checkpoint failed/);
});

test("campaign rejects an unsealed completed attempt before changing its journal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-unsealed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const directory = path.join(root, "campaign");
  const result = invoke(root, ["campaign", "--repetitions", "2", "--output", directory]);
  assert.equal(result.status, 0, result.stderr);
  const stateFile = path.join(directory, "campaign-state.json");
  const { state } = read(stateFile);
  const last = state.runs.pop();
  delete state.artifactRoots[last.ordinal];
  state.active = { ordinal: last.ordinal, runDir: last.runDir };
  const stateBytes = JSON.stringify({ state, sha256: sha256(stableJson(state)) });
  fs.writeFileSync(stateFile, stateBytes);
  const indexFile = path.join(last.runDir, "artifact-index.json");
  const indexBytes = fs.readFileSync(indexFile);
  fs.unlinkSync(indexFile);
  const unsealed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(unsealed.status, 1, unsealed.stdout);
  assert.match(unsealed.stderr, /Missing artifact-index\.json/);
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBytes);
  fs.writeFileSync(indexFile, indexBytes);
  const restored = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "2");
});

test("campaign requires restoration of missing active state or run directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-missing-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const directory = path.join(root, "campaign");
  const result = invoke(root, ["campaign", "--repetitions", "2", "--output", directory]);
  assert.equal(result.status, 0, result.stderr);
  const stateFile = path.join(directory, "campaign-state.json");
  const reportFile = path.join(directory, "campaign.json");
  const reportBytes = fs.readFileSync(reportFile);
  const { state } = read(stateFile);
  const last = state.runs.pop();
  delete state.artifactRoots[last.ordinal];
  state.active = { ordinal: last.ordinal, runDir: last.runDir };
  const stateBytes = JSON.stringify({ state, sha256: sha256(stableJson(state)) });
  fs.writeFileSync(stateFile, stateBytes);
  const runStateFile = path.join(last.runDir, "run-state.json");
  const runStateBytes = fs.readFileSync(runStateFile);
  fs.unlinkSync(runStateFile);
  const missingState = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(missingState.status, 1);
  assert.match(
    missingState.stderr,
    /execution artifacts exist.*Restore the original run-state\.json/,
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBytes);
  assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
  fs.writeFileSync(runStateFile, runStateBytes);

  const retainedDir = `${last.runDir}-retained`;
  fs.renameSync(last.runDir, retainedDir);
  const missingDir = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(missingDir.status, 1);
  assert.match(
    missingDir.stderr,
    /Campaign run directory is missing:.*Restore the original directory/,
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBytes);
  assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
  fs.renameSync(retainedDir, last.runDir);

  const restored = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(read(stateFile).state.runs[1].status, "complete");
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "2");
});

test("campaign retains interruptions before directory creation and run-state initialization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-initializing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const directory = path.join(root, "campaign");
  const result = invoke(root, ["campaign", "--repetitions", "2", "--output", directory]);
  assert.equal(result.status, 0, result.stderr);
  const stateFile = path.join(directory, "campaign-state.json");
  const { state } = read(stateFile);
  const last = state.runs.pop();
  delete state.artifactRoots[last.ordinal];
  for (const stage of ["before-directory", "empty-directory", "input-snapshot"]) {
    state.active = { ordinal: last.ordinal };
    if (stage !== "before-directory") {
      const runDir = path.join(root, "runs", stage);
      fs.mkdirSync(runDir);
      state.active.runDir = runDir;
      if (stage === "input-snapshot") {
        fs.mkdirSync(path.join(runDir, "inputs"));
        fs.writeFileSync(path.join(runDir, "inputs", "partial.yaml"), "partial snapshot");
        fs.writeFileSync(
          path.join(runDir, ".run.lock"),
          JSON.stringify({ schemaVersion: 1, pid: result.pid, token: "interrupted" }),
        );
        fs.writeFileSync(
          path.join(runDir, "run-state.json.tmp-123-12345678-1234-4123-8123-123456789abc"),
          "partial state",
        );
      }
    }
    fs.writeFileSync(stateFile, JSON.stringify({ state, sha256: sha256(stableJson(state)) }));
    const resumed = invoke(root, ["campaign", "--resume", directory]);
    assert.equal(resumed.status, 1, `${stage}: ${resumed.stderr}`);
    assert.equal(resumed.stderr, "", stage);
    const recovered = read(stateFile).state;
    assert.equal(recovered.runs[1].status, "failed", stage);
    assert.match(recovered.runs[1].error, /Campaign interrupted before this attempt completed/);
    assert.equal(recovered.active, undefined);
    assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "2");
  }
});

test("campaign checkpoints refreshed receipts and server log tails after an execution failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-mutable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const configFile = path.join(root, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.paths.specs = "specs";
  config.target.start = `"${process.execPath}" server.cjs`;
  config.target.ready = {
    command: `"${process.execPath}" -e "process.exit(require('node:fs').existsSync('runs/ready') ? 0 : 1)"`,
  };
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(
    path.join(root, "server.cjs"),
    `const fs = require('node:fs');
console.log('server started');
console.error('server diagnostic');
fs.writeFileSync('runs/ready', 'ready');
process.on('SIGTERM', () => { console.log('server stopped'); console.error('shutdown diagnostic'); fs.rmSync('runs/ready', {force:true}); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  fs.writeFileSync(
    path.join(root, "mutate.cjs"),
    `const fs = require('node:fs');
const n = fs.existsSync('runs/mutations') ? Number(fs.readFileSync('runs/mutations', 'utf8')) + 1 : 1;
fs.writeFileSync('runs/mutations', String(n));
fs.writeFileSync('target.txt', 'built target');
if (n === 1) fs.copyFileSync(require('node:path').join(process.env.AEK_RUN_DIR, 'artifact-index.json'), 'runs/original-index.json');
process.exit(n === 1 ? 5 : 0);
`,
  );
  fs.mkdirSync(path.join(root, "specs"));
  const spec = YAML.parse(fs.readFileSync(path.join(root, "spec.yaml"), "utf8"));
  spec.weight = 50;
  spec.id = "a";
  fs.writeFileSync(path.join(root, "specs/a.yaml"), YAML.stringify(spec));
  spec.id = "b";
  spec.rubric[0].id = "MUTATE";
  spec.rubric[0].grader.command = `"${process.execPath}" mutate.cjs`;
  spec.rubric[0].grader.methodFiles = ["mutate.cjs"];
  fs.writeFileSync(path.join(root, "specs/b.yaml"), YAML.stringify(spec));
  const directory = path.join(root, "campaign");
  const result = invoke(root, ["campaign", "--repetitions", "3", "--output", directory]);
  assert.equal(result.status, 1, result.stderr);
  const state = read(path.join(directory, "campaign-state.json")).state;
  assert.equal(state.recoveryError, undefined, result.stderr);
  assert.deepEqual(
    state.runs.map((run: { status: string }) => run.status),
    ["failed", "complete", "complete"],
  );
  assert.match(state.runs[0].error, /unexpected exit code 5/);
  const failedDir = state.runs[0].runDir;
  assert.match(
    fs.readFileSync(path.join(failedDir, "lifecycle/start.stdout.log"), "utf8"),
    /server stopped/,
  );
  assert.match(
    fs.readFileSync(path.join(failedDir, "lifecycle/start.stderr.log"), "utf8"),
    /shutdown diagnostic/,
  );
  const checkpoint = read(path.join(directory, "failed-artifacts/1.json"));
  assert.doesNotThrow(() =>
    assertArtifactIntegrity(failedDir, { index: checkpoint, require: true }),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(failedDir, "artifact-index.json")),
    fs.readFileSync(path.join(root, "runs/original-index.json")),
  );
  const resumed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.equal(fs.readFileSync(path.join(root, "runs/mutations"), "utf8"), "3");

  const current = read(path.join(failedDir, "receipt.json"));
  const logFile = path.join(failedDir, "lifecycle/start.stdout.log");
  const logBytes = fs.readFileSync(logFile);
  fs.appendFileSync(logFile, "late shutdown output\n");
  assert.doesNotThrow(() => verifyFailedRunArtifacts(failedDir, current));
  fs.writeFileSync(logFile, Buffer.concat([Buffer.from("changed prefix\n"), logBytes]));
  assert.throws(() => verifyFailedRunArtifacts(failedDir, current), /changed rather than appended/);
  fs.writeFileSync(logFile, logBytes);
  const evidenceFile = path.join(failedDir, "areas/a/graders/CHECK.stdout.txt");
  const evidenceBytes = fs.readFileSync(evidenceFile);
  fs.appendFileSync(evidenceFile, "rewritten completed checker output");
  assert.throws(() => verifyFailedRunArtifacts(failedDir, current), /Artifact size changed/);
  fs.writeFileSync(evidenceFile, evidenceBytes);
  const receiptFile = path.join(failedDir, "receipt.json");
  const receiptBytes = fs.readFileSync(receiptFile);
  fs.writeFileSync(
    receiptFile,
    JSON.stringify({ ...current, target: { ...current.target, treeSha256: "0".repeat(64) } }),
  );
  assert.throws(
    () => verifyFailedRunArtifacts(failedDir, current),
    /Refreshed run receipt does not match/,
  );
  fs.writeFileSync(receiptFile, receiptBytes);
});

test("campaign recovers interrupted derived reports without sealing them for run reuse", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-campaign-report-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root, false);
  const configFile = path.join(root, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.paths.specs = "specs";
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.mkdirSync(path.join(root, "specs"));
  const spec = YAML.parse(fs.readFileSync(path.join(root, "spec.yaml"), "utf8"));
  for (const id of ["a", "b"]) {
    spec.rubric[0].id = `CHECK_${id}`;
    fs.writeFileSync(
      path.join(root, `specs/${id}.yaml`),
      YAML.stringify({ ...spec, id, weight: 50 }),
    );
  }
  const hook = path.join(root, "interrupt.cjs");
  fs.writeFileSync(
    hook,
    `const fs = require('node:fs');
const rename = fs.renameSync;
let reports = 0;
fs.renameSync = function(source, destination) {
  const result = rename.apply(this, arguments);
  if (String(destination).endsWith('/report.json') && ++reports === 2) process.kill(process.pid, 'SIGKILL');
  return result;
};
`,
  );
  const directory = path.join(root, "campaign");
  const result = spawnSync(
    process.execPath,
    ["--require", hook, ...argsFor(["campaign", "--repetitions", "2", "--output", directory])],
    { cwd: root, encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.signal, "SIGKILL", result.stderr);
  const stateFile = path.join(directory, "campaign-state.json");
  const runDir = read(stateFile).state.active.runDir;
  const originalIndex = fs.readFileSync(path.join(runDir, "artifact-index.json"));
  const partialReport = fs.readFileSync(path.join(runDir, "report.json"));
  assert.throws(() => assertArtifactIntegrity(runDir, { require: true }), /report.json/);
  const resumed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(resumed.status, 1, resumed.stderr);
  const state = read(stateFile).state;
  assert.equal(state.recoveryError, undefined, resumed.stderr);
  assert.deepEqual(
    state.runs.map((run: { status: string }) => run.status),
    ["failed", "complete"],
  );
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "4");
  assert.deepEqual(fs.readFileSync(path.join(runDir, "artifact-index.json")), originalIndex);
  assert.deepEqual(fs.readFileSync(path.join(runDir, "report.json")), partialReport);
  assert.throws(() => assertArtifactIntegrity(runDir, { require: true }), /report.json/);
  const checkpointFile = path.join(directory, "failed-artifacts/1.json");
  const checkpointBytes = fs.readFileSync(checkpointFile);
  assert.doesNotThrow(() =>
    assertArtifactIntegrity(runDir, {
      index: JSON.parse(checkpointBytes.toString()),
      require: true,
    }),
  );
  const completedState = fs.readFileSync(stateFile);
  fs.writeFileSync(checkpointFile, "null");
  const invalid = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid artifact-index.json schema/);
  assert.deepEqual(fs.readFileSync(stateFile), completedState);
  fs.writeFileSync(checkpointFile, checkpointBytes);
  fs.appendFileSync(path.join(runDir, "report.json"), "changed after checkpoint");
  const changed = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Artifact size changed: report.json/);
  assert.deepEqual(fs.readFileSync(stateFile), completedState);
  fs.writeFileSync(path.join(runDir, "report.json"), partialReport);
  const again = invoke(root, ["campaign", "--resume", directory]);
  assert.equal(again.status, 1, again.stderr);
  assert.equal(fs.readFileSync(path.join(root, "runs/count"), "utf8"), "4");
});
