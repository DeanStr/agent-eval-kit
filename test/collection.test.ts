import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs, loadSelectedSpecs } from "../src/specs.js";
import { buildRunReceipt } from "../src/receipts.js";
import { runEvaluation } from "../src/runner.js";
import { judgeCollected } from "../src/judge-run.js";
import { assertArtifactIntegrity } from "../src/integrity.js";
import { loadRunState } from "../src/run/state.js";
import { evaluatePromotion } from "../src/promotion.js";
import { promoteBaseline } from "../src/baselines.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-collection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml"),
    specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    `import fs from 'node:fs'; fs.appendFileSync('executions', 'check\\n'); console.log(JSON.stringify({verdict:'pass', reasoning:'Observed executable assertion passed', evidenceRefs:[]}));`,
  );
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Collected project" },
      target: {
        kind: "repository",
        setup: {
          command: `"${process.execPath}" -e "require('fs').appendFileSync('executions','setup\\n')"`,
        },
      },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
    }),
  );
  const spec = {
    id: "core",
    title: "Core",
    weight: 100,
    description: "Two independent cases",
    scenarios: ["ONE", "TWO"].map((id) => ({ id, name: id, instructions: "Observe behavior" })),
    rubric: [
      {
        id: "CHECK",
        criterion: "Executable check",
        weight: 1,
        gate: true,
        scenarios: [] as string[],
        grader: {
          type: "command",
          command: `"${process.execPath}" check.mjs`,
          output: "json",
          methodFiles: ["check.mjs"],
        },
        passCriteria: "Check succeeds",
      },
    ],
  };
  fs.writeFileSync(specFile, YAML.stringify(spec));
  const options = () => ({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(specFile),
    fixtures: {},
    split: "all" as const,
  });
  return { root, configFile, specFile, spec, options };
}

test("collection seals executable evidence; detached judges never revisit the target and preserve every result", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  assert.equal(collected.report, undefined);
  assert.equal(loadRunState(collected.runDir).mode, "collect");
  assert.equal(fs.existsSync(path.join(collected.runDir, "report.json")), false);
  const sealed = fs.readFileSync(path.join(collected.runDir, "artifact-index.json"));
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
  const input = f.options();
  const beforePaths = fs.readdirSync(collected.runDir);
  await assert.rejects(
    judgeCollected({
      ...input,
      evidenceDir: collected.runDir,
      config: { ...input.config, paths: { ...input.config.paths, runs: collected.runDir } },
    }),
    /outside the immutable collection/,
  );
  assert.deepEqual(fs.readdirSync(collected.runDir), beforePaths);
  const alias = path.join(f.root, "collection-alias");
  fs.symlinkSync(collected.runDir, alias, "dir");
  await assert.rejects(
    judgeCollected({
      ...input,
      evidenceDir: collected.runDir,
      config: {
        ...input.config,
        paths: { ...input.config.paths, runs: path.join(alias, "new", "runs") },
      },
    }),
    /outside the immutable collection/,
  );
  assert.deepEqual(fs.readdirSync(collected.runDir), beforePaths);
  const combinedMethod = buildRunReceipt(input).evaluationFingerprint;
  fs.unlinkSync(path.join(f.root, "check.mjs"));
  const first = await judgeCollected({ ...input, evidenceDir: collected.runDir });
  const second = await judgeCollected({
    ...input,
    evidenceDir: collected.runDir,
    config: { ...input.config, judge: { ...input.config.judge, model: "alternate" } },
  });
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(first.report.overallScorePct, 100);
  assert.equal(
    first.report.receipt.evaluationFingerprint,
    combinedMethod,
    "detached and combined judging retain comparable evaluation methods",
  );
  assert.match(
    fs.readFileSync(path.join(first.runDir, "report.html"), "utf8"),
    /Evidence from collection/,
  );
  assert.equal(first.report.receipt.collection?.runId, path.basename(collected.runDir));
  assert.deepEqual(first.report.receipt.target, second.report.receipt.target);
  assert.notEqual(
    first.report.receipt.evaluationFingerprint,
    second.report.receipt.evaluationFingerprint,
  );
  assert.deepEqual(fs.readFileSync(path.join(collected.runDir, "artifact-index.json")), sealed);
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
  for (const dir of [collected.runDir, first.runDir, second.runDir])
    assertArtifactIntegrity(dir, { require: true });
  await assert.rejects(
    runEvaluation({ ...input, collectOnly: true, resumeDir: collected.runDir }),
    /Collection is sealed/,
  );
});

test("new rubrics reuse collection; changed collection contracts and corrupted evidence fail before judging", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const changed = {
    ...structuredClone(f.spec),
    rubric: [
      ...f.spec.rubric,
      {
        id: "QUALITY",
        criterion: "Labels are legible",
        weight: 1,
        scenarios: ["ONE"],
        grader: { type: "llm" },
        passCriteria: "Visible labels can be read",
        evidence: "Screenshot of labels",
      },
    ],
  };
  fs.writeFileSync(f.specFile, YAML.stringify(changed));
  const judged = await judgeCollected({
    ...f.options(),
    evidenceDir: collected.runDir,
    explicitConfig: true,
  });
  assert.equal(
    requireDefined(judged.report.areas[0], "test fixture: judged.report.areas[0]").items.find(
      (item) => item.id === "QUALITY",
    )?.verdict,
    "cannot_judge",
  );
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
  const stale = f.options();
  requireDefined(stale.specs[0], "test fixture: stale.specs[0]").rubric.find(
    (item) => item.id === "QUALITY",
  )!.criterion = "Unsaved change";
  const beforeFailedPreparation = fs.readdirSync(stale.config.paths.runs);
  await assert.rejects(
    judgeCollected({ ...stale, evidenceDir: collected.runDir, explicitConfig: true }),
    /differs from the loaded judging definition/,
  );
  assert.deepEqual(
    fs.readdirSync(stale.config.paths.runs),
    beforeFailedPreparation,
    "failed preparation leaves no unusable judging run",
  );
  requireDefined(changed.scenarios[0], "test fixture: changed.scenarios[0]").instructions =
    "Also exercise a new interaction";
  fs.writeFileSync(f.specFile, YAML.stringify(changed));
  await assert.rejects(
    judgeCollected({ ...f.options(), evidenceDir: collected.runDir, explicitConfig: true }),
    /Scenario or executable check definitions changed/,
  );
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  const input = f.options();
  await assert.rejects(
    judgeCollected({
      ...input,
      evidenceDir: collected.runDir,
      explicitConfig: true,
      config: { ...input.config, variables: { different: true } },
    }),
    /Collection configuration changed/,
  );
  fs.appendFileSync(path.join(f.root, "check.mjs"), "\n// new implementation");
  await assert.rejects(
    judgeCollected({ ...f.options(), evidenceDir: collected.runDir, explicitConfig: true }),
    /Executable check implementation changed/,
  );
  fs.appendFileSync(path.join(collected.runDir, "ONE", "evidence.json"), " ");
  await assert.rejects(
    judgeCollected({ ...f.options(), evidenceDir: collected.runDir }),
    /Artifact integrity/,
  );
});

test("release promotion enforces the declared suite, gates and coverage; milestones record a reason", async (t) => {
  const f = fixture(t);
  const subset = await runEvaluation({ ...f.options(), scenarioIds: ["ONE"] });
  assert.throws(
    () =>
      promoteBaseline({
        config: f.options().config,
        runDir: subset.runDir,
        name: "main",
        reviewer: "test",
      }),
    /required scenario TWO was not exercised/,
  );
  assert.equal(fs.existsSync(path.join(f.root, "evals", "baselines", "main")), false);
  assert.throws(
    () =>
      promoteBaseline({
        config: f.options().config,
        runDir: subset.runDir,
        name: "main",
        reviewer: "test",
        mode: "milestone",
      }),
    /review reason/,
  );
  const milestone = promoteBaseline({
    config: f.options().config,
    runDir: subset.runDir,
    name: "milestone",
    reviewer: "test",
    mode: "milestone",
    reason: "Reviewed partial implementation",
  });
  assert.equal(milestone.promotion.policy?.mode, "milestone");
  const full = await runEvaluation(f.options());
  const release = promoteBaseline({
    config: f.options().config,
    runDir: full.runDir,
    name: "main",
    reviewer: "test",
  });
  assert.equal(release.promotion.policy?.mode, "release");
  const unavailable = structuredClone(full.report!);
  requireDefined(
    requireDefined(unavailable.areas[0], "test fixture: unavailable.areas[0]").gates[0],
    "test fixture: unavailable.areas[0].gates[0]",
  ).status = "unavailable";
  assert.match(
    evaluatePromotion(f.options().config, unavailable, "release").failures.join("\n"),
    /required gate core\/CHECK is unavailable/,
  );
  const thin = structuredClone(full.report!);
  requireDefined(thin.areas[0], "test fixture: thin.areas[0]").judgeable = 0;
  requireDefined(thin.areas[0], "test fixture: thin.areas[0]").earned = 0;
  assert.match(
    evaluatePromotion(f.options().config, thin, "release").failures.join("\n"),
    /coverage 0%/,
  );
  f.spec.scenarios.push({ id: "THREE", name: "Third", instructions: "New requirement" });
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  assert.throws(
    () =>
      promoteBaseline({
        config: f.options().config,
        runDir: full.runDir,
        name: "main",
        reviewer: "test",
      }),
    /suite definition changed/,
  );
});

test("detached judging, rescore and finalize work without project files or the collection", async (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.variables = { literal: `\${AEK_COLLECTION_LITERAL}` };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
      encoding: "utf8",
      cwd: f.root,
      env: { ...process.env, AEK_COLLECTION_LITERAL: `\${AEK_UNSET_LITERAL}` },
    });
  const collected = run("collect", "--config", f.configFile, "--split", "all");
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  const runs = path.join(f.root, ".agent-eval", "runs");
  const evidence = path.join(
    runs,
    requireDefined(fs.readdirSync(runs)[0], "test fixture: fs.readdirSync(runs)[0]"),
  );
  for (const file of [f.configFile, f.specFile, path.join(f.root, "check.mjs")])
    fs.unlinkSync(file);
  const judged = run("judge", "--evidence", evidence, "--judge", "mock");
  assert.equal(judged.status, 0, judged.stdout + judged.stderr);
  assert.equal(fs.readdirSync(runs).length, 2);
  const judgedDir = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  fs.rmSync(evidence, { recursive: true });
  for (const command of ["rescore", "finalize"]) {
    const result = run(command, "--run", judgedDir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assertArtifactIntegrity(judgedDir, { require: true });
  }
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
});

test("resuming detached judging reuses sealed completed areas", async (t) => {
  const f = fixture(t);
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  for (const id of ["first", "second"]) {
    fs.writeFileSync(
      path.join(specsDir, id + ".yaml"),
      YAML.stringify({
        ...f.spec,
        id,
        weight: 50,
        scenarios: [{ id: id.toUpperCase(), name: id, instructions: "Observe behavior" }],
        rubric: [
          {
            id: id + "_QUALITY",
            criterion: "Labels readable",
            weight: 1,
            scenarios: [id.toUpperCase()],
            grader: { type: "llm" },
            passCriteria: "Readable",
            evidence: "Visible labels",
          },
        ],
      }),
    );
  }
  const input = { ...f.options(), specs: loadSpecs(specsDir) };
  const collected = await runEvaluation({ ...input, collectOnly: true });
  let calls = 0;
  await assert.rejects(
    judgeCollected({
      ...input,
      evidenceDir: collected.runDir,
      onProgress: (message) => {
        if (message.includes("judge mock") && ++calls === 2)
          throw new Error("interrupted second area");
      },
    }),
    /interrupted second area/,
  );
  const failed = fs
    .readdirSync(input.config.paths.runs)
    .map((name) => path.join(input.config.paths.runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  const prior = JSON.parse(fs.readFileSync(path.join(failed, "report.json"), "utf8"));
  let resumedCalls = 0;
  const resumed = await judgeCollected({
    ...input,
    evidenceDir: collected.runDir,
    resumeDir: failed,
    onProgress: (message) => {
      if (message.includes("judge mock")) resumedCalls++;
    },
  });
  assert.equal(resumedCalls, 1);
  assert.deepEqual(
    requireDefined(resumed.report.areas[0], "test fixture: resumed.report.areas[0]"),
    requireDefined(prior.areas[0], "test fixture: prior.areas[0]"),
  );
});

test("promotion includes optional area coverage and score only when requested", async (t) => {
  const f = fixture(t);
  const full = await runEvaluation(f.options());
  const optional = {
    ...f.spec,
    id: "optional",
    optional: true,
    scenarios: [],
    rubric: f.spec.rubric.map((item) => ({ ...item, id: "OPTIONAL", gate: false })),
  };
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  fs.copyFileSync(f.specFile, path.join(specsDir, "core.yaml"));
  const optionalFile = path.join(specsDir, "optional.yaml");
  fs.writeFileSync(optionalFile, YAML.stringify(optional));
  const report = structuredClone(full.report!);
  const area = {
    ...structuredClone(requireDefined(report.areas[0], "test fixture: report.areas[0]")),
    id: "optional",
    optional: true,
    gates: [],
    scenarios: [],
    items: requireDefined(report.areas[0], "test fixture: report.areas[0]").items.map((item) => ({
      ...item,
      id: "OPTIONAL",
    })),
    judgeable: 0,
    earned: 0,
  };
  report.areas.push(area);
  const { sha256 } = await import("../src/io.js");
  report.receipt.inputs.specs.optional = {
    ...requireDefined(report.receipt.inputs.specs.core, "core spec receipt"),
    sha256: sha256(fs.readFileSync(optionalFile)),
  };
  const config = {
    ...f.options().config,
    paths: { ...f.options().config.paths, specs: specsDir },
    promotion: {
      split: "all" as const,
      minimumCoverage: 100,
      minimumScore: 90,
      includeOptional: false,
    },
  };
  assert.deepEqual(evaluatePromotion(config, report, "release").failures, []);
  config.promotion.includeOptional = true;
  assert.match(
    evaluatePromotion(config, report, "release").failures.join("\n"),
    /coverage .*below required/,
  );
  area.judgeable = area.total;
  assert.match(
    evaluatePromotion(config, report, "release").failures.join("\n"),
    /score .*below required/,
  );
});

test("collection recovery reruns checks when scenario evidence must be recollected", async (t) => {
  const f = fixture(t);
  const input = { ...f.options(), ignoredTargetPaths: [path.join(f.root, "executions")] };
  const collected = await runEvaluation({ ...input, collectOnly: true });
  // Model an interruption before the final complete-state write.
  const state = loadRunState(collected.runDir);
  state.status = "failed";
  fs.writeFileSync(path.join(collected.runDir, "run-state.json"), JSON.stringify(state));
  fs.appendFileSync(path.join(collected.runDir, "ONE", "evidence.json"), " ");
  await runEvaluation({ ...input, collectOnly: true, resumeDir: collected.runDir });
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\ncheck\n");
  assertArtifactIntegrity(collected.runDir, { require: true });
});

test("detached judging rejects malformed collected commands without executing the checker", async (t) => {
  const f = fixture(t);
  const input = f.options();
  const collected = await runEvaluation({ ...input, collectOnly: true });
  const file = path.join(collected.runDir, "areas/core/collected-commands.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  const { writeArtifactIndex } = await import("../src/integrity.js");
  for (const invalid of [
    null,
    false,
    {},
    [],
    [
      requireDefined(original[0], "test fixture: original[0]"),
      requireDefined(original[0], "test fixture: original[0]"),
    ],
    [{ ...requireDefined(original[0], "test fixture: original[0]"), source: "llm" }],
    [{ ...requireDefined(original[0], "test fixture: original[0]"), verdict: "unknown" }],
    [{ ...requireDefined(original[0], "test fixture: original[0]"), id: "OTHER" }],
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    writeArtifactIndex(collected.runDir);
    await assert.rejects(
      judgeCollected({ ...input, evidenceDir: collected.runDir }),
      /Invalid collected command results|Collected command IDs/,
    );
    assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
  }
});

test("judging requires an explicit command mode and preserves collected uncertainty", async (t) => {
  const f = fixture(t);
  const { config, specs } = f.options();
  const { judgeArea } = await import("../src/graders.js");
  const input = {
    config,
    spec: requireDefined(specs[0], "test fixture: specs[0]"),
    evidence: [],
    runDir: f.root,
    areaDirectory: path.join(f.root, "area"),
  };
  for (const commands of [undefined, null, { mode: "unknown" }]) {
    await assert.rejects(
      judgeArea({ ...input, commands: commands as never }),
      /Command mode must be execute or collected/,
    );
  }
  const result = await judgeArea({
    ...input,
    commands: {
      mode: "collected",
      results: [
        {
          id: "CHECK",
          source: "command",
          verdict: "cannot_judge",
          confidence: "low",
          reasoning: "Insufficient evidence",
          evidenceRefs: [],
        },
      ],
    },
  });
  assert.equal(
    requireDefined(result.items[0], "test fixture: result.items[0]").verdict,
    "cannot_judge",
  );
  assert.equal(fs.existsSync(path.join(f.root, "executions")), false);
});

test("downstream commands preserve resolved detached config and honor explicit config overrides", async (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.variables = { literal: `\${AEK_REVIEW_LITERAL}` };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
      encoding: "utf8",
      cwd: f.root,
      env: { ...process.env, AEK_REVIEW_LITERAL: `\${AEK_REVIEW_UNDEFINED}` },
    });
  const check = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  check("collect", "--config", f.configFile, "--split", "all");
  const runs = path.join(f.root, ".agent-eval", "runs");
  const evidence = path.join(
    runs,
    requireDefined(fs.readdirSync(runs)[0], "test fixture: fs.readdirSync(runs)[0]"),
  );
  check("judge", "--evidence", evidence);
  const judged = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  check("rescore", "--run", judged);
  check("finalize", "--run", judged, "--reviewer", "test");
  const rejectedPolicy = run(
    "baseline",
    "promote",
    "--run",
    judged,
    "--name",
    "main",
    "--reviewer",
    "test",
  );
  assert.equal(rejectedPolicy.status, 1);
  assert.match(rejectedPolicy.stderr, /requires --config.*current promotion policy/);
  check(
    "baseline",
    "promote",
    "--run",
    judged,
    "--config",
    f.configFile,
    "--name",
    "main",
    "--reviewer",
    "test",
  );
  // Explicit config uses current definitions and still expands environment placeholders.
  requireDefined(f.spec.rubric[0], "test fixture: f.spec.rubric[0]").weight = 2;
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  check("rescore", "--run", judged, "--config", f.configFile);
  const report = JSON.parse(fs.readFileSync(path.join(judged, "report.json"), "utf8"));
  assert.equal(report.overallScorePct, 100);
  assert.equal(requireDefined(report.areas[0], "test fixture: report.areas[0]").total, 2);
  requireDefined(f.spec.rubric[0], "test fixture: f.spec.rubric[0]").criterion =
    "Changed judgement requirement";
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  for (const command of ["rescore", "finalize"]) {
    const rejected = run(command, "--run", judged, "--config", f.configFile);
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /changed in judgement-relevant fields|changed since evidence was judged/,
    );
  }
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
});

test("renaming a spec before detached judging preserves receipt snapshot paths and rescoring", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const renamed = path.join(f.root, "renamed.yaml");
  fs.renameSync(f.specFile, renamed);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.paths.specs = "renamed.yaml";
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const judged = await judgeCollected({
    config: loadConfig(f.configFile),
    configFile: f.configFile,
    specs: loadSpecs(renamed),
    fixtures: {},
    evidenceDir: collected.runDir,
    explicitConfig: true,
  });
  const recorded = requireDefined(
    judged.report.receipt.inputs.specs.core,
    "core spec receipt",
  ).file;
  assert.equal(recorded, path.basename(f.specFile));
  assert.deepEqual(
    fs.readFileSync(path.join(judged.runDir, "inputs", "specs", recorded)),
    fs.readFileSync(renamed),
  );
  fs.unlinkSync(renamed);
  fs.unlinkSync(f.configFile);
  fs.rmSync(collected.runDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.resolve("src/cli.ts"),
      "rescore",
      "--run",
      judged.runDir,
    ],
    { encoding: "utf8", cwd: f.root },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertArtifactIntegrity(judged.runDir, { require: true });
});

test("release promotion requires the execution split to match its policy", async (t) => {
  const f = fixture(t);
  const raw = {
    ...f.spec,
    scenarios: f.spec.scenarios.map((scenario, index) => ({
      ...scenario,
      split: index ? "evaluation" : "development",
    })),
    rubric: f.spec.rubric.map((item) => ({ ...item, scenarios: ["ONE", "TWO"] })),
  };
  fs.writeFileSync(f.specFile, YAML.stringify(raw));
  const input = f.options();
  const full = await runEvaluation(input);
  const config = {
    ...input.config,
    promotion: { split: "evaluation" as const, minimumCoverage: 100, includeOptional: false },
  };
  assert.match(
    evaluatePromotion(config, full.report!, "release").failures.join("\n"),
    /run split all does not match promotion split evaluation/,
  );
  const evaluation = await runEvaluation({ ...input, split: "evaluation" });
  assert.deepEqual(evaluatePromotion(config, evaluation.report!, "release").failures, []);
});

test("finalization rejects changed collection config independently of saved method provenance", async (t) => {
  const f = fixture(t);
  const evaluated = await runEvaluation(f.options());
  const original = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  const cli = path.resolve("src/cli.ts");
  const index = fs.readFileSync(path.join(evaluated.runDir, "artifact-index.json"));
  for (const changed of [
    { ...original, variables: { changed: true } },
    { ...original, instructions: "Different collection instructions" },
    { ...original, browser: { viewport: { width: 900, height: 700 } } },
    { ...original, agent: { provider: "mock", model: "different" } },
  ]) {
    fs.writeFileSync(f.configFile, YAML.stringify(changed));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        cli,
        "finalize",
        "--run",
        evaluated.runDir,
        "--reviewer",
        "test",
      ],
      { encoding: "utf8", cwd: f.root },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Resolved config changed outside scoring/);
    assert.deepEqual(fs.readFileSync(path.join(evaluated.runDir, "artifact-index.json")), index);
  }
});

test("detached deterministic judging does not require a model CLI but model graders do", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const emptyBin = path.join(f.root, "empty-bin");
  fs.mkdirSync(emptyBin);
  const cli = path.resolve("src/cli.ts");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        cli,
        "judge",
        "--evidence",
        collected.runDir,
        "--judge",
        "codex",
        ...args,
      ],
      { encoding: "utf8", cwd: f.root, env: { ...process.env, PATH: emptyBin } },
    );
  const deterministic = run();
  assert.equal(deterministic.status, 0, deterministic.stdout + deterministic.stderr);
  const runs = f.options().config.paths.runs;
  const judged = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  const report = JSON.parse(fs.readFileSync(path.join(judged, "report.json"), "utf8"));
  assert.equal(report.receipt.providers.judge.cliVersion, "not invoked (deterministic judging)");
  const changed = {
    ...f.spec,
    rubric: [
      ...f.spec.rubric,
      {
        id: "QUALITY",
        criterion: "Readable labels",
        weight: 1,
        scenarios: ["ONE"],
        grader: { type: "llm" },
        passCriteria: "Readable",
        evidence: "Visible labels",
      },
    ],
  };
  fs.writeFileSync(f.specFile, YAML.stringify(changed));
  const model = run("--config", f.configFile);
  assert.equal(model.status, 1);
  assert.match(model.stderr, /Unable to determine codex CLI version/);
  assert.equal(fs.readFileSync(path.join(f.root, "executions"), "utf8"), "setup\ncheck\n");
});

test("detached postprocessing rejects damaged snapshots even when original definitions exist", async (t) => {
  const f = fixture(t);
  const input = f.options();
  const collected = await runEvaluation({ ...input, collectOnly: true });
  const judged = await judgeCollected({ ...input, evidenceDir: collected.runDir });
  const index = fs.readFileSync(path.join(judged.runDir, "artifact-index.json"));
  for (const relative of ["inputs/config.resolved.yaml", "inputs/specs/spec.yaml"]) {
    const file = path.join(judged.runDir, relative);
    const bytes = fs.readFileSync(file);
    for (const missing of [false, true]) {
      if (missing) fs.unlinkSync(file);
      else fs.appendFileSync(file, "\n# corrupted");
      for (const command of ["rescore", "finalize"]) {
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            path.resolve("src/cli.ts"),
            command,
            "--run",
            judged.runDir,
          ],
          { encoding: "utf8", cwd: f.root },
        );
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /Artifact integrity/);
        assert.deepEqual(fs.readFileSync(path.join(judged.runDir, "artifact-index.json")), index);
      }
      fs.writeFileSync(file, bytes);
    }
  }
});

test("detached rescoring retains effective definitions and recovers their publication with the report", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const judged = await judgeCollected({ ...f.options(), evidenceDir: collected.runDir });
  const originalSpec = fs.readFileSync(path.join(judged.runDir, "inputs/specs/spec.yaml"));
  const originalConfig = fs.readFileSync(path.join(judged.runDir, "inputs/config.resolved.yaml"));
  requireDefined(f.spec.rubric[0], "test fixture: f.spec.rubric[0]").weight = 2;
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.scoring = { partialCredit: 0.25, minimumCoverage: 70 };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), ...args],
      { cwd: f.root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  cli("rescore", "--run", judged.runDir, "--config", f.configFile);
  const effective = JSON.parse(fs.readFileSync(path.join(judged.runDir, "report.json"), "utf8"));
  assert.equal(requireDefined(effective.areas[0], "test fixture: effective.areas[0]").total, 2);
  assert.ok(effective.receipt.inputs.scoringConfig);
  fs.unlinkSync(f.specFile);
  fs.unlinkSync(f.configFile);
  fs.rmSync(collected.runDir, { recursive: true });
  cli("finalize", "--run", judged.runDir);
  cli("rescore", "--run", judged.runDir);
  const after = JSON.parse(fs.readFileSync(path.join(judged.runDir, "report.json"), "utf8"));
  assert.equal(requireDefined(after.areas[0], "test fixture: after.areas[0]").total, 2);
  assert.equal(after.receipt.inputs.methodSha256, effective.receipt.inputs.methodSha256);
  assert.deepEqual(
    fs.readFileSync(path.join(judged.runDir, "inputs/specs/spec.yaml")),
    originalSpec,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(judged.runDir, "inputs/config.resolved.yaml")),
    originalConfig,
  );
  const { loadSealedDefinitions } = await import("../src/run/inputs.js");
  const definitions = loadSealedDefinitions(judged.runDir, after.receipt);
  const { writeReportArtifactsRecoverably, recoverInterruptedReportUpdate } = await import(
    "../src/report.js"
  );
  const rename = fs.renameSync;
  const target = path.join(judged.runDir, "scoring-definitions/config.resolved.yaml");
  fs.renameSync = ((from, to) => {
    if (String(to) === target) throw new Error("simulated scoring publication interruption");
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => writeReportArtifactsRecoverably(judged.runDir, after, definitions.specs, definitions),
      /simulated scoring publication interruption/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(recoverInterruptedReportUpdate(judged.runDir), true);
  assertArtifactIntegrity(judged.runDir, { require: true });
  fs.unlinkSync(target);
  for (const command of ["rescore", "finalize"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        command,
        "--run",
        judged.runDir,
      ],
      { cwd: f.root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Artifact integrity/);
  }
});

test("full config can rescore redacted detached provenance while changed secrets fail", async (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.variables = { password: "private-original-value" };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), ...args],
      { cwd: f.root, encoding: "utf8" },
    );
  const check = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  check("collect", "--config", f.configFile, "--split", "all");
  const runs = f.options().config.paths.runs;
  const collected = path.join(
    runs,
    requireDefined(fs.readdirSync(runs)[0], "test fixture: fs.readdirSync(runs)[0]"),
  );
  check("judge", "--evidence", collected);
  const judged = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  raw.scoring = { partialCredit: 0.25, minimumCoverage: 70 };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  check("rescore", "--run", judged, "--config", f.configFile);
  check("finalize", "--run", judged, "--config", f.configFile);
  check("finalize", "--run", judged);
  assert.equal(
    fs
      .readFileSync(path.join(judged, "scoring-definitions/config.resolved.yaml"), "utf8")
      .includes("private-original-value"),
    false,
  );
  raw.variables.password = "different-private-value";
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  for (const command of ["rescore", "finalize"]) {
    const result = cli(command, "--run", judged, "--config", f.configFile);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Resolved config changed outside scoring/);
  }
});

test("sealed partial suites can be judged and postprocessed without full-suite weight totals", async (t) => {
  const f = fixture(t);
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify({ ...f.spec, weight: 50 }));
  fs.writeFileSync(
    path.join(specsDir, "other.yaml"),
    YAML.stringify({
      ...f.spec,
      id: "other",
      weight: 50,
      scenarios: f.spec.scenarios.map((scenario) => ({ ...scenario, id: "OTHER_" + scenario.id })),
      rubric: f.spec.rubric.map((item) => ({ ...item, id: "OTHER_CHECK" })),
    }),
  );
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.paths.specs = "specs";
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), ...args],
      { cwd: f.root, encoding: "utf8" },
    );
  const check = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  check("collect", "--config", f.configFile, "--areas", "core", "--split", "all");
  const runs = loadConfig(f.configFile).paths.runs;
  const collected = path.join(
    runs,
    requireDefined(fs.readdirSync(runs)[0], "test fixture: fs.readdirSync(runs)[0]"),
  );
  assert.throws(() => loadSpecs(path.join(collected, "inputs/specs")), /weights must sum to 100/);
  check("judge", "--evidence", collected);
  const judged = fs
    .readdirSync(runs)
    .map((name) => path.join(runs, name))
    .find((dir) => loadRunState(dir).mode === "judge")!;
  check("finalize", "--run", judged);
  check("rescore", "--run", judged);
  check("finalize", "--run", judged);
  check("rescore", "--run", judged, "--config", f.configFile);
  const report = JSON.parse(fs.readFileSync(path.join(judged, "report.json"), "utf8"));
  assert.deepEqual(
    report.areas.map((area: { id: string }) => area.id),
    ["core"],
  );
  assert.equal(requireDefined(report.areas[0], "test fixture: report.areas[0]").weight, 50);
  const promotion = cli(
    "baseline",
    "promote",
    "--run",
    judged,
    "--config",
    f.configFile,
    "--name",
    "main",
    "--reviewer",
    "test",
  );
  assert.equal(promotion.status, 2);
  assert.match(promotion.stderr, /missing required area other/);
});

test("prerequisite-only areas retain command manifests and participate in promotion definition checks", async (t) => {
  const f = fixture(t);
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  const core = {
    ...f.spec,
    weight: 100,
    scenarios: f.spec.scenarios.map((scenario) => ({ ...scenario, dependsOn: ["SETUP"] })),
  };
  const prerequisite = {
    id: "prerequisite",
    title: "Prerequisite",
    description: "Setup",
    weight: 50,
    optional: true,
    scenarios: [
      { id: "SETUP", name: "Setup", instructions: "Prepare the workflow" },
      {
        id: "FUTURE",
        name: "Future",
        instructions: "Evaluate future behavior",
        split: "evaluation",
      },
    ],
    rubric: [
      {
        id: "FUTURE_CHECK",
        criterion: "Works",
        passCriteria: "Verified",
        weight: 1,
        scenarios: ["FUTURE"],
        grader: { type: "llm" },
        evidence: "Observed behavior",
      },
    ],
  };
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify(core));
  const prerequisiteFile = path.join(specsDir, "prerequisite.yaml");
  fs.writeFileSync(prerequisiteFile, YAML.stringify(prerequisite));
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.paths.specs = "specs";
  raw.promotion = { split: "development" };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const input = () => ({
    config: loadConfig(f.configFile),
    configFile: f.configFile,
    specs: loadSpecs(specsDir),
    fixtures: {},
    split: "development" as const,
  });
  const collected = await runEvaluation({ ...input(), collectOnly: true });
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(collected.runDir, "areas/prerequisite/collected-commands.json"),
        "utf8",
      ),
    ),
    [],
  );
  const judged = await judgeCollected({ ...input(), evidenceDir: collected.runDir });
  assert.deepEqual(
    judged.report.areas.map((area) => area.id),
    ["core"],
  );
  const policy = evaluatePromotion(input().config, judged.report, "release");
  assert.deepEqual(policy.failures, []);
  assert.ok(policy.expectedScenarios?.includes("SETUP"));
  requireDefined(
    prerequisite.scenarios[0],
    "test fixture: prerequisite.scenarios[0]",
  ).instructions = "Changed prerequisite definition";
  fs.writeFileSync(prerequisiteFile, YAML.stringify(prerequisite));
  assert.match(
    evaluatePromotion(input().config, judged.report, "release").failures.join("\n"),
    /suite definition changed for prerequisite/,
  );
  requireDefined(
    prerequisite.scenarios[0],
    "test fixture: prerequisite.scenarios[0]",
  ).instructions = "Prepare the workflow";
  fs.writeFileSync(prerequisiteFile, YAML.stringify(prerequisite));
  requireDefined(core.scenarios[0], "test fixture: core.scenarios[0]").dependsOn = [];
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify(core));
  const filtered = await runEvaluation({ ...input(), collectOnly: true, scenarioIds: ["ONE"] });
  const skipped = JSON.parse(
    fs.readFileSync(path.join(filtered.runDir, "SETUP/evidence.json"), "utf8"),
  );
  assert.equal(skipped.outcome, "blocked");
  assert.match(skipped.summary, /no selected scoring scenario required/);
  assertArtifactIntegrity(filtered.runDir, { require: true });
  // Restore the original contract for the first collection's recalibration.
  requireDefined(core.scenarios[0], "test fixture: core.scenarios[0]").dependsOn = ["SETUP"];
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify(core));
  prerequisite.rubric.push({
    ...requireDefined(prerequisite.rubric[0], "test fixture: prerequisite.rubric[0]"),
    id: "SETUP_CHECK",
    scenarios: ["SETUP"],
  });
  fs.writeFileSync(prerequisiteFile, YAML.stringify(prerequisite));
  const recalibrated = await judgeCollected({
    ...input(),
    evidenceDir: collected.runDir,
    explicitConfig: true,
  });
  assert.deepEqual(
    recalibrated.report.areas.map((area) => area.id),
    ["core", "prerequisite"],
  );
  assert.equal(
    requireDefined(
      requireDefined(recalibrated.report.areas[1], "test fixture: recalibrated.report.areas[1]")
        .items[0],
      "test fixture: recalibrated.report.areas[1].items[0]",
    ).verdict,
    "cannot_judge",
  );
  requireDefined(core.scenarios[0], "test fixture: core.scenarios[0]").dependsOn = [];
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify(core));
  const filteredJudged = await judgeCollected({
    ...input(),
    evidenceDir: filtered.runDir,
    explicitConfig: true,
  });
  const skippedArea = filteredJudged.report.areas.find((area) => area.id === "prerequisite")!;
  assert.equal(
    requireDefined(skippedArea.items[0], "test fixture: skippedArea.items[0]").verdict,
    "cannot_judge",
  );
  assert.equal(skippedArea.coveragePct, 0);
  assert.equal(
    fs.readFileSync(path.join(f.root, "executions"), "utf8"),
    "setup\ncheck\nsetup\ncheck\n",
  );
});

test("redacted judge inputs fail before execution unless an explicit config restores them", async (t) => {
  for (const field of ["instructions", "project", "arguments"]) {
    const f = fixture(t);
    const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
    if (field === "instructions") raw.instructions = "The password field must be masked.";
    if (field === "project") raw.project.name = "The password field project";
    if (field === "arguments") raw.judge.extraArgs = ["--token=private-provider-token"];
    fs.writeFileSync(f.configFile, YAML.stringify(raw));
    const spec = {
      ...f.spec,
      rubric: [
        ...f.spec.rubric,
        {
          id: "QUALITY",
          criterion: "Readable labels",
          passCriteria: "Labels are readable",
          weight: 1,
          scenarios: ["ONE"],
          grader: { type: "llm" },
          evidence: "Observed labels",
        },
      ],
    };
    fs.writeFileSync(f.specFile, YAML.stringify(spec));
    const collected = await runEvaluation({ ...f.options(), collectOnly: true });
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.resolve("src/cli.ts"),
          "judge",
          "--evidence",
          collected.runDir,
          ...args,
        ],
        { cwd: f.root, encoding: "utf8" },
      );
    const before = fs.readdirSync(f.options().config.paths.runs);
    const rejected = cli();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Sealed judge inputs differ.*Supply --config/);
    assert.deepEqual(fs.readdirSync(f.options().config.paths.runs), before);
    const explicit = cli("--config", f.configFile);
    assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
    const judged = fs
      .readdirSync(f.options().config.paths.runs)
      .map((name) => path.join(f.options().config.paths.runs, name))
      .find((dir) => loadRunState(dir).mode === "judge")!;
    const fingerprint = JSON.parse(fs.readFileSync(path.join(judged, "report.json"), "utf8"))
      .receipt.evaluationFingerprint;
    for (const command of ["finalize", "rescore", "finalize"]) {
      const processed = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.resolve("src/cli.ts"),
          command,
          "--run",
          judged,
        ],
        { cwd: f.root, encoding: "utf8" },
      );
      assert.equal(processed.status, 0, processed.stdout + processed.stderr);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(judged, "report.json"), "utf8")).receipt
          .evaluationFingerprint,
        fingerprint,
      );
    }
    if (field === "instructions") {
      const prompt = fs.readFileSync(path.join(judged, "areas/core/_judge/prompt.md"), "utf8");
      assert.match(prompt, /The password field must be masked\./);
      assert.equal(prompt.includes("The password [REDACTED]"), false);
    }
  }
});

test("explicit model overrides remain supported with unchanged snapshot judge inputs", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.specFile,
    YAML.stringify({
      ...f.spec,
      rubric: [
        ...f.spec.rubric,
        {
          id: "QUALITY",
          criterion: "Readable",
          passCriteria: "Readable",
          weight: 1,
          scenarios: ["ONE"],
          grader: { type: "llm" },
          evidence: "Labels",
        },
      ],
    }),
  );
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.resolve("src/cli.ts"),
      "judge",
      "--evidence",
      collected.runDir,
      "--judge",
      "mock",
      "--judge-model",
      "alternate",
    ],
    { cwd: f.root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("detached receipts retain collection runtime independently of judging and postprocessing", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const receiptFile = path.join(collected.runDir, "receipt.json");
  const source = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  Object.assign(source.runtime, {
    node: "v20.12.0",
    platform: "darwin",
    arch: "arm64",
    kitVersion: "collection-version",
  });
  fs.writeFileSync(receiptFile, JSON.stringify(source));
  const { writeArtifactIndex } = await import("../src/integrity.js");
  writeArtifactIndex(collected.runDir);
  const judged = await judgeCollected({ ...f.options(), evidenceDir: collected.runDir });
  const check = (runtime: typeof source.runtime) => {
    for (const key of ["node", "platform", "arch", "kitVersion", "evidence"])
      assert.deepEqual(runtime[key], source.runtime[key]);
    assert.equal(runtime.judging.node, process.version);
    assert.equal(runtime.judging.platform, process.platform);
    assert.equal(runtime.judging.arch, process.arch);
    assert.notEqual(runtime.judging.kitVersion, "collection-version");
  };
  check(judged.report.receipt.runtime);
  fs.rmSync(collected.runDir, { recursive: true });
  for (const command of ["rescore", "finalize"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        command,
        "--run",
        judged.runDir,
      ],
      { encoding: "utf8", cwd: f.root },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    check(
      JSON.parse(fs.readFileSync(path.join(judged.runDir, "report.json"), "utf8")).receipt.runtime,
    );
  }
});

test("detached promotion enforces an explicitly selected current release policy", async (t) => {
  const f = fixture(t);
  requireDefined(f.spec.rubric[0], "test fixture: f.spec.rubric[0]").gate = false;
  fs.writeFileSync(f.specFile, YAML.stringify(f.spec));
  const checker = path.join(f.root, "check.mjs");
  fs.writeFileSync(
    checker,
    fs.readFileSync(checker, "utf8").replace("verdict:'pass'", "verdict:'partial'"),
  );
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const judged = await judgeCollected({ ...f.options(), evidenceDir: collected.runDir });
  assert.equal(judged.report.overallScorePct, 50);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.promotion = { minimumScore: 90 };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  for (const explicit of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve("src/cli.ts"),
        "baseline",
        "promote",
        "--run",
        judged.runDir,
        "--name",
        "main",
        "--reviewer",
        "test",
        ...(explicit ? ["--config", f.configFile] : []),
      ],
      { encoding: "utf8", cwd: f.root },
    );
    assert.equal(result.status, explicit ? 2 : 1, result.stdout + result.stderr);
    assert.match(result.stderr, explicit ? /score 50% is below required 90%/ : /requires --config/);
  }
});

test("detached copies keep browser authentication state owner-only", async (t) => {
  const f = fixture(t);
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  const relative = ".state/browser.json";
  const stateFile = path.join(collected.runDir, relative);
  fs.mkdirSync(path.dirname(stateFile));
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ cookies: [{ value: "private-cookie" }], origins: [] }),
    { mode: 0o600 },
  );
  const { writeArtifactIndex } = await import("../src/integrity.js");
  writeArtifactIndex(collected.runDir);
  const judged = await judgeCollected({ ...f.options(), evidenceDir: collected.runDir });
  const copied = path.join(judged.runDir, relative);
  assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(stateFile));
  assertArtifactIntegrity(judged.runDir, { require: true });
});

test("visual rubric calibration preserves comparable collection and evaluation methods", async (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.target = { kind: "web", url: "http://localhost:4321" };
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const spec = {
    ...f.spec,
    rubric: [
      {
        id: "QUALITY",
        criterion: "Works",
        passCriteria: "Works",
        weight: 1,
        scenarios: ["ONE", "TWO"],
        grader: { type: "llm" },
      },
    ],
  };
  fs.writeFileSync(f.specFile, YAML.stringify(spec));
  const collected = await runEvaluation({ ...f.options(), collectOnly: true });
  fs.writeFileSync(
    f.specFile,
    YAML.stringify({
      ...spec,
      rubric: [
        ...spec.rubric,
        {
          id: "DISTINCT",
          criterion: "Distinct",
          passCriteria: "Distinct",
          weight: 1,
          scenarios: ["ONE", "TWO"],
          grader: { type: "image-distinctness", candidate: "shot", minimumDistance: 0.01 },
        },
      ],
    }),
  );
  const judged = await judgeCollected({
    ...f.options(),
    evidenceDir: collected.runDir,
    explicitConfig: true,
  });
  const combined = await runEvaluation(f.options());
  assert.equal(
    judged.report.receipt.inputs.collectionMethodSha256,
    combined.report!.receipt.inputs.collectionMethodSha256,
  );
  assert.equal(
    judged.report.receipt.evaluationFingerprint,
    combined.report!.receipt.evaluationFingerprint,
  );
});

test("sealed split selections ignore inactive external dependencies and reject missing active prerequisites", async (t) => {
  const f = fixture(t);
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  const core = {
    ...f.spec,
    weight: 50,
    scenarios: [
      requireDefined(f.spec.scenarios[0], "test fixture: f.spec.scenarios[0]"),
      {
        ...requireDefined(f.spec.scenarios[1], "test fixture: f.spec.scenarios[1]"),
        split: "evaluation",
        dependsOn: ["EXTERNAL"],
        inputs: { value: { from: "EXTERNAL", output: "value" } },
      },
    ],
  };
  const external = {
    ...f.spec,
    id: "external",
    weight: 50,
    scenarios: [
      {
        id: "EXTERNAL",
        name: "External",
        instructions: "Produce value",
        split: "evaluation",
        outputs: { value: { type: "string" } },
      },
    ],
    rubric: [
      {
        ...requireDefined(f.spec.rubric[0], "test fixture: f.spec.rubric[0]"),
        id: "EXTERNAL_CHECK",
      },
    ],
  };
  fs.writeFileSync(path.join(specsDir, "core.yaml"), YAML.stringify(core));
  fs.writeFileSync(path.join(specsDir, "external.yaml"), YAML.stringify(external));
  const raw = YAML.parse(fs.readFileSync(f.configFile, "utf8"));
  raw.paths.specs = "specs";
  fs.writeFileSync(f.configFile, YAML.stringify(raw));
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), ...args],
      { encoding: "utf8", cwd: f.root },
    );
  const collected = cli(
    "collect",
    "--config",
    f.configFile,
    "--areas",
    "core",
    "--split",
    "development",
  );
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  const runs = f.options().config.paths.runs;
  const evidence = path.join(
    runs,
    requireDefined(fs.readdirSync(runs)[0], "test fixture: fs.readdirSync(runs)[0]"),
  );
  const snapshots = path.join(evidence, "inputs/specs");
  assert.equal(loadSelectedSpecs(snapshots, "development").length, 1);
  assert.throws(() => loadSelectedSpecs(snapshots, "evaluation"), /Required scenario EXTERNAL/);
  for (const explicit of [false, true]) {
    const judged = cli(
      "judge",
      "--evidence",
      evidence,
      ...(explicit ? ["--config", f.configFile] : []),
    );
    assert.equal(judged.status, 0, judged.stdout + judged.stderr);
    const runDir = requireDefined(
      /Artifacts: (.+)/.exec(judged.stdout)![1],
      "test fixture: /Artifacts: (.+)/.exec(judged.stdout)![1]",
    );
    for (const command of ["finalize", "rescore", "finalize"]) {
      const result = cli(command, "--run", runDir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  }
});
