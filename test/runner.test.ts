import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyArtifactIndex, writeArtifactIndex } from "../src/integrity.js";
import { buildRunReceipt } from "../src/receipts.js";
import { writeReportArtifacts } from "../src/report.js";
import { runEvaluation } from "../src/runner.js";
import { buildReport } from "../src/scoring.js";
import type { EvalConfig, EvalSpec } from "../src/types.js";

test("offline mock runs the full persistence, command-grader, and report pipeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-runner-"));
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  const fixturesFile = path.join(root, "fixtures.yaml");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(path.join(root, ".env"), "PRIVATE_EVALUATOR_TOKEN=do-not-expose\n");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(fixturesFile, "data: { marker: original }\n");
  const campaignDirectory = path.join(root, "campaign-output");
  fs.mkdirSync(campaignDirectory);
  fs.writeFileSync(path.join(campaignDirectory, "campaign.json"), "prior evaluator verdict\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Integration", root },
    target: {
      kind: "repository",
      allowedOrigins: [],
      start: { command: `${JSON.stringify(process.execPath)} -e "setInterval(() => console.log('tick'), 5)"` },
      ready: { command: "exit 0", timeoutSeconds: 5, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, fixtures: fixturesFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: { publicValue: "kept", nested: { password: "never-write-this" } },
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Core checks",
    sourceFile: specFile,
    scenarios: [{ id: "S1", name: "Inspect", kind: "workspace", instructions: "Inspect", successSignals: [], dependsOn: [], requiresAuth: false }],
    rubric: [{
      id: "R1",
      criterion: "Command passes",
      weight: 1,
      tags: ["test"],
      scenarios: [],
      grader: { type: "command", output: "exit-code", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
      passCriteria: "exit zero",
    }],
  };
  await assert.rejects(
    runEvaluation({
      config,
      configFile,
      specs: [spec],
      fixtures: { data: { marker: "original" } },
      scenarioIds: ["S-typo"],
      dryRun: true,
    }),
    /Unknown scenario selector.*S-typo/,
  );
  await assert.rejects(
    runEvaluation({
      config,
      configFile,
      specs: [spec],
      fixtures: { data: { marker: "original" } },
      resumeDir: path.join(root, "not-a-run"),
    }),
    /run-state\.json does not exist/,
  );
  const result = await runEvaluation({
    config,
    configFile,
    specs: [spec],
    fixtures: { data: { marker: "original" } },
    ignoredTargetPaths: [campaignDirectory],
  });
  assert.equal(result.report?.overallScorePct, 100);
  assert.equal(result.report?.overallCoveragePct, 100);
  assert.equal(result.report?.scoreWithheld, false);
  assert.equal(result.report?.areas[0].scenarios[0].outcome, "completed");
  assert.ok(fs.existsSync(path.join(result.runDir, "report.html")));
  assert.ok(fs.existsSync(path.join(result.runDir, "receipt.json")));
  assert.ok(fs.existsSync(path.join(result.runDir, "artifact-index.json")));
  assert.equal(result.report?.schemaVersion, 1);
  assert.equal(result.report?.receipt?.evaluationFingerprint.length, 64);
  assert.ok(fs.existsSync(path.join(result.runDir, "inputs", "specs", "spec.yaml")));
  const workspaceContext = JSON.parse(fs.readFileSync(path.join(result.runDir, "S1", "workspace-context.json"), "utf8"));
  assert.ok(workspaceContext.evaluatorOnlyPaths.includes(config.paths.runs));
  assert.ok(workspaceContext.evaluatorOnlyPaths.includes(config.paths.auth));
  assert.ok(workspaceContext.evaluatorOnlyPaths.includes(result.runDir));
  assert.ok(workspaceContext.evaluatorOnlyPaths.includes(path.join(root, ".env")));
  assert.ok(workspaceContext.evaluatorOnlyPaths.includes(campaignDirectory));
  const configSnapshot = fs.readFileSync(path.join(result.runDir, "inputs", "config.resolved.yaml"), "utf8");
  assert.match(configSnapshot, /publicValue: kept/);
  assert.doesNotMatch(configSnapshot, /never-write-this/);
  assert.match(configSnapshot, /password: \"?\[REDACTED\]\"?/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, "run-state.json"), "utf8")).status, "complete");
  assert.equal(verifyArtifactIndex(result.runDir, { require: true }).ok, true);

  const interruptedBrowserState = path.join(result.runDir, ".state", "core", "chain.json");
  fs.mkdirSync(path.dirname(interruptedBrowserState), { recursive: true });
  fs.writeFileSync(interruptedBrowserState, JSON.stringify({ cookies: [], origins: [] }));
  writeArtifactIndex(result.runDir);
  const evidenceFile = path.join(result.runDir, "S1", "evidence.json");
  const tamperedEvidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  tamperedEvidence.summary = "FORGED UNSEALED EVIDENCE";
  fs.writeFileSync(evidenceFile, JSON.stringify(tamperedEvidence));
  const interruptedState = JSON.parse(fs.readFileSync(path.join(result.runDir, "run-state.json"), "utf8"));
  interruptedState.status = "failed";
  fs.writeFileSync(path.join(result.runDir, "run-state.json"), JSON.stringify(interruptedState));
  fs.writeFileSync(interruptedBrowserState, JSON.stringify({ cookies: [{ interrupted: true }], origins: [] }));
  const unindexedBrowserState = path.join(result.runDir, ".state", "core", "unfinished.json");
  fs.writeFileSync(unindexedBrowserState, JSON.stringify({ cookies: [], origins: [] }));
  const resumed = await runEvaluation({
    config,
    configFile,
    specs: [spec],
    fixtures: { data: { marker: "original" } },
    ignoredTargetPaths: [campaignDirectory],
    resumeDir: result.runDir,
  });
  assert.doesNotMatch(resumed.report?.areas[0].scenarios[0].summary ?? "", /FORGED/);
  assert.equal(fs.existsSync(interruptedBrowserState), false);
  assert.equal(fs.existsSync(unindexedBrowserState), false);

  fs.writeFileSync(fixturesFile, "data: { marker: changed }\n");
  await assert.rejects(
    runEvaluation({
      config,
      configFile,
      specs: [spec],
      fixtures: { data: { marker: "changed" } },
      ignoredTargetPaths: [campaignDirectory],
      resumeDir: result.runDir,
    }),
    /Configuration, fixtures, provider method, selected inputs, or target revision changed/,
  );
});

test("resume accepts a sealed report containing an unavailable completed-area subset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-partial-area-resume-"));
  const configFile = path.join(root, "evalkit.yaml");
  const specsDir = path.join(root, "specs");
  fs.mkdirSync(specsDir);
  fs.writeFileSync(configFile, "version: 1\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Partial resume", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specsDir, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const specs: EvalSpec[] = ["first", "second"].map((id, index) => {
    const sourceFile = path.join(specsDir, `${id}.yaml`);
    fs.writeFileSync(sourceFile, `id: ${id}\n`);
    return {
      id,
      title: id,
      weight: 50,
      optional: false,
      description: id,
      sourceFile,
      scenarios: [],
      rubric: [{
        id: `R${index + 1}`,
        criterion: "Command passes",
        weight: 1,
        tags: [],
        scenarios: [],
        grader: index === 0
          ? { type: "llm" }
          : { type: "command", output: "exit-code", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
        passCriteria: "exit zero",
      }],
    };
  });

  try {
    const initial = await runEvaluation({ config, configFile, specs, fixtures: {} });
    assert.ok(initial.report);
    assert.equal(initial.report.areas[0].scorePct, null);
    const stateFile = path.join(initial.runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const partial = buildReport({
      runId: initial.report.runId,
      startedAt: initial.report.startedAt,
      config,
      areas: [initial.report.areas[0]],
      receipt: initial.report.receipt,
    });
    writeReportArtifacts(initial.runDir, partial, specs);
    state.status = "failed";
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const resumed = await runEvaluation({ config, configFile, specs, fixtures: {}, resumeDir: initial.runDir });
    assert.deepEqual(resumed.report?.areas.map((area) => area.id), ["first", "second"]);
    assert.match(fs.readFileSync(path.join(initial.runDir, "run.log"), "utf8"), /Area first:[\s\S]*reusing completed area/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume recovers a canonical receipt refresh and reruns evidence from the prior target revision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-receipt-refresh-recovery-"));
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  const applicationFile = path.join(root, "application.txt");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(applicationFile, "revision one\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Receipt recovery", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Receipt recovery",
    sourceFile: specFile,
    scenarios: [{
      id: "S1", name: "Inspect", kind: "workspace", instructions: "Inspect",
      successSignals: [], dependsOn: [], requiresAuth: false,
    }],
    rubric: [{
      id: "MANUAL", criterion: "Review", weight: 1, tags: [], scenarios: ["S1"],
      grader: { type: "manual" }, passCriteria: "Reviewed.", manualInstructions: "Review.",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    fs.writeFileSync(applicationFile, "revision two\n");
    const refreshed = buildRunReceipt({ config, specs: [spec], fixtures: {}, split: "development" });
    const stateFile = path.join(initial.runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.status = "failed";
    state.inputFingerprint = refreshed.inputFingerprint;
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    fs.writeFileSync(path.join(initial.runDir, "receipt.json"), `${JSON.stringify(refreshed)}\n`);

    const resumed = await runEvaluation({
      config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir,
    });
    assert.deepEqual(resumed.report?.receipt.target, refreshed.target);
    const log = fs.readFileSync(path.join(initial.runDir, "run.log"), "utf8");
    assert.equal((log.match(/> S1: Inspect/g) ?? []).length, 2);
    assert.match(log, /rerunning it on the recovered revision/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume fails fast when managed startup changes a target with reusable evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-resume-startup-change-"));
  const readyMarker = path.join(os.tmpdir(), `aek-resume-ready-${process.pid}-${Date.now()}`);
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  const applicationFile = path.join(root, "application.txt");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(applicationFile, "0");
  const node = JSON.stringify(process.execPath);
  const startScript = `const fs=require('node:fs');const app=${JSON.stringify(applicationFile)};const ready=${JSON.stringify(readyMarker)};fs.writeFileSync(app,String(Number(fs.readFileSync(app,'utf8'))+1));fs.writeFileSync(ready,'ready');setInterval(()=>{},1000)`;
  const readyScript = `process.exit(require('node:fs').existsSync(${JSON.stringify(readyMarker)})?0:1)`;
  const config: EvalConfig = {
    version: 1,
    project: { name: "Startup change", root },
    target: {
      kind: "repository",
      allowedOrigins: [],
      start: { command: `${node} -e ${JSON.stringify(startScript)}` },
      ready: { command: `${node} -e ${JSON.stringify(readyScript)}`, timeoutSeconds: 3, intervalMs: 20 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Startup change",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "MANUAL", criterion: "Review", weight: 1, tags: [], scenarios: [],
      grader: { type: "manual" }, passCriteria: "Reviewed.", manualInstructions: "Review.",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    fs.rmSync(readyMarker, { force: true });
    await assert.rejects(
      runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir }),
      /Target startup changed the target revision while prior evidence was eligible for reuse/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(readyMarker, { force: true });
  }
});

test("a dependent scenario is blocked when its prerequisite was not selected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-dependency-"));
  const specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Dependencies", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "flow",
    title: "Flow",
    weight: 100,
    optional: false,
    description: "Dependency gating",
    sourceFile: specFile,
    scenarios: [
      { id: "S1", name: "Create", instructions: "Create", successSignals: [], dependsOn: [], requiresAuth: false },
      { id: "S2", name: "Use", instructions: "Use", successSignals: [], dependsOn: ["S1"], requiresAuth: false },
    ],
    rubric: [{
      id: "R1",
      criterion: "Verify manually",
      weight: 1,
      tags: ["flow"],
      scenarios: ["S2"],
      grader: { type: "manual" },
      passCriteria: "Works",
      manualInstructions: "Verify",
    }],
  };

  const result = await runEvaluation({
    config,
    configFile: path.join(root, "evalkit.yaml"),
    specs: [spec],
    fixtures: {},
    scenarioIds: ["S2"],
  });
  assert.match(result.report!.areas[0].scenarios[0].summary, /NOT RUN/);
  assert.match(result.report!.areas[0].scenarios[1].summary, /S1 \(blocked\)/);
  assert.equal(result.report!.areas[0].scenarios[1].durationMs, 0);
});

test("split-inapplicable areas are omitted and an entirely empty split fails before starting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-empty-split-"));
  const configFile = path.join(root, "evalkit.yaml");
  const activeFile = path.join(root, "active.yaml");
  const inactiveFile = path.join(root, "inactive.yaml");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(activeFile, "id: active\n");
  fs.writeFileSync(inactiveFile, "id: inactive\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Empty split", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const active: EvalSpec = {
    id: "active", title: "Active", weight: 50, optional: false, description: "Active in every split",
    sourceFile: activeFile, scenarios: [],
    rubric: [{
      id: "ACTIVE", criterion: "Command passes", weight: 1, tags: [], scenarios: [],
      grader: { type: "command", output: "exit-code", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
      passCriteria: "Command completes.",
    }],
  };
  const inactive: EvalSpec = {
    id: "inactive", title: "Inactive", weight: 50, optional: false, description: "Evaluation only",
    sourceFile: inactiveFile,
    scenarios: [{
      id: "EVAL", name: "Evaluation-only scenario", instructions: "Inspect", successSignals: [],
      dependsOn: [], requiresAuth: false, split: "evaluation",
    }],
    rubric: [{
      id: "EVAL-ONLY", criterion: "Evaluation works", weight: 1, tags: [], scenarios: ["EVAL"],
      grader: { type: "llm" }, passCriteria: "Works.",
    }],
  };

  try {
    const result = await runEvaluation({
      config, configFile, specs: [active, inactive], fixtures: {}, split: "development",
    });
    assert.deepEqual(result.report?.areas.map((area) => area.id), ["active"]);
    assert.deepEqual(result.report?.receipt.inputs.selection.areas, ["active"]);

    const emptyRuns = path.join(root, "empty-runs");
    await assert.rejects(
      runEvaluation({
        config: { ...config, paths: { ...config.paths, runs: emptyRuns } },
        configFile,
        specs: [inactive],
        fixtures: {},
        split: "development",
      }),
      /Split development selects no rubric items/,
    );
    assert.equal(fs.existsSync(emptyRuns), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setup-mutated target state is receipted and remains resumable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-setup-fingerprint-"));
  const specFile = path.join(root, "spec.yaml");
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(configFile, "version: 1\n");
  const generatedFile = path.join(root, "generated.txt");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Setup fingerprint", root },
    target: {
      kind: "repository",
      allowedOrigins: [],
      setup: { command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('generated.txt','ready')"` },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Setup fingerprint",
    sourceFile: specFile,
    scenarios: [],
    rubric: [{
      id: "R1",
      criterion: "Review manually",
      weight: 1,
      tags: [],
      scenarios: [],
      grader: { type: "manual" },
      passCriteria: "Reviewed",
      manualInstructions: "Review",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    assert.equal(fs.readFileSync(generatedFile, "utf8"), "ready");
    const resumed = await runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir });
    assert.equal(resumed.runDir, initial.runDir);
    assert.equal(resumed.report?.receipt?.inputFingerprint, initial.report?.receipt?.inputFingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed startup mutations are receipted and remain resumable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-startup-fingerprint-"));
  const specFile = path.join(root, "spec.yaml");
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(configFile, "version: 1\n");
  const node = JSON.stringify(process.execPath);
  const startScript = "require('node:fs').writeFileSync('startup-output.txt','ready');setInterval(()=>{},1000)";
  const config: EvalConfig = {
    version: 1,
    project: { name: "Startup fingerprint", root },
    target: {
      kind: "repository",
      allowedOrigins: [],
      start: { command: `${node} -e ${JSON.stringify(startScript)}` },
      ready: { command: "test -f startup-output.txt", timeoutSeconds: 2, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Startup fingerprint",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "R1", criterion: "Review manually", weight: 1, tags: [], scenarios: [],
      grader: { type: "manual" }, passCriteria: "Reviewed", manualInstructions: "Review",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    const postStartup = buildRunReceipt({ config, specs: [spec], fixtures: {}, split: "development" });
    assert.equal(initial.report?.receipt.inputFingerprint, postStartup.inputFingerprint);

    const resumed = await runEvaluation({
      config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir,
    });
    assert.equal(resumed.report?.receipt.inputFingerprint, postStartup.inputFingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("command-grader target mutations are receipted and remain resumable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-grader-fingerprint-"));
  const specFile = path.join(root, "spec.yaml");
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(configFile, "version: 1\n");
  const generatedFile = path.join(root, "grader-output.txt");
  const commandScript = `require('node:fs').writeFileSync(${JSON.stringify(generatedFile)},'built')`;
  const config: EvalConfig = {
    version: 1,
    project: { name: "Grader fingerprint", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Grader fingerprint",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "BUILD", criterion: "Build passes", weight: 1, tags: [], scenarios: [],
      grader: { type: "command", output: "exit-code", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(commandScript)}` },
      passCriteria: "Command completes.",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    const postGrader = buildRunReceipt({ config, specs: [spec], fixtures: {}, split: "development" });
    assert.equal(initial.report?.receipt.inputFingerprint, postGrader.inputFingerprint);
    const resumed = await runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir });
    assert.equal(resumed.report?.receipt.inputFingerprint, postGrader.inputFingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume rejects both an exclusive run lock and a live recorded owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-run-lock-"));
  const specFile = path.join(root, "spec.yaml");
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(configFile, "version: 1\n");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Run lock", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Run lock",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "MANUAL", criterion: "Review", weight: 1, tags: [], scenarios: [],
      grader: { type: "manual" }, passCriteria: "Reviewed.", manualInstructions: "Review.",
    }],
  };

  try {
    const initial = await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
    const lockFile = path.join(initial.runDir, ".run.lock");
    fs.writeFileSync(lockFile, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "other" })}\n`);
    await assert.rejects(
      runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir }),
      /locked by active process/,
    );
    fs.unlinkSync(lockFile);

    const stateFile = path.join(initial.runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.status = "running";
    state.pid = process.pid;
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    await assert.rejects(
      runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: initial.runDir }),
      /run-state\.json belongs to active process/,
    );
    assert.equal(fs.existsSync(lockFile), false, "a rejected resume must release its acquired lock");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rerun setup refreshes the receipt before resumed work is sealed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-resumed-setup-fingerprint-"));
  const startMarker = path.join(os.tmpdir(), `aek-start-marker-${process.pid}-${Date.now()}`);
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(specFile, "source snapshot");
  const node = JSON.stringify(process.execPath);
  const setupScript = "const fs=require('node:fs');const f='generated.txt';const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1))";
  const startScript = `const fs=require('node:fs');const f=${JSON.stringify(startMarker)};if(!fs.existsSync(f)){fs.writeFileSync(f,'started');setTimeout(()=>process.exit(0),150)}else{setInterval(()=>{},1000)}`;
  const config: EvalConfig = {
    version: 1,
    project: { name: "Resumed setup fingerprint", root },
    target: {
      kind: "repository",
      allowedOrigins: [],
      setup: { command: `${node} -e ${JSON.stringify(setupScript)}` },
      start: { command: `${node} -e ${JSON.stringify(startScript)}` },
      ready: { command: "exit 0", timeoutSeconds: 2, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Resumed setup fingerprint",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "WAIT", criterion: "Wait while the first target exits", weight: 1, tags: [], scenarios: [],
      grader: { type: "command", output: "exit-code", command: `${node} -e ${JSON.stringify("setTimeout(()=>process.exit(0),400)")}` },
      passCriteria: "Command completes.",
    }],
  };

  try {
    let runDir = "";
    try {
      await runEvaluation({ config, configFile, specs: [spec], fixtures: {} });
      assert.fail("the first target process should exit during evaluation");
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /Target start command exited during evaluation/);
      const runNames = fs.readdirSync(config.paths.runs);
      assert.equal(runNames.length, 1);
      runDir = path.join(config.paths.runs, runNames[0]);
    }
    assert.equal(fs.readFileSync(path.join(root, "generated.txt"), "utf8"), "1");

    const resumed = await runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: runDir });
    assert.equal(resumed.report?.overallScorePct, 100);
    assert.equal(fs.readFileSync(path.join(root, "generated.txt"), "utf8"), "2");

    // A second resume recomputes the current target receipt before setup is
    // skipped. It catches a final report that retained the pre-rerun hash.
    const sealed = await runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: runDir });
    assert.equal(sealed.report?.receipt.inputFingerprint, resumed.report?.receipt.inputFingerprint);
    assert.equal(fs.readFileSync(path.join(root, "generated.txt"), "utf8"), "2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(startMarker, { force: true });
  }
});

test("runner materializes only the selected split and retains case-level judge records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-runner-cases-"));
  const specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(specFile, "source snapshot");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Cases", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.25, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Cases", sourceFile: specFile,
    scenarios: [{
      id: "S1", name: "Inspect", kind: "workspace", instructions: "Inspect", successSignals: [], dependsOn: [], requiresAuth: false,
      cases: [
        { id: "dev", variables: { plan: "monthly" }, strata: ["plan=monthly"], split: "development" },
        { id: "eval", variables: { plan: "annual" }, strata: ["plan=annual"], split: "evaluation" },
      ],
    }],
    rubric: [{ id: "R1", criterion: "Works", weight: 1, tags: ["case"], scenarios: ["S1"], grader: { type: "llm" }, passCriteria: "Works" }],
  };
  const result = await runEvaluation({ config, configFile: path.join(root, "evalkit.yaml"), specs: [spec], fixtures: {}, split: "evaluation" });
  assert.deepEqual(result.report?.areas[0].scenarios.map((item) => item.scenarioId), ["S1--eval"]);
  assert.equal(result.report?.areas[0].scenarios[0].caseId, "eval");
  assert.equal(result.report?.areas[0].caseResults?.[0].caseId, "eval");
  assert.equal(result.report?.areas[0].caseResults?.[0].points, null);
  assert.equal(result.report?.byStratum?.["plan=annual"].coveragePct, 0);
  assert.equal(result.report?.byStratum?.["plan=annual"].cases, 1);
  assert.equal(result.report?.receipt?.inputs.selection.split, "evaluation");
});

test("a run fails when its managed target exits after readiness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-runner-target-exit-"));
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(specFile, "source snapshot");
  const node = JSON.stringify(process.execPath);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Target exit", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      start: { command: `${node} -e "setTimeout(() => process.exit(0), 150)"` },
      ready: { command: "exit 0", timeoutSeconds: 2, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Target exit",
    sourceFile: specFile, scenarios: [],
    rubric: [{
      id: "WAIT", criterion: "Wait while target exits", weight: 1, tags: [], scenarios: [],
      grader: { type: "command", output: "exit-code", command: `${node} -e "setTimeout(() => process.exit(0), 400)"` },
      passCriteria: "Command completes.",
    }],
  };
  try {
    await assert.rejects(
      runEvaluation({ config, configFile, specs: [spec], fixtures: {} }),
      /Target start command exited during evaluation/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run states without a verifiable input fingerprint cannot be resumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-runner-unverifiable-resume-"));
  const runDir = path.join(root, "runs", "unverifiable-run");
  const configFile = path.join(root, "evalkit.yaml");
  const specFile = path.join(root, "spec.yaml");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(configFile, "version: 1\n");
  fs.writeFileSync(specFile, "source snapshot");
  fs.writeFileSync(path.join(runDir, "run-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    status: "failed",
    runId: "unverifiable-run",
    pid: 0,
    configFile,
    startedAt: "2026-01-01T00:00:00.000Z",
    selectedAreas: ["core"],
    specHashes: { core: "unverifiable" },
  })}\n`);
  writeArtifactIndex(runDir);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Unverifiable", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: specFile, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core", title: "Core", weight: 100, optional: false, description: "Unverifiable",
    sourceFile: specFile, scenarios: [], rubric: [],
  };
  try {
    await assert.rejects(
      runEvaluation({ config, configFile, specs: [spec], fixtures: {}, resumeDir: runDir }),
    /Invalid run state[\s\S]*inputFingerprint/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
