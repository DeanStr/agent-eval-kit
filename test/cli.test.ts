import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { buildCampaignReport } from "../src/campaign.js";
import { writeArtifactIndex } from "../src/integrity.js";
import { commandHelp } from "../src/cli-help.js";

const kitRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(kitRoot, "src", "cli.ts");
const tsxCli = path.join(kitRoot, "node_modules", "tsx", "dist", "cli.mjs");
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "aek-cli-test-"));

test("CLI without arguments prints help successfully", () => {
  const result = runCli(kitRoot, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent Eval Kit/);
  assert.match(result.stdout, /benchmark experiment --recipe/);
});

test("command and subcommand help lists exact accepted options without loading a project", () => {
  for (const [args, included, excluded] of [
    [["run"], "--changed-since", "--repetitions"],
    [["collect"], "--json", "--judge-model"],
    [["campaign"], "--resume", "--changed-since"],
    [["campaign", "compare"], "--allow-incompatible", "--resume"],
    [["benchmark", "experiment"], "--recipe", "--config"],
    [["baseline", "list"], "--suite", "--include-images"],
    [["adjudicate"], "--fail-under-coverage", "--headed"],
    [["validate"], "--suite", "--run"],
    [["list"], "--config", "--scenarios"],
    [["doctor"], "--providers", "--agent"],
    [["judge"], "--evidence", "--dataset"],
    [["judge", "validate"], "--dataset", "--evidence"],
    [["reference", "list"], "--suite", "--reviewer"],
  ] as const) {
    const result = runCli(os.tmpdir(), [...args, "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Usage: aek ${args.join(" ")}`));
    assert.ok(result.stdout.includes(included), result.stdout);
    assert.ok(!result.stdout.includes(excluded), result.stdout);
    assert.doesNotMatch(result.stdout, /\[run flags\]/);
  }
  const invalid = runCli(os.tmpdir(), ["baseline", "typo", "--help"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /baseline requires/);
  const benchmark = runCli(os.tmpdir(), ["benchmark", "--help"]);
  assert.equal(benchmark.status, 0, benchmark.stderr);
  assert.match(benchmark.stdout, /aek benchmark experiment --recipe recipe.json --output/);
  assert.throws(
    () => commandHelp("undocumented", undefined, ["help"], new Set(["help"])),
    /Missing CLI usage for undocumented/,
  );
});

test("benchmark CLI rejects invalid arguments before reading configs or creating output", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [args, message] of [
    [[], /benchmark requires experiment/],
    [["typo"], /benchmark requires experiment/],
    [["experiment"], /requires --recipe/],
    [["experiment", "--recipe"], /--recipe requires a value/],
    [["experiment", "--recipe="], /requires --recipe/],
    [["experiment", "--recipe", "recipe.json"], /requires --output/],
    [["experiment", "--recipe", "recipe.json", "--output"], /--output requires a value/],
    [["experiment", "--recipe", "recipe.json", "--output="], /requires --output/],
    [["experiment", "--dry-run"], /Unknown flag: --dry-run/],
    [["experiment", "--config", "evalkit.yaml"], /Unknown flag: --config/],
    [["experiment", "extra"], /Unexpected positional/],
  ] as const) {
    const result = runCli(root, ["benchmark", ...args]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(fs.readdirSync(root), []);
  fs.writeFileSync(path.join(root, "recipe.json"), "{invalid");
  const malformed = runCli(root, [
    "benchmark",
    "experiment",
    "--recipe",
    "recipe.json",
    "--output",
    "output",
  ]);
  assert.equal(malformed.status, 1);
  assert.ok(
    malformed.stderr.includes(`Cannot read benchmark recipe ${path.join(root, "recipe.json")}`),
  );
  assert.equal(fs.existsSync(path.join(root, "output")), false);
});

test("judge validation CLI rejects missing values, unknown subcommands, mixed modes and extra arguments", () => {
  for (const args of [
    ["judge", "validate"],
    ["judge", "validate", "--dataset"],
    ["judge", "validate", "--evidence", "collection"],
    ["judge", "--dataset", "cases.json"],
    ["judge", "typo"],
    ["judge", "validate", "extra"],
  ]) {
    const result = runCli(os.tmpdir(), args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /requires --dataset|--dataset requires a value|Unknown flag|Unknown judge subcommand|Unexpected positional/,
    );
  }
});

test("collect and campaign JSON previews validate without running graders or creating output", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProject(root);
  const file = path.join(root, "specs/core.yaml");
  const spec = YAML.parse(fs.readFileSync(file, "utf8"));
  spec.rubric.push({
    id: "MODEL",
    criterion: "Inspect",
    passCriteria: "Works",
    weight: 1,
    scenarios: ["S1"],
    grader: { type: "llm" },
  });
  fs.writeFileSync(file, YAML.stringify(spec));
  const collect = runCli(root, ["collect", "--dry-run", "--json"]);
  assert.equal(collect.status, 0, collect.stderr);
  const plan = JSON.parse(collect.stdout);
  assert.equal(plan.mode, "collect");
  assert.equal(
    plan.areas[0].graders.find((g: { id: string }) => g.id === "MODEL").status,
    "deferred",
  );
  assert.equal(plan.judgeCalls.maximum, 0);
  const campaign = runCli(root, [
    "campaign",
    "--repetitions",
    "4",
    "--dry-run",
    "--json",
    "--output",
    path.join(root, "campaign"),
  ]);
  assert.equal(campaign.status, 0, campaign.stderr);
  const repeated = JSON.parse(campaign.stdout);
  assert.equal(repeated.mode, "campaign");
  assert.equal(repeated.repetitions, 4);
  assert.equal(repeated.judgeCalls.maximum, 4);
  assert.equal(fs.existsSync(path.join(root, "campaign")), false);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
  const invalid = runCli(root, ["campaign", "--repetitions", "1", "--dry-run", "--json"]);
  assert.equal(invalid.status, 1);
});

test("CLI campaigns fail when individually passing repetitions use different target inputs", () => {
  const root = temporary();
  try {
    writeProject(root);
    const file = path.join(root, "specs/core.yaml");
    const spec = YAML.parse(fs.readFileSync(file, "utf8"));
    spec.rubric[0].grader.command = `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('target.txt','changed')"`;
    fs.writeFileSync(file, YAML.stringify(spec));
    const output = path.join(root, "campaign");
    const result = runCli(root, [
      "campaign",
      "--repetitions",
      "2",
      "--output",
      output,
      "--fail-under-score",
      "100",
      "--fail-under-coverage",
      "100",
    ]);
    assert.equal(result.status, 2, result.stderr);
    const campaign = JSON.parse(fs.readFileSync(path.join(output, "campaign.json"), "utf8"));
    assert.ok(campaign.runs.every((run: { scorePct: number }) => run.scorePct === 100));
    assert.equal(campaign.compatibility.status, "incompatible");
    assert.equal(campaign.scorePct.state, "unavailable");
    assert.match(result.stderr, /campaign inputs are incompatible/);
    assert.ok(fs.existsSync(path.join(output, "campaign.html")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("CLI execution faults fail without thresholds while valid abstentions remain reports", () => {
  for (const fault of [
    "command-exit",
    "command-json",
    "judge-exit",
    "judge-timeout",
    "judge-schema",
    "judge-omission",
    "scenario-exit",
    "abstention",
  ]) {
    const root = temporary();
    try {
      writeProject(root);
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const answer = {
        items: [
          {
            id: "R1",
            verdict: "cannot_judge",
            confidence: "low",
            reasoning: "Evidence is inconclusive",
            evidenceRefs: [],
          },
        ],
        cases: [],
        defects: [],
        notes: "",
      };
      const behavior =
        fault === "judge-timeout"
          ? "setInterval(() => {}, 1000);"
          : fault === "judge-schema"
            ? 'console.log(JSON.stringify({type:"result",structured_output:{invalid:true}}));'
            : fault === "judge-omission"
              ? 'console.log(JSON.stringify({type:"result",structured_output:{items:[],cases:[],defects:[],notes:""}}));'
              : fault === "abstention"
                ? `console.log(JSON.stringify({type:"result",structured_output:${JSON.stringify(answer)}}));`
                : 'console.error("provider execution failed"); process.exit(7);';
      fs.writeFileSync(
        path.join(bin, "claude"),
        `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("test-provider 1.0"); } else { ${behavior} }\n`,
        { mode: 0o755 },
      );
      const configFile = path.join(root, "evalkit.yaml");
      const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
      if (fault.startsWith("judge") || fault === "abstention")
        config.judge = { provider: "claude", timeoutSeconds: 1 };
      if (fault === "scenario-exit") config.agent = { provider: "claude", timeoutSeconds: 1 };
      fs.writeFileSync(configFile, YAML.stringify(config));
      const specFile = path.join(root, "specs", "core.yaml");
      const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
      spec.rubric[0].gate = false;
      if (fault.startsWith("judge") || fault === "abstention")
        spec.rubric[0].grader = { type: "llm" };
      else
        spec.rubric[0].grader =
          fault === "command-json"
            ? {
                type: "command",
                methodFiles: [],
                output: "json",
                command: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({verdict:"faill",reasoning:"broken"}))'`,
              }
            : {
                type: "command",
                methodFiles: [],
                output: "exit-code",
                command: `${JSON.stringify(process.execPath)} -e "process.exit(127)"`,
              };
      fs.writeFileSync(specFile, YAML.stringify(spec));
      const result = spawnSync(process.execPath, [tsxCli, cli, "run"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      assert.equal(result.status, fault === "abstention" ? 0 : 1, `${fault}: ${result.stderr}`);
      const runDir = path.join(
        root,
        "runs",
        requireDefined(
          fs.readdirSync(path.join(root, "runs"))[0],
          'fs.readdirSync(path.join(root, "runs"))[0]',
        ),
      );
      const state = JSON.parse(fs.readFileSync(path.join(runDir, "run-state.json"), "utf8"));
      assert.equal(state.status, fault === "abstention" ? "complete" : "failed");
      assert.equal(fs.existsSync(path.join(runDir, ".run.lock")), false);
      if (fault.startsWith("judge"))
        assert.ok(fs.existsSync(path.join(runDir, "areas", "core", "_judge", "provider-run.json")));
      if (fault === "scenario-exit")
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(runDir, "S1", "evidence.json"), "utf8")).outcome,
          "agent_error",
        );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function writeProject(root: string, fixtureLine = ""): void {
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "evalkit.yaml"),
    `version: 1
project: { name: CLI integration, root: . }
target: { kind: repository }
agent: { provider: mock }
judge: { provider: mock }
paths:
  specs: specs
  runs: runs
  auth: auth
${fixtureLine}scoring: { partialCredit: 0.5, minimumCoverage: 60 }
`,
  );
  const failingCommand = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;
  fs.writeFileSync(
    path.join(root, "specs", "core.yaml"),
    `id: core
title: Core
weight: 100
description: CLI integration
scenarios:
  - { id: S1, name: Inspect, kind: workspace, instructions: Inspect the project }
rubric:
  - id: R1
    criterion: Deliberate deterministic failure
    weight: 1
    gate: true
    scenarios: []
    grader: { type: command, methodFiles: [], output: exit-code, command: ${JSON.stringify(failingCommand)} }
    passCriteria: The command exits successfully.
`,
  );
}

test("CLI doctor checks only capabilities required by the current project", () => {
  const root = temporary();
  writeProject(root);
  const result = runCli(root, ["doctor"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /playwright chromium \(optional\)/);
  assert.doesNotMatch(
    result.stdout,
    /codex binary|claude binary|grok binary|supported subscription provider/,
  );

  const empty = runCli(root, ["doctor", "--providers="]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--providers requires at least one provider/);
});

test("CLI critical gates preserve run artifacts, and comparison gates preserve comparison artifacts", () => {
  const root = temporary();
  writeProject(root);
  const run = runCli(root, ["run", "--split", "all", "--scenarios", "S1", "--max-turns", "7"]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(
    run.stderr,
    /CI threshold failed: critical gates not satisfied: core\/R1 \(failed: fail\)/,
  );
  const candidateDir = path.join(
    root,
    "runs",
    requireDefined(
      fs.readdirSync(path.join(root, "runs"))[0],
      'fs.readdirSync(path.join(root, "runs"))[0]',
    ),
  );
  const candidate = JSON.parse(fs.readFileSync(path.join(candidateDir, "report.json"), "utf8"));
  const verified = runCli(root, ["verify", "--run", candidateDir]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified \d+ artifacts; root [a-f0-9]{64}/);
  const resumed = runCli(root, ["run", "--resume", candidateDir]);
  assert.equal(resumed.status, 2, resumed.stderr);
  assert.match(resumed.stdout, /Resuming CLI integration/);
  assert.doesNotMatch(resumed.stderr, /changed since this run began/);

  const configFile = path.join(root, "evalkit.yaml");
  const originalConfig = fs.readFileSync(configFile, "utf8");
  const reportFile = path.join(candidateDir, "report.json");
  const reportBeforeRejectedRescore = fs.readFileSync(reportFile);
  fs.writeFileSync(
    configFile,
    originalConfig.replace(
      "agent: { provider: mock }",
      "agent: { provider: mock, model: relabeled-model }",
    ),
  );
  const relabeledRescore = runCli(root, ["rescore", "--run", candidateDir]);
  assert.equal(relabeledRescore.status, 1);
  assert.match(relabeledRescore.stderr, /Resolved config changed outside scoring/);
  assert.deepEqual(fs.readFileSync(reportFile), reportBeforeRejectedRescore);
  fs.writeFileSync(configFile, originalConfig);

  const publicOutput = path.join(root, "public-output");
  const exported = runCli(root, [
    "export",
    "--public",
    "--run",
    candidateDir,
    "--output",
    publicOutput,
  ]);
  assert.equal(exported.status, 0, exported.stderr);
  assert(fs.existsSync(path.join(publicOutput, "public-report.json")));
  assert(fs.existsSync(path.join(publicOutput, "privacy-lint.json")));
  const linted = runCli(root, ["privacy", "lint", "--path", publicOutput]);
  assert.equal(linted.status, 0, linted.stderr);

  const promoted = runCli(root, [
    "baseline",
    "promote",
    "--run",
    candidateDir,
    "--name",
    "main",
    "--reviewer",
    "ci-test",
    "--mode",
    "milestone",
    "--reason",
    "Reviewed failing comparison fixture",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const comparedToNamed = runCli(root, [
    "compare",
    "--baseline-name",
    "main",
    "--candidate",
    candidateDir,
    "--output",
    path.join(root, "named-comparison"),
  ]);
  assert.equal(comparedToNamed.status, 0, comparedToNamed.stderr);
  assert.match(comparedToNamed.stdout, /score \+0 points/);

  const baselineDir = path.join(root, "baseline");
  fs.mkdirSync(baselineDir);
  const baseline = structuredClone(candidate);
  baseline.runId = "baseline";
  baseline.overallScorePct = 100;
  baseline.areas[0].scorePct = 100;
  baseline.areas[0].earned = baseline.areas[0].judgeable;
  baseline.areas[0].items[0].verdict = "pass";
  baseline.areas[0].items[0].score = {
    total: 1,
    judgeable: 1,
    earned: 1,
    scorePct: 100,
    coveragePct: 100,
  };
  baseline.byTag.general.scorePct = 100;
  baseline.byTag.general.earned = baseline.byTag.general.judgeable;
  baseline.areas[0].byTag.general.scorePct = 100;
  baseline.areas[0].byTag.general.earned = baseline.areas[0].byTag.general.judgeable;
  fs.writeFileSync(path.join(baselineDir, "report.json"), JSON.stringify(baseline));
  const baselineState = {
    schemaVersion: 1,
    status: "failed",
    runId: "baseline",
    pid: 0,
    configFile: path.join(root, "evalkit.yaml"),
    startedAt: baseline.startedAt,
    selectedAreas: ["core"],
    specHashes: { core: "test" },
    inputFingerprint: baseline.receipt.inputFingerprint,
  };
  fs.writeFileSync(path.join(baselineDir, "run-state.json"), JSON.stringify(baselineState));

  const output = path.join(root, "comparison");
  const unsealed = runCli(root, [
    "compare",
    "--baseline",
    baselineDir,
    "--candidate",
    candidateDir,
    "--output",
    output,
  ]);
  assert.equal(unsealed.status, 1);
  assert.match(unsealed.stderr, /Missing artifact-index\.json/);
  assert.equal(fs.existsSync(output), false);
  writeArtifactIndex(baselineDir);

  const failedRun = runCli(root, [
    "compare",
    "--baseline",
    baselineDir,
    "--candidate",
    candidateDir,
    "--output",
    output,
  ]);
  assert.equal(failedRun.status, 1);
  assert.match(
    failedRun.stderr,
    /Only complete runs can be compared; baseline run status is failed/,
  );
  assert.equal(fs.existsSync(output), false);
  baselineState.status = "complete";
  fs.writeFileSync(path.join(baselineDir, "run-state.json"), JSON.stringify(baselineState));

  const compared = runCli(root, [
    "compare",
    "--baseline",
    baselineDir,
    "--candidate",
    candidateDir,
    "--output",
    output,
    "--fail-on-regression",
  ]);
  assert.equal(compared.status, 2, compared.stderr);
  assert.match(compared.stderr, /CI comparison failed/);
  assert(fs.existsSync(path.join(output, "comparison.json")));
  assert(fs.existsSync(path.join(output, "comparison.html")));

  const unsafeOutput = path.join(candidateDir, "custom-comparison");
  const rejectedOutput = runCli(root, [
    "compare",
    "--baseline",
    baselineDir,
    "--candidate",
    candidateDir,
    "--output",
    unsafeOutput,
  ]);
  assert.equal(rejectedOutput.status, 1);
  assert.match(
    rejectedOutput.stderr,
    /inside a sealed run must be beneath its comparisons directory/,
  );
  assert.equal(fs.existsSync(unsafeOutput), false);
  const verifiedAfterRejectedOutput = runCli(root, ["verify", "--run", candidateDir]);
  assert.equal(verifiedAfterRejectedOutput.status, 0, verifiedAfterRejectedOutput.stderr);

  const safeInRunOutput = path.join(candidateDir, "comparisons", "custom");
  const acceptedInRunOutput = runCli(root, [
    "compare",
    "--baseline",
    baselineDir,
    "--candidate",
    candidateDir,
    "--output",
    safeInRunOutput,
  ]);
  assert.equal(acceptedInRunOutput.status, 0, acceptedInRunOutput.stderr);
  assert(fs.existsSync(path.join(safeInRunOutput, "comparison.json")));
  const verifiedAfterAcceptedOutput = runCli(root, ["verify", "--run", candidateDir]);
  assert.equal(verifiedAfterAcceptedOutput.status, 0, verifiedAfterAcceptedOutput.stderr);

  const specFile = path.join(root, "specs", "core.yaml");
  const originalSpec = fs.readFileSync(specFile, "utf8");
  fs.writeFileSync(
    specFile,
    originalSpec.replace("Deliberate deterministic failure", "A materially different criterion"),
  );
  const incompatibleRescore = runCli(root, ["rescore", "--run", candidateDir]);
  assert.equal(incompatibleRescore.status, 1);
  assert.match(incompatibleRescore.stderr, /changed in judgement-relevant fields/i);
});

test("CLI campaign runs repeated subscription-compatible evaluations and writes stability artifacts", () => {
  const root = temporary();
  writeProject(root);
  const specFile = path.join(root, "specs", "core.yaml");
  fs.writeFileSync(
    specFile,
    fs.readFileSync(specFile, "utf8").replace("process.exit(1)", "process.exit(0)"),
  );
  const output = path.join(root, "campaign-output");
  const result = runCli(root, ["campaign", "--repetitions", "2", "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  const campaign = JSON.parse(fs.readFileSync(path.join(output, "campaign.json"), "utf8"));
  assert.equal(campaign.status, "complete");
  assert.equal(campaign.coverage.completedRuns, 2);
  assert.equal(campaign.compatibility.status, "compatible");
  assert.equal(campaign.scorePct.value.mean, 100);
  assert(fs.existsSync(path.join(output, "campaign.html")));
  assert.equal(fs.readdirSync(path.join(root, "runs")).length, 2);

  const originalSpec = fs.readFileSync(specFile, "utf8");
  const configFile = path.join(root, "evalkit.yaml");
  const originalConfig = fs.readFileSync(configFile, "utf8");
  const runDir = path.join(
    root,
    "runs",
    requireDefined(
      fs.readdirSync(path.join(root, "runs"))[0],
      'fs.readdirSync(path.join(root, "runs"))[0]',
    ),
  );
  const beforeRescore = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  fs.writeFileSync(specFile, originalSpec.replace("\n    weight: 1\n", "\n    weight: 2\n"));
  const renamedSpecFile = path.join(root, "specs", "renamed.yaml");
  fs.renameSync(specFile, renamedSpecFile);
  fs.writeFileSync(configFile, originalConfig.replace("partialCredit: 0.5", "partialCredit: 0.25"));
  const runStateFile = path.join(runDir, "run-state.json");
  const mutableRunState = JSON.parse(fs.readFileSync(runStateFile, "utf8"));
  mutableRunState.selectedSplit = "evaluation";
  fs.writeFileSync(runStateFile, JSON.stringify(mutableRunState));
  const rescored = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(rescored.status, 0, rescored.stderr);
  assert.match(rescored.stdout, /Rescored:/);
  const afterRescore = JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8"));
  assert.deepEqual(afterRescore.receipt.target, beforeRescore.receipt.target);
  assert.deepEqual(afterRescore.receipt.providers, beforeRescore.receipt.providers);
  assert.deepEqual(afterRescore.receipt.inputs.fixtures, beforeRescore.receipt.inputs.fixtures);
  assert.deepEqual(afterRescore.receipt.inputs.selection, beforeRescore.receipt.inputs.selection);
  assert.deepEqual(afterRescore.receipt.inputs.config, beforeRescore.receipt.inputs.config);
  assert.equal(
    afterRescore.receipt.inputs.specs.core.file,
    beforeRescore.receipt.inputs.specs.core.file,
  );
  assert.notEqual(
    afterRescore.receipt.inputs.methodSha256,
    beforeRescore.receipt.inputs.methodSha256,
  );
  assert.notEqual(
    afterRescore.receipt.inputs.specs.core.sha256,
    beforeRescore.receipt.inputs.specs.core.sha256,
  );
  assert.notEqual(
    afterRescore.receipt.evaluationFingerprint,
    beforeRescore.receipt.evaluationFingerprint,
  );
  assert.notEqual(afterRescore.receipt.inputFingerprint, beforeRescore.receipt.inputFingerprint);
  const rescoredAgain = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(rescoredAgain.status, 0, rescoredAgain.stderr);
  fs.renameSync(renamedSpecFile, specFile);
  fs.writeFileSync(specFile, originalSpec);
  fs.writeFileSync(configFile, originalConfig);

  const secondOutput = path.join(root, "campaign-output-two");
  const repeated = runCli(root, ["campaign", "--repetitions", "2", "--output", secondOutput]);
  assert.equal(repeated.status, 0, repeated.stderr);
  const comparisonOutput = path.join(root, "campaign-comparison");
  const compared = runCli(root, [
    "campaign",
    "compare",
    "--baseline",
    output,
    "--candidate",
    secondOutput,
    "--output",
    comparisonOutput,
  ]);
  assert.equal(compared.status, 0, compared.stderr);
  assert(fs.existsSync(path.join(comparisonOutput, "campaign-comparison.json")));
  assert(fs.existsSync(path.join(comparisonOutput, "campaign-comparison.html")));
});

test("CLI validate rejects a missing fixture path before creating a run", () => {
  const root = temporary();
  writeProject(root, "  fixtures: fixtures.yaml\n");
  fs.writeFileSync(path.join(root, "fixtures.yaml"), "files: { import: ./missing.csv }\n");
  const result = runCli(root, ["validate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /files\.import does not exist/);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
});

test("CLI rejects typoed flags and values passed to booleans", () => {
  const root = temporary();
  writeProject(root);
  const typo = runCli(root, ["run", "--fail-under-scor", "90"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /Unknown flag: --fail-under-scor/);
  const falseBoolean = runCli(root, ["run", "--dry-run=false"]);
  assert.equal(falseBoolean.status, 1);
  assert.match(falseBoolean.stderr, /--dry-run does not take a value/);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
  const subcommandTypo = runCli(root, ["campaign", "compara"]);
  assert.equal(subcommandTypo.status, 1);
  assert.match(subcommandTypo.stderr, /Unknown campaign subcommand compara/);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
});

test("CLI rejects explicitly blank thresholds, providers and execution limits", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProject(root);
  for (const [command, flag] of [
    ["run", "fail-under-score"],
    ["run", "fail-under-coverage"],
    ["run", "agent"],
    ["run", "judge"],
    ["run", "max-turns"],
    ["campaign", "repetitions"],
    ["compare", "max-score-drop"],
    ["compare", "max-coverage-drop"],
  ]) {
    for (const value of ["", " "]) {
      const args = [command!, `--${flag}=${value}`];
      if (command !== "compare") args.push("--dry-run", "--json");
      const result = runCli(root, args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.ok(result.stderr.includes(`--${flag} must be`), result.stderr);
      if (args.includes("--json")) {
        const failure = JSON.parse(result.stdout);
        assert.equal(failure.status, "error");
        assert.equal(failure.exitCode, 1);
        assert.equal(failure.result, null);
        assert.ok(failure.error.message.includes(`--${flag} must be`));
      } else assert.equal(result.stdout, "");
    }
  }
  const zero = runCli(root, [
    "run",
    "--dry-run",
    "--json",
    "--fail-under-score=0",
    "--fail-under-coverage=0",
    "--agent=mock",
    "--judge=mock",
    "--max-turns=1",
  ]);
  assert.equal(zero.status, 0, zero.stderr);
  assert.doesNotThrow(() => JSON.parse(zero.stdout));
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
});

test("CLI supports successive integrity-checked manual finalizations", () => {
  const root = temporary();
  writeProject(root);
  fs.writeFileSync(
    path.join(root, "specs", "core.yaml"),
    `id: core
title: Core
weight: 100
description: Manual revision integration
scenarios:
  - { id: S1, name: Inspect, kind: workspace, instructions: Inspect the project }
rubric:
  - id: MANUAL-1
    criterion: A reviewer verifies the external result
    weight: 1
    scenarios: []
    grader: { type: manual }
    passCriteria: The external result is correct.
    manualInstructions: Inspect the external result.
`,
  );

  const run = runCli(root, ["run", "--split", "all"]);
  assert.equal(run.status, 0, run.stderr);
  const runDir = path.join(
    root,
    "runs",
    requireDefined(
      fs.readdirSync(path.join(root, "runs"))[0],
      'fs.readdirSync(path.join(root, "runs"))[0]',
    ),
  );
  const lockFile = path.join(runDir, ".run.lock");
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "test-owner" })}\n`,
  );
  for (const command of ["rescore", "finalize"]) {
    const locked = runCli(root, [command, "--run", runDir]);
    assert.equal(locked.status, 1);
    assert.match(locked.stderr, /locked by active process/);
  }
  fs.unlinkSync(lockFile);
  const runStateFile = path.join(runDir, "run-state.json");
  const completeState = JSON.parse(fs.readFileSync(runStateFile, "utf8"));
  fs.writeFileSync(runStateFile, `${JSON.stringify({ ...completeState, status: "failed" })}\n`);
  for (const command of ["rescore", "finalize"]) {
    const incomplete = runCli(root, [command, "--run", runDir]);
    assert.equal(incomplete.status, 1);
    assert.match(
      incomplete.stderr,
      new RegExp(`Only complete runs can be ${command === "rescore" ? "rescored" : "finalized"}`),
    );
  }
  fs.writeFileSync(runStateFile, `${JSON.stringify(completeState)}\n`);
  const indexFile = path.join(runDir, "artifact-index.json");
  const indexBackup = path.join(root, "artifact-index.backup.json");
  fs.renameSync(indexFile, indexBackup);
  const withoutIndex = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(withoutIndex.status, 1);
  assert.match(withoutIndex.stderr, /Missing artifact-index\.json/);
  fs.renameSync(indexBackup, indexFile);
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    fs.readFileSync(configFile, "utf8").replace("partialCredit: 0.5", "partialCredit: 0.25"),
  );
  const rescored = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(rescored.status, 0, rescored.stderr);
  const manualFile = path.join(runDir, "manual-results.json");
  fs.writeFileSync(
    manualFile,
    JSON.stringify({ "MANUAL-1": { verdict: "partial", notes: "Partly verified" } }),
  );
  const first = runCli(root, ["finalize", "--run", runDir, "--reviewer", "alice"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8")).overallScorePct,
    25,
  );

  fs.writeFileSync(
    manualFile,
    JSON.stringify({ "MANUAL-1": { verdict: "fail", notes: "Corrected" } }),
  );
  const second = runCli(root, ["finalize", "--run", runDir, "--reviewer", "bob"]);
  assert.equal(second.status, 0, second.stderr);
  const revisions = fs
    .readFileSync(path.join(runDir, "manual-revisions.ndjson"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].previousHash, revisions[0].revisionHash);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runDir, "report.json"), "utf8")).areas[0].items[0].verdict,
    "fail",
  );

  fs.writeFileSync(
    path.join(runDir, "inputs", "config.resolved.yaml"),
    "version: 1\nscoring: { partialCredit: 0.5 }\n",
  );
  writeArtifactIndex(runDir);
  const invalidOriginalScoring = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(invalidOriginalScoring.status, 1);
  assert.match(
    invalidOriginalScoring.stderr,
    /Original resolved config snapshot has invalid scoring settings/,
  );
});

test("CLI campaign regression gate writes completion rates before exiting 2", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of ["before", "after"]) {
    const report = buildCampaignReport({
      campaignId: id,
      project: "CLI",
      startedAt: "now",
      plannedRepetitions: 3,
      runs: [1, 2, 3].map((ordinal) =>
        id === "after" && ordinal > 1
          ? { ordinal, status: "failed", error: "grader crashed" }
          : {
              ordinal,
              status: "complete",
              runId: `${id}-${ordinal}`,
              runDir: `/runs/${id}-${ordinal}`,
              evaluationFingerprint: "e".repeat(64),
              inputFingerprint: "f".repeat(64),
              scorePct: 100,
              coveragePct: 100,
              scoreWithheld: false,
              gatesPassed: true,
              items: [],
              cases: [],
            },
      ),
    });
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify(report));
  }
  const output = path.join(root, "comparison");
  const result = runCli(root, [
    "campaign",
    "compare",
    "--baseline",
    path.join(root, "before.json"),
    "--candidate",
    path.join(root, "after.json"),
    "--output",
    output,
    "--fail-on-regression",
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /completion rate dropped/);
  const comparison = JSON.parse(
    fs.readFileSync(path.join(output, "campaign-comparison.json"), "utf8"),
  );
  assert.equal(comparison.overall.completionRate.candidate, 1 / 3);
  const html = fs.readFileSync(path.join(output, "campaign-comparison.html"), "utf8");
  assert.match(html, /Completion rate.*100% → 33.333%/);
});

test("CLI adjudicates automatic abstentions with explicit review, rescore retention, and private public exports", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProject(root);
  const specFile = path.join(root, "specs/core.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.rubric[0].grader = {
    type: "command",
    methodFiles: [],
    output: "json",
    command: `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({verdict:"cannot_judge",reasoning:"Evidence unavailable"}))'`,
  };
  fs.writeFileSync(specFile, YAML.stringify(spec));
  const run = runCli(root, ["run", "--split", "all"]);
  assert.equal(run.status, 2, run.stderr);
  const runDir = path.join(root, "runs", fs.readdirSync(path.join(root, "runs"))[0]!);
  const reportFile = path.join(runDir, "report.json");
  const original = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(original.overallCoveragePct, 0);
  const inputFile = path.join(root, "decisions.json");
  fs.writeFileSync(path.join(root, "proof.txt"), "Private authenticated observation");
  const decision = {
    areaId: "core",
    itemId: "R1",
    previousRevision: null as string | null,
    verdict: "partial",
    rationale: "Private review rationale",
    evidence: [
      {
        kind: "human",
        path: "proof.txt",
        description: "Private verification",
        observedAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  fs.writeFileSync(inputFile, JSON.stringify({ schemaVersion: 1, decisions: [decision] }));
  const args = ["adjudicate", "--run", runDir, "--input", inputFile];
  const missingReviewer = runCli(root, args);
  assert.equal(missingReviewer.status, 1);
  assert.match(missingReviewer.stderr, /requires --input.*--reviewer/);
  const stateFile = path.join(runDir, "run-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, status: "failed" }));
  const failedRun = runCli(root, [...args, "--reviewer", "reviewer-private"]);
  assert.equal(failedRun.status, 1);
  assert.match(failedRun.stderr, /Only complete runs can be adjudicated/);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const reviewed = runCli(root, [
    ...args,
    "--reviewer",
    "reviewer-private",
    "--fail-under-score",
    "100",
  ]);
  assert.equal(reviewed.status, 2, reviewed.stderr);
  assert.match(reviewed.stdout, /Adjudicated: 50% \/ 100% coverage/);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.deepEqual(report.areas[0].items[0].adjudication.original, original.areas[0].items[0]);
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    fs.readFileSync(configFile, "utf8").replace("partialCredit: 0.5", "partialCredit: 0.25"),
  );
  const rescore = runCli(root, ["rescore", "--run", runDir]);
  assert.equal(rescore.status, 2, rescore.stderr);
  const rescored = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(rescored.overallScorePct, 25);
  assert.deepEqual(rescored.areas[0].items[0].adjudication, report.areas[0].items[0].adjudication);
  const finalize = runCli(root, ["finalize", "--run", runDir]);
  assert.equal(finalize.status, 2, finalize.stderr);
  decision.previousRevision = report.areas[0].items[0].adjudication.revisionHash;
  decision.verdict = "pass";
  fs.writeFileSync(inputFile, JSON.stringify({ schemaVersion: 1, decisions: [decision] }));
  const corrected = runCli(root, [
    ...args,
    "--reviewer",
    "reviewer-private",
    "--fail-under-score",
    "100",
    "--fail-under-coverage",
    "100",
  ]);
  assert.equal(corrected.status, 0, corrected.stderr);
  const verified = runCli(root, ["verify", "--run", runDir]);
  assert.equal(verified.status, 0, verified.stderr);
  const output = path.join(root, "public");
  const exported = runCli(root, ["export", "--public", "--run", runDir, "--output", output]);
  assert.equal(exported.status, 0, exported.stderr);
  const publicText = fs.readFileSync(path.join(output, "public-report.json"), "utf8");
  assert.doesNotMatch(
    publicText,
    /reviewer-private|Private review|proof.txt|Private authenticated/,
  );
  assert.equal(JSON.parse(publicText).areas[0].items[0].adjudication.verdict, "pass");
  const promoted = runCli(root, [
    "baseline",
    "promote",
    "--run",
    runDir,
    "--name",
    "reviewed",
    "--reviewer",
    "publisher",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const compared = runCli(root, [
    "compare",
    "--baseline-name",
    "reviewed",
    "--candidate",
    runDir,
    "--output",
    path.join(root, "comparison"),
  ]);
  assert.equal(compared.status, 0, compared.stderr);
  const baselineRoot = path.join(root, "evals", "baselines", "reviewed");
  const pointer = JSON.parse(fs.readFileSync(path.join(baselineRoot, "current.json"), "utf8"));
  const baselineText = fs.readFileSync(
    path.join(baselineRoot, pointer.snapshotId, "report.json"),
    "utf8",
  );
  assert.doesNotMatch(
    baselineText,
    /reviewer-private|Private review|proof.txt|Private authenticated/,
  );
  assert.equal(JSON.parse(baselineText).areas[0].items[0].adjudication, undefined);
  assert.equal(JSON.parse(baselineText).areas[0].items[0].adjudicationReceipt.verdict, "pass");
});

test("JSON planning validates selectors and returns only selected scenarios without running", () => {
  const root = temporary();
  try {
    writeProject(root);
    const specFile = path.join(root, "specs/core.yaml");
    const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
    spec.scenarios.push({ ...spec.scenarios[0], id: "S2" });
    fs.writeFileSync(specFile, YAML.stringify(spec));
    const result = runCli(root, ["run", "--dry-run", "--json", "--scenarios", "S2"]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.version, 2);
    assert.deepEqual(
      plan.areas[0].scenarios.map((s: { id: string }) => s.id),
      ["S2"],
    );
    assert.equal(plan.areas[0].graders[0].type, "command");
    assert.ok(plan.areas[0].graders[0].command);
    assert.equal(plan.judgeCalls.maximum, 0);
    assert.equal(fs.existsSync(path.join(root, "runs")), false);
    const invalid = runCli(root, ["run", "--dry-run", "--json", "--scenarios", "missing"]);
    assert.equal(invalid.status, 1);
    const invalidThreshold = runCli(root, [
      "run",
      "--dry-run",
      "--json",
      "--fail-under-score",
      "101",
    ]);
    assert.equal(invalidThreshold.status, 1);
    assert.match(invalidThreshold.stderr, /--fail-under-score/);
    assert.equal(fs.existsSync(path.join(root, "runs")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI doctor honors explicit suite selection and requires its config", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProject(root);
  const configFile = path.join(root, "evalkit.yaml");
  const base = YAML.parse(fs.readFileSync(configFile, "utf8"));
  const suites = {
    local: { agent: { provider: "mock" }, judge: { provider: "mock" }, paths: { specs: "specs" } },
    other: { judge: { provider: "claude" }, paths: { specs: "missing-default-specs" } },
  };
  for (const selectedDefault of [undefined, "other"]) {
    fs.writeFileSync(
      configFile,
      YAML.stringify({ ...base, suites, ...(selectedDefault ? { suite: selectedDefault } : {}) }),
    );
    const result = runCli(root, ["doctor", "--suite", "local"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /codex binary|claude binary|grok binary/);
  }
  const unknown = runCli(root, ["doctor", "--suite", "missing"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Known suites/);
  fs.unlinkSync(configFile);
  const missing = runCli(root, ["doctor", "--suite", "local", "--providers", "mock"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No config file/);
});

test("JSON planning stays machine-readable with text-case selection", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProject(root);
  const specFile = path.join(root, "specs/core.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.scenarios = [];
  spec.datasets = { drafts: [{ id: "one", inputs: { draft: { text: "A clear draft." } } }] };
  spec.rubric = [
    {
      id: "QUALITY",
      dataset: "drafts",
      criterion: "Clear writing",
      passCriteria: "Clear",
      weight: 1,
      grader: { type: "text-rubric", inputs: { draft: { file: "{{inputs.draft}}" } } },
    },
  ];
  fs.writeFileSync(specFile, YAML.stringify(spec));
  const result = runCli(root, ["run", "--dry-run", "--json", "--text-cases", "core/drafts/one"]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.version, 2);
  assert.deepEqual(plan.areas[0].scenarios, []);
  assert.deepEqual(plan.areas[0].graders[0].cases, [{ id: "core/drafts/one", selected: true }]);
  assert.equal(plan.judgeCalls.minimum, 5);
  assert.equal(plan.judgeCalls.maximum, 9);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
});
