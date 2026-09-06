import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { readSetupRecord } from "../src/lifecycle.js";
import { writeArtifactIndex } from "../src/integrity.js";

test("campaign repetitions each reset target state and retain successful preparation records", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-preparation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "prepare.mjs"),
    `import fs from 'node:fs';fs.writeFileSync('state.json','[]');if(!process.env.AEK_RUN_DIR||process.env.AEK_PROJECT_ROOT!==process.cwd())throw new Error('Missing preparation context');`,
  );
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    `import fs from 'node:fs';import assert from 'node:assert/strict';assert.deepEqual(JSON.parse(fs.readFileSync('state.json','utf8')),[]);fs.writeFileSync('state.json','["created"]');`,
  );
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Preparation" },
      target: { kind: "command", setup: { command: "node prepare.mjs" } },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    YAML.stringify({
      id: "state",
      title: "State",
      description: "Fresh state",
      weight: 100,
      rubric: [
        {
          id: "FRESH",
          criterion: "Fresh state",
          weight: 1,
          passCriteria: "Empty before mutation",
          grader: {
            type: "command",
            command: "node check.mjs",
            methodFiles: ["check.mjs"],
            output: "exit-code",
          },
        },
      ],
    }),
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
      "campaign",
      "--config",
      configFile,
      "--repetitions",
      "3",
    ],
    { cwd: process.cwd(), timeout: 30000, stdio: "pipe" },
  );
  const runs = path.join(root, ".agent-eval", "runs");
  assert.equal(fs.readdirSync(runs).length, 3);
  for (const run of fs.readdirSync(runs)) {
    const result = JSON.parse(
      fs.readFileSync(path.join(runs, run, "lifecycle/setup.json"), "utf8"),
    );
    assert.equal(result.status, "complete");
    assert.equal(result.command, "node prepare.mjs");
    const report = JSON.parse(fs.readFileSync(path.join(runs, run, "report.json"), "utf8"));
    assert.equal(report.overallScorePct, 100);
  }
});

test("failed preparation aborts collection and resume retries it instead of skipping a sealed failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-preparation-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".agent-eval"));
  fs.writeFileSync(
    path.join(root, "prepare.mjs"),
    `import fs from 'node:fs';const flag='.agent-eval/attempted';if(!fs.existsSync(flag)){fs.writeFileSync(flag,'yes');process.exit(7);}console.log('prepared');`,
  );
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Retry preparation" },
      target: { kind: "command", setup: { command: "node prepare.mjs" } },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    YAML.stringify({
      id: "state",
      title: "State",
      description: "Fresh state",
      weight: 100,
      rubric: [
        {
          id: "CHECK",
          criterion: "Check",
          weight: 1,
          passCriteria: "Works",
          grader: { type: "command", command: "exit 0", methodFiles: [], output: "exit-code" },
        },
      ],
    }),
  );
  const config = loadConfig(configFile),
    specs = loadSpecs(config.paths.specs);
  await assert.rejects(
    () => runEvaluation({ config, configFile, specs, fixtures: {} }),
    /setup command failed/,
  );
  const runDir = path.join(config.paths.runs, fs.readdirSync(config.paths.runs)[0]!);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, "lifecycle/setup.json"), "utf8")).status,
    "failed",
  );
  assert.equal(fs.existsSync(path.join(runDir, "areas/state/graders/CHECK.stdout.txt")), false);
  const recordFile = path.join(runDir, "lifecycle/setup.json");
  const failedRecord = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  for (const invalid of [
    { ...failedRecord, status: undefined },
    { ...failedRecord, status: "unknown" },
    { ...failedRecord, status: "complete" },
    { ...failedRecord, command: undefined },
  ]) {
    fs.writeFileSync(recordFile, JSON.stringify(invalid));
    writeArtifactIndex(runDir);
    await assert.rejects(
      runEvaluation({ config, configFile, specs, fixtures: {}, resumeDir: runDir }),
      /Invalid setup record/,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(recordFile, "utf8")),
      JSON.parse(JSON.stringify(invalid)),
      "invalid preparation must not be overwritten by a retry",
    );
  }
  fs.writeFileSync(
    recordFile,
    JSON.stringify({
      command: failedRecord.command,
      cwd: failedRecord.cwd,
      startedAt: failedRecord.startedAt,
      status: "running",
    }),
  );
  assert.equal(readSetupRecord(recordFile).status, "running");
  fs.writeFileSync(recordFile, JSON.stringify(failedRecord));
  writeArtifactIndex(runDir);
  const resumed = await runEvaluation({
    config,
    configFile,
    specs,
    fixtures: {},
    resumeDir: runDir,
  });
  assert.equal(resumed.report!.overallScorePct, 100);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, "lifecycle/setup.json"), "utf8")).status,
    "complete",
  );
});
