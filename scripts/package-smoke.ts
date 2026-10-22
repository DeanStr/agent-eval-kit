import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnCaptured } from "../src/providers/process.js";

const kitRoot = path.resolve(import.meta.dirname, "..");
const [archiveFlag, archiveInput, ...extraArgs] = process.argv.slice(2);
if (archiveFlag !== undefined && (archiveFlag !== "--archive" || !archiveInput || extraArgs.length))
  throw new Error("Usage: pnpm smoke:package [--archive path/to/reviewed.tgz]");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aek-package-smoke-"));
let ordinal = 0;
async function run(
  command: string,
  args: string[],
  cwd: string,
  expectedExit = 0,
): Promise<string> {
  const id = ++ordinal;
  const result = await spawnCaptured({
    command,
    args,
    cwd,
    timeoutSeconds: 180,
    stdoutFile: path.join(scratch, `${id}.stdout.log`),
    stderrFile: path.join(scratch, `${id}.stderr.log`),
  });
  assert.equal(result.timedOut, false, `Timed out: ${command}`);
  assert.equal(
    result.exitCode,
    expectedExit,
    `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
}

try {
  let archive: string;
  if (archiveInput) {
    archive = path.resolve(archiveInput);
    fs.accessSync(archive, fs.constants.R_OK);
  } else {
    await run("pnpm", ["build"], kitRoot);
    const packed = JSON.parse(
      await run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
        kitRoot,
      ),
    );
    archive = path.join(scratch, packed[0].filename);
  }
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "aek-package-consumer", private: true }),
  );
  await run(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", archive],
    consumer,
  );
  const installed = path.join(consumer, "node_modules/agent-eval-kit");
  for (const name of ["config", "spec"]) {
    const schema = JSON.parse(
      fs.readFileSync(path.join(installed, "dist/schemas", `${name}.schema.json`), "utf8"),
    );
    assert.equal(schema.type, "object");
    assert.ok(schema.properties);
  }
  for (const file of [
    "server.mjs",
    "evalkit.yaml",
    "index.html",
    "reference.svg",
    "specs/dashboard.yaml",
  ])
    assert.ok(fs.statSync(path.join(installed, "examples/visual", file)).isFile(), file);
  for (const file of [
    "run.mjs",
    "docker-runner.mjs",
    "collect.mjs",
    "check.mjs",
    "spec.yaml",
    "controls.example.json",
    "definition.mjs",
    "experiment.json",
    "evalkit.yaml",
    "README.md",
    "fixture/TASK.md",
    "fixture/cart.mjs",
    "fixture/cart.test.mjs",
    "variants/plain.md",
    "variants/reviewed.md",
  ])
    assert.ok(fs.statSync(path.join(installed, "examples/skill-comparison", file)).isFile(), file);
  for (const file of ["run.mjs", "experiment.mjs", "recipe.example.json", "README.md"])
    assert.ok(fs.statSync(path.join(installed, "examples/benchmark", file)).isFile(), file);
  assert.ok(fs.statSync(path.join(installed, "dist/benchmark-experiment-worker.js")).isFile());
  const benchmarkApi = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {benchmarkMeasurementsSchema, compareBenchmarkCampaigns} from 'agent-eval-kit/benchmark'; if(typeof benchmarkMeasurementsSchema.parse !== 'function' || typeof compareBenchmarkCampaigns !== 'function') process.exit(1)",
    ],
    consumer,
  );
  assert.equal(benchmarkApi.trim(), "");
  const experimentRoot = path.join(scratch, "controlled-experiment");
  fs.mkdirSync(experimentRoot);
  for (const side of ["baseline", "candidate"]) {
    const project = path.join(experimentRoot, side);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, ".env"), `AEK_PACKAGE_BENCHMARK_SIDE=${side}\n`);
    fs.writeFileSync(path.join(project, "subject.json"), JSON.stringify({ side }));
    fs.writeFileSync(
      path.join(project, "evalkit.yaml"),
      YAML.stringify({
        version: 1,
        project: { name: "Packaged experiment" },
        target: { kind: "command" },
        agent: { provider: "mock" },
        judge: { provider: "mock" },
        paths: { specs: "spec.yaml" },
      }),
    );
    fs.writeFileSync(
      path.join(project, "collect.mjs"),
      `
import fs from 'node:fs';import path from 'node:path';
const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8')),s=JSON.parse(fs.readFileSync(c.sources.subject.path,'utf8'));
if(process.env.AEK_PACKAGE_BENCHMARK_SIDE!==s.side)throw Error('Environment mixed');
const m={version:1,candidate:{id:s.side,revision:s.side},workload:{id:'work',sha256:'a'.repeat(64)},method:{id:'timer',sha256:'b'.repeat(64)},environment:{hardware:'fixture'},work:{unit:'items',requested:1,completed:1},outcome:{state:'completed'},metrics:[{id:'time',unit:'ms',preferredDirection:'lower',scope:'application',observation:{state:'observed',samples:[s.side==='baseline'?10:5]}}],correctness:[{scenarioId:'WORKLOAD',fileLabel:'raw'}]};
fs.writeFileSync(path.join(c.outputDir,'measurements.json'),JSON.stringify(m));fs.writeFileSync(path.join(c.outputDir,'raw.json'),JSON.stringify({valid:true}));
console.log(JSON.stringify({version:1,outcome:'completed',summary:'Package fixture',observations:['Synthetic values; no performance claim'],files:['measurements','raw'].map(label=>({label,path:label+'.json',filename:label+'.json',mediaType:'application/json'}))}));
`,
    );
    fs.writeFileSync(
      path.join(project, "check.mjs"),
      `
import fs from 'node:fs';import path from 'node:path';
const d=path.join(process.env.AEK_RUN_DIR,'WORKLOAD'),e=JSON.parse(fs.readFileSync(path.join(d,'evidence.json'),'utf8')),f=e.files.find(f=>f.label==='raw'),r=JSON.parse(fs.readFileSync(path.join(d,f.path),'utf8'));
console.log(JSON.stringify({verdict:r.valid?'pass':'fail',confidence:'high',reasoning:'Independent package fixture check',evidenceRefs:['WORKLOAD/'+f.path]}));
`,
    );
    fs.writeFileSync(
      path.join(project, "spec.yaml"),
      YAML.stringify({
        id: "bench",
        title: "Benchmark fixture",
        description: "Installed process boundary",
        weight: 100,
        scenarios: [
          {
            id: "WORKLOAD",
            name: "Fixture",
            kind: "command",
            instructions: "Observe the fixture",
            collect: {
              command: "node collect.mjs",
              methodFiles: ["collect.mjs"],
              sources: { subject: "subject.json" },
              files: ["measurements", "raw"],
            },
          },
        ],
        rubric: [
          {
            id: "VALID",
            criterion: "Valid observation",
            passCriteria: "The fixture is valid",
            weight: 1,
            gate: true,
            scenarios: ["WORKLOAD"],
            grader: {
              type: "command",
              command: "node check.mjs",
              output: "json",
              methodFiles: ["check.mjs"],
            },
          },
        ],
      }),
    );
  }
  const experimentOutput = path.join(experimentRoot, "output"),
    experimentRecipe = path.join(experimentRoot, "recipe.json");
  fs.writeFileSync(
    experimentRecipe,
    JSON.stringify({
      version: 1,
      candidates: { baseline: "baseline/evalkit.yaml", candidate: "candidate/evalkit.yaml" },
      baseline: "baseline",
      blocks: [
        ["baseline", "candidate"],
        ["candidate", "baseline"],
      ],
      resource: "resource",
      timeoutSeconds: 30,
      measurement: { scenarioId: "WORKLOAD", fileLabel: "measurements" },
    }),
  );
  const experimentCli = await run(
    path.join(consumer, "node_modules/.bin/aek"),
    ["benchmark", "experiment", "--recipe", experimentRecipe, "--output", experimentOutput],
    consumer,
  );
  assert.match(experimentCli, /Experiment outcome: compared/);
  assert.ok(experimentCli.includes(`Report: ${path.join(experimentOutput, "experiment.html")}`));
  const experiment = JSON.parse(
    fs.readFileSync(path.join(experimentOutput, "summary.json"), "utf8"),
  );
  assert.equal(experiment.outcome, "compared");
  assert.equal(experiment.visits.length, 4);
  assert.deepEqual(experiment.unattempted, []);
  assert.equal(fs.existsSync(path.join(experimentRoot, "resource/.run.lock")), false);
  const benchmarkRecipe = path.join(scratch, "benchmark-recipe");
  fs.mkdirSync(benchmarkRecipe);
  for (const side of ["baseline", "candidate"])
    fs.writeFileSync(path.join(benchmarkRecipe, `${side}.yaml`), "version: 1\n");
  fs.writeFileSync(
    path.join(benchmarkRecipe, "failed-cli.mjs"),
    "console.error('Fixture execution failure'); process.exit(1);\n",
  );
  fs.writeFileSync(
    path.join(benchmarkRecipe, "recipe.json"),
    JSON.stringify({
      version: 1,
      baseline: "baseline.yaml",
      candidate: "candidate.yaml",
      repetitions: 2,
      timeoutSeconds: 10,
      measurement: { scenarioId: "WORKLOAD", fileLabel: "measurements" },
    }),
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const {runBenchmark} = await import(${JSON.stringify(path.join(installed, "examples/benchmark/run.mjs"))});
    const root = ${JSON.stringify(benchmarkRecipe)};
    const result = await runBenchmark(root+'/output', root+'/recipe.json', {cli:[root+'/failed-cli.mjs']});
    assert.equal(result.outcome, 'execution_error');
    assert.deepEqual(result.unattemptedCampaigns, ['candidate']);
    assert.equal(result.executions.baseline.exitCode, 1);
    assert.equal(fs.existsSync(root+'/output/candidate.stdout'), false);
  `,
    ],
    consumer,
  );
  assert.equal(
    fs.existsSync(path.join(installed, "src")),
    false,
    "package should run without source files",
  );
  assert.equal(
    fs.existsSync(path.join(consumer, "node_modules/tsx")),
    false,
    "consumer should not need tsx",
  );
  const cli = path.join(consumer, "node_modules/.bin/aek");
  assert.match(await run(cli, ["--help"], consumer), /Agent Eval Kit/);
  const validationHelp = await run(cli, ["judge", "validate", "--help"], consumer);
  assert.match(validationHelp, /--dataset/);
  assert.doesNotMatch(validationHelp, /--evidence/);
  assert.ok(fs.existsSync(path.join(installed, "docs/judge-validation.md")));
  assert.ok(fs.existsSync(path.join(installed, "examples/judge-validation/README.md")));
  const visualCalibration = path.join(scratch, "visual-calibration-example");
  await run(
    process.execPath,
    [
      path.join(installed, "examples/visual/calibrate.mjs"),
      visualCalibration,
      "--prepare-only",
      "--provider",
      "cursor",
      "--model",
      "package-fixture-model",
    ],
    consumer,
  );
  const visualCases = JSON.parse(
    fs.readFileSync(path.join(visualCalibration, "cases.json"), "utf8"),
  );
  const visualLabels = JSON.parse(
    fs.readFileSync(path.join(visualCalibration, "labels.json"), "utf8"),
  );
  const visualCalibrationConfig = JSON.parse(
    fs.readFileSync(path.join(visualCalibration, "project/evalkit.yaml"), "utf8"),
  );
  assert.equal(visualCalibrationConfig.judge.provider, "cursor");
  assert.equal(visualCalibrationConfig.judge.model, "package-fixture-model");
  assert.equal(visualCases.cases.length, 6);
  assert.equal(visualLabels.labels.length, 6);
  assert.ok(
    visualLabels.labels.every(
      (label: { reviewer: { kind: string } }) => label.reviewer.kind === "agent",
    ),
  );
  const validationExample = path.join(scratch, "judge-validation-example");
  await run(
    process.execPath,
    [path.join(installed, "examples/judge-validation/run.mjs"), validationExample],
    consumer,
  );
  const validation = JSON.parse(
    fs.readFileSync(path.join(validationExample, "comparison/validation-results.json"), "utf8"),
  );
  assert.equal(validation.observations.length, 6);
  assert.deepEqual(
    validation.observations.map((item: { status: string }) => item.status),
    ["judged", "judged", "abstained", "judged", "judged", "abstained"],
  );
  for (const result of validation.results) {
    assert.equal(result.metrics.exactMatches.count, 3);
    assert.equal(result.metrics.executionErrors.count, 0);
  }
  const validationHtml = fs.readFileSync(
    path.join(validationExample, "comparison/validation-results.html"),
    "utf8",
  );
  assert.match(validationHtml, /Reviewed expectations/);
  assert.match(validationHtml, /The synthetic observation records pass/);
  assert.match(validationHtml, /href="attempts\/original\/case-1\/runs\//);
  const representative = path.join(scratch, "representative-judge-pilot");
  const pilotExample = path.join(installed, "examples/judge-validation/pilot.mjs");
  await run(
    process.execPath,
    [pilotExample, "prepare", representative, "--judge", "mock"],
    consumer,
  );
  await run(process.execPath, [pilotExample, "compare", representative], consumer);
  const pilotSummary = JSON.parse(
    fs.readFileSync(path.join(representative, "pilot-summary.json"), "utf8"),
  );
  assert.equal(pilotSummary.cases, 12);
  assert.equal(pilotSummary.judge, "mock");
  assert.ok(
    pilotSummary.results.every(
      (result: {
        metrics: { executionErrors: { count: number }; decisionCoverage: { count: number } };
      }) =>
        result.metrics.executionErrors.count === 0 && result.metrics.decisionCoverage.count === 0,
    ),
  );
  // Follow the installed first-run guide with a disposable target outside the
  // consumer, retaining the installed command's working directory throughout.
  const firstExample = path.join(scratch, "first-run-example");
  fs.cpSync(path.join(installed, "examples", "first-run"), firstExample, { recursive: true });
  assert.ok(fs.existsSync(path.join(installed, "docs", "first-run.md")));
  assert.ok(fs.existsSync(path.join(installed, "docs", "deployment.md")));
  const firstConfig = path.join(firstExample, "evalkit.yaml");
  const firstCli = (args: string[], expectedExit = 0) =>
    run("npx", ["--no-install", "aek", ...args], consumer, expectedExit);
  await firstCli(["validate", "--config", firstConfig]);
  const firstRuns = path.join(firstExample, ".agent-eval", "runs");
  const firstEvaluate = async (expectedExit: number, score: number, gate: boolean) => {
    const previous = fs.existsSync(firstRuns) ? fs.readdirSync(firstRuns) : [];
    await firstCli(["run", "--config", firstConfig], expectedExit);
    const added = fs.readdirSync(firstRuns).filter((id) => !previous.includes(id));
    assert.equal(added.length, 1);
    const directory = path.join(firstRuns, added[0]!);
    const report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
    assert.equal(report.overallScorePct, score);
    assert.equal(report.overallCoveragePct, 80);
    assert.equal(report.scoreWithheld, false);
    assert.equal(report.manualPending, 1);
    assert.equal(report.gates.passed, gate);
    assert.ok(fs.existsSync(path.join(directory, "report.html")));
    await firstCli(["verify", "--run", directory]);
    return directory;
  };
  const firstBaseline = await firstEvaluate(0, 100, true);
  fs.writeFileSync(
    path.join(firstExample, "cart.mjs"),
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  const firstCandidate = await firstEvaluate(2, 25, false);
  const firstComparison = path.join(scratch, "first-run-comparison");
  await firstCli(
    [
      "compare",
      "--baseline",
      firstBaseline,
      "--candidate",
      firstCandidate,
      "--fail-on-regression",
      "--output",
      firstComparison,
    ],
    2,
  );
  const firstDelta = JSON.parse(
    fs.readFileSync(path.join(firstComparison, "comparison.json"), "utf8"),
  );
  assert.equal(firstDelta.compatibility.status, "compatible");
  assert.equal(firstDelta.overall.scorePct.delta, -75);
  assert.equal(firstDelta.overall.coveragePct.delta, 0);
  assert.ok(fs.existsSync(path.join(firstComparison, "comparison.html")));

  const imageFile = path.join(consumer, "image.svg");
  fs.writeFileSync(
    imageFile,
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#3274ab"/></svg>',
  );
  const imageArgs = [
    "image",
    "compare",
    "--candidate",
    imageFile,
    "--reference",
    imageFile,
    "--criterion",
    "Clear shape and contrast",
    "--judge",
    "mock",
    "--minimum-votes",
    "1",
    "--maximum-votes",
    "1",
  ];
  const imagePlan = JSON.parse(await run(cli, [...imageArgs, "--dry-run", "--json"], consumer));
  assert.equal(imagePlan.candidate.width, 80);
  const imageOutput = path.join(consumer, "image-review");
  await run(cli, [...imageArgs, "--output", imageOutput], consumer, 2);
  const imageRuns = path.join(imageOutput, ".agent-eval", "runs");
  const imageRun = path.join(imageRuns, fs.readdirSync(imageRuns)[0]!);
  const imageReport = JSON.parse(fs.readFileSync(path.join(imageRun, "report.json"), "utf8"));
  assert.equal(imageReport.overallCoveragePct, 0);
  assert.equal(imageReport.gates.passed, false);
  await run(cli, ["verify", "--run", imageRun], consumer);
  assert.equal(fs.existsSync(path.join(installed, "docs", "image-comparison.md")), true);

  const batchManifest = path.join(consumer, "image-batch.json");
  fs.writeFileSync(
    batchManifest,
    JSON.stringify({
      version: 1,
      defaults: {
        judge: "mock",
        criterion: "Labels are readable",
        voting: { minimumVotes: 1, maximumVotes: 1 },
      },
      comparisons: ["desktop", "mobile"].map((id) => ({
        id,
        candidate: "image.svg",
        reference: "image.svg",
      })),
    }),
  );
  const batchOutput = path.join(consumer, "image-batch-review");
  const batchArgs = ["image", "batch", "--manifest", batchManifest, "--output", batchOutput];
  const batchPlan = JSON.parse(await run(cli, [...batchArgs, "--dry-run", "--json"], consumer));
  assert.equal(batchPlan.comparisons.length, 2);
  await run(cli, batchArgs, consumer, 2);
  const batchReport = JSON.parse(fs.readFileSync(path.join(batchOutput, "report.json"), "utf8"));
  assert.equal(batchReport.completed, 2);
  assert.equal(batchReport.failedOrInconclusive, 2);
  assert.equal(batchReport.accepted, false);
  await run(cli, ["image", "batch", "--resume", batchOutput], consumer, 2);
  const reusedBatch = path.join(consumer, "image-batch-reused");
  await run(
    cli,
    [
      "image",
      "batch",
      "--manifest",
      batchManifest,
      "--reuse",
      batchOutput,
      "--output",
      reusedBatch,
    ],
    consumer,
    2,
  );
  const reusedReport = JSON.parse(fs.readFileSync(path.join(reusedBatch, "report.json"), "utf8"));
  assert.ok(reusedReport.comparisons.every((row: { reusedFrom?: string }) => row.reusedFrom));

  assert.equal(fs.existsSync(path.join(installed, "docs", "configuration.md")), true);
  const campaignHelp = await run(cli, ["campaign", "compare", "--help"], consumer);
  assert.match(campaignHelp, /--fail-on-regression/);
  assert.doesNotMatch(campaignHelp, /--resume/);
  const skillDirectory = path.join(consumer, ".agents", "skills");
  // The authoring workflow must work entirely from the installed package.
  await run(cli, ["author", "install", "--directory", skillDirectory], consumer);
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "references", "plan.md")));
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "references", "maintenance.md")));
  assert.ok(fs.existsSync(path.join(skillDirectory, "aek-author", "templates", "review-note.md")));
  assert.ok(
    fs.existsSync(path.join(skillDirectory, "aek-author", "references", "docs", "authoring.md")),
  );
  await run(cli, ["author", "install", "--directory", skillDirectory], consumer, 1);
  const authorExample = path.join(consumer, "author-example");
  fs.cpSync(path.join(installed, "examples", "authoring"), authorExample, { recursive: true });
  const executionPlan = JSON.parse(
    await run(cli, ["campaign", "--repetitions", "2", "--dry-run", "--json"], authorExample),
  );
  assert.equal(executionPlan.version, 2);
  assert.equal(executionPlan.mode, "campaign");
  assert.equal(executionPlan.repetitions, 2);
  assert.ok(
    executionPlan.areas.some((area: { graders: Array<{ type: string }> }) =>
      area.graders.some((grader) => grader.type === "command"),
    ),
  );
  assert.equal(fs.existsSync(path.join(authorExample, ".agent-eval")), false);
  await run(cli, ["author", "init"], authorExample);
  await run(cli, ["author", "validate", "--require-ready"], authorExample, 2);
  const authorPlanFile = path.join(authorExample, ".aek-authoring", "plan.json");
  fs.copyFileSync(path.join(authorExample, "plan.json"), authorPlanFile);
  await run(cli, ["author", "validate", "--require-ready"], authorExample);
  await run(cli, ["run"], authorExample);
  const authorRuns = path.join(authorExample, ".agent-eval", "runs");
  const goodAuthorRun = fs.readdirSync(authorRuns)[0]!;
  const authorTarget = path.join(authorExample, "cart.mjs");
  const originalAuthorTarget = fs.readFileSync(authorTarget);
  fs.writeFileSync(
    authorTarget,
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  await run(cli, ["run"], authorExample, 2);
  const badAuthorRun = fs.readdirSync(authorRuns).find((id) => id !== goodAuthorRun)!;
  fs.writeFileSync(authorTarget, originalAuthorTarget);
  const authorPlan = JSON.parse(fs.readFileSync(authorPlanFile, "utf8"));
  for (const requirement of authorPlan.requirements)
    requirement.trials = [
      { kind: "good", run: `.agent-eval/runs/${goodAuthorRun}`, rationale: "Known good fixture" },
      {
        kind: "defect",
        run: `.agent-eval/runs/${badAuthorRun}`,
        rationale: "Quantity deliberately ignored",
      },
    ];
  fs.writeFileSync(authorPlanFile, JSON.stringify(authorPlan));
  const authorStatus = JSON.parse(await run(cli, ["author", "status", "--json"], authorExample));
  assert.deepEqual(
    authorStatus.requirements.map((entry: { stage: string }) => entry.stage),
    ["calibrated", "exercised"],
  );
  const authorPilot = path.join(scratch, "one-command-authoring");
  await run(
    process.execPath,
    [path.join(installed, "examples/authoring/run.mjs"), authorPilot],
    consumer,
  );
  const authorPilotSummary = JSON.parse(
    fs.readFileSync(path.join(authorPilot, ".agent-eval/walkthrough/summary.json"), "utf8"),
  );
  assert.equal(authorPilotSummary.results.good.gatesPassed, true);
  assert.equal(authorPilotSummary.results.defect.gatesPassed, false);
  assert.equal(authorPilotSummary.results.restored.score, 100);
  // Exercise text datasets and suite/selection/reference commands from the tarball.
  const textExample = path.join(consumer, "text-example");
  fs.cpSync(path.join(installed, "examples/text-datasets"), textExample, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".agent-eval",
  });
  await run(cli, ["validate", "--suite", "policy"], textExample);
  await run(cli, ["run", "--suite", "policy"], textExample, 2);
  const textRuns = path.join(textExample, ".agent-eval/runs");
  const textRun = path.join(textRuns, fs.readdirSync(textRuns)[0]!);
  await run(cli, ["verify", "--run", textRun], textExample);
  await run(cli, ["run", "--resume", textRun], textExample, 2);
  await run(
    cli,
    [
      "reference",
      "promote",
      "--suite",
      "policy",
      "--run",
      textRun,
      "--name",
      "fixture",
      "--reviewer",
      "package-smoke",
    ],
    textExample,
  );
  await run(cli, ["reference", "list", "--suite", "policy"], textExample);
  await run(cli, ["run", "--suite", "policy", "--changed-since", textRun], textExample, 2);
  // Exercise file collection and the public parser from a production-only install.
  const fileExample = path.join(consumer, "file-example");
  fs.cpSync(path.join(kitRoot, "examples/files"), fileExample, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".agent-eval",
  });
  await run(cli, ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"], fileExample);
  fs.writeFileSync(path.join(fileExample, "records.json"), JSON.stringify([{ id: "wrong" }]));
  await run(cli, ["run", "--fail-under-score", "100"], fileExample, 2);
  // Exercise the installed email export and the actual example collectors with
  // an isolated HTTP mailbox fixture, without contacting a real mail provider.
  const emailExample = path.join(consumer, "email-example");
  fs.cpSync(path.join(kitRoot, "examples/email"), emailExample, { recursive: true });
  const emailMessages: Array<Record<string, unknown>> = [];
  let emailBody = "Hello Priya — DevFlow Conf 2027";
  const emailServer = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/send") {
      emailMessages.push({
        message_id: `message-${emailMessages.length + 1}`,
        inbox_id: "speaker@agentmail.to",
        from: "notifications@app.example.test",
        to: [url.searchParams.get("recipient")],
        subject: url.searchParams.get("subject"),
        created_at: new Date().toISOString(),
        labels: ["received"],
        html: `<p>${emailBody}</p>`,
      });
      response.end("{}");
    } else {
      assert.equal(request.headers.authorization, "Bearer package-mailbox-fixture-key");
      response.end(
        JSON.stringify(
          url.pathname.endsWith("/messages")
            ? { messages: emailMessages }
            : emailMessages.find((message) => url.pathname.endsWith(`/${message.message_id}`)),
        ),
      );
    }
  });
  await new Promise<void>((resolve) => emailServer.listen(0, "127.0.0.1", resolve));
  const emailAddress = emailServer.address();
  assert.ok(emailAddress && typeof emailAddress !== "string");
  const emailUrl = `http://127.0.0.1:${emailAddress.port}`;
  const oldMailboxKey = process.env.AEK_PACKAGE_MAIL_KEY;
  process.env.AEK_PACKAGE_MAIL_KEY = "package-mailbox-fixture-key";
  try {
    const mailbox = JSON.parse(fs.readFileSync(path.join(emailExample, "mailbox.json"), "utf8"));
    mailbox.baseUrl = `${emailUrl}/v0`;
    mailbox.apiKeyEnv = "AEK_PACKAGE_MAIL_KEY";
    fs.writeFileSync(path.join(emailExample, "mailbox.json"), JSON.stringify(mailbox));
    const emailConfig = YAML.parse(
      fs.readFileSync(path.join(emailExample, "evalkit.yaml"), "utf8"),
    );
    emailConfig.target.url = emailUrl;
    emailConfig.agent = { provider: "mock" };
    emailConfig.judge = { provider: "mock" };
    emailConfig.mailboxes.speaker = mailbox;
    fs.writeFileSync(path.join(emailExample, "evalkit.yaml"), YAML.stringify(emailConfig));
    const emailSpecPath = path.join(emailExample, "specs/email.yaml");
    const emailSpec = YAML.parse(fs.readFileSync(emailSpecPath, "utf8"));
    const send = emailSpec.scenarios.find(
      (scenario: { id: string }) => scenario.id === "SEND-MAIL",
    );
    send.kind = "command";
    delete send.persona;
    delete send.requiresAuth;
    send.collect = { command: "node send.mjs", methodFiles: ["send.mjs"] };
    fs.writeFileSync(emailSpecPath, YAML.stringify(emailSpec));
    fs.writeFileSync(
      path.join(emailExample, "send.mjs"),
      `
import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, 'utf8'));
const url = new URL('/send', ${JSON.stringify(emailUrl)});
url.searchParams.set('recipient', c.inputs.recipient.value);
url.searchParams.set('subject', c.inputs.subject.value);
const response = await fetch(url);
if (!response.ok) throw new Error('Fixture send failed');
console.log(JSON.stringify({ version: 1, outcome: 'completed', summary: 'Sent notification', observations: [] }));
`,
    );
    await run(
      cli,
      ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"],
      emailExample,
    );
    emailBody = "Incorrect notification body";
    await run(cli, ["run", "--fail-under-score", "100"], emailExample, 2);
  } finally {
    if (oldMailboxKey === undefined) delete process.env.AEK_PACKAGE_MAIL_KEY;
    else process.env.AEK_PACKAGE_MAIL_KEY = oldMailboxKey;
    await new Promise<void>((resolve) => {
      emailServer.close(() => resolve());
      emailServer.closeAllConnections();
    });
  }
  await run(cli, ["init"], consumer);
  const configFile = path.join(consumer, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.target = { kind: "repository" };
  config.agent = { provider: "mock" };
  config.judge = { provider: "mock" };
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(
    path.join(consumer, "evals/specs/core.yaml"),
    YAML.stringify({
      id: "core",
      title: "Installed package",
      description: "Production dependency smoke",
      weight: 100,
      scenarios: [{ id: "S1", name: "Inspect", instructions: "Inspect the project" }],
      rubric: [
        {
          id: "R1",
          criterion: "Installed CLI runs",
          weight: 1,
          gate: true,
          grader: {
            type: "command",
            methodFiles: [],
            output: "exit-code",
            command: 'node -e "process.exit(0)"',
          },
          passCriteria: "Exit zero",
        },
      ],
    }),
  );
  await run(cli, ["validate"], consumer);
  await run(cli, ["run", "--fail-under-score", "100", "--fail-under-coverage", "100"], consumer);
  const runsRoot = path.join(consumer, ".agent-eval/runs");
  const runDir = path.join(
    runsRoot,
    requireDefined(fs.readdirSync(runsRoot)[0], "fs.readdirSync(runsRoot)[0]"),
  );
  await run(cli, ["verify", "--run", runDir], consumer);
  assert.ok(fs.existsSync(path.join(runDir, "report.html")));

  await run(cli, ["collect", "--split", "all"], consumer);
  const collectionDir = fs
    .readdirSync(runsRoot)
    .map((name) => path.join(runsRoot, name))
    .find((dir) => fs.existsSync(path.join(dir, "collection.json")))!;
  const collectionIndex = fs.readFileSync(path.join(collectionDir, "artifact-index.json"));
  await run(cli, ["judge", "--evidence", collectionDir, "--fail-under-score", "100"], consumer);
  const judgingDir = fs
    .readdirSync(runsRoot)
    .map((name) => path.join(runsRoot, name))
    .find((dir) => {
      const state = JSON.parse(fs.readFileSync(path.join(dir, "run-state.json"), "utf8"));
      return state.mode === "judge";
    })!;
  await run(cli, ["verify", "--run", judgingDir], consumer);
  await run(
    cli,
    [
      "baseline",
      "promote",
      "--config",
      "evalkit.yaml",
      "--run",
      judgingDir,
      "--name",
      "main",
      "--reviewer",
      "package-smoke",
    ],
    consumer,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(collectionDir, "artifact-index.json")),
    collectionIndex,
  );

  // Launch the installed MCP entry point with production dependencies only.
  // Mock evaluations alone would never start an MCP subprocess.
  const evidence = path.join(scratch, "workspace-evidence");
  const contextFile = path.join(scratch, "workspace-context.json");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({ projectRoot: consumer, evidenceDir: evidence, requiredCheckpoints: [] }),
  );
  const client = new Client({ name: "aek-package-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installed, "dist/workspace/mcp.js"), contextFile],
    cwd: consumer,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: "package.json" },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /aek-package-consumer/);
    await client.callTool({
      name: "done",
      arguments: { outcome: "completed", summary: "Installed workspace MCP reads project files." },
    });
  } finally {
    await client.close();
    await transport.close();
  }
  const visualRoot = path.join(consumer, "visual");
  fs.cpSync(path.join(installed, "examples/visual"), visualRoot, { recursive: true });
  // Select a free port, then let AEK launch the packaged example's own server.
  const portProbe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const visualPort = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    portProbe.close((error) => (error ? reject(error) : resolve())),
  );
  const visualConfig = YAML.parse(fs.readFileSync(path.join(visualRoot, "evalkit.yaml"), "utf8"));
  visualConfig.target.url = `http://127.0.0.1:${visualPort}`;
  visualConfig.target.ready.url = visualConfig.target.url;
  visualConfig.target.start = {
    command: visualConfig.target.start,
    env: { AEK_VISUAL_PORT: String(visualPort) },
  };
  fs.writeFileSync(path.join(visualRoot, "evalkit.yaml"), YAML.stringify(visualConfig));
  await run(cli, ["validate"], visualRoot);
  // Mock votes must withhold the visual gate despite passing capture checks.
  await run(cli, ["run"], visualRoot, 2);
  const visualRuns = path.join(visualRoot, ".agent-eval/runs");
  const visualRun = path.join(
    visualRuns,
    requireDefined(fs.readdirSync(visualRuns)[0], "fs.readdirSync(visualRuns)[0]"),
  );
  await run(cli, ["verify", "--run", visualRun], visualRoot);
  const report = JSON.parse(fs.readFileSync(path.join(visualRun, "report.json"), "utf8"));
  assert.equal(report.areas[0].items[0].verdict, "pass");
  assert.equal(report.areas[0].items[1].verdict, "cannot_judge");
  assert.equal(report.areas[0].items[1].votes.judgeable, 0);
  assert.equal(report.areas[0].items[2].source, "image-distinctness");
  assert.equal(report.areas[0].items[2].verdict, "pass");
  const visualStarter = path.join(consumer, "controlled-visual");
  await run(cli, ["init", visualStarter, "--kind", "visual"], consumer);
  await run(cli, ["validate"], visualStarter);
  await run(cli, ["run", "--split", "all"], visualStarter);
  for (const file of [
    "scene.mjs",
    "server.mjs",
    "baseline.yaml",
    "aspirational.yaml",
    "aspirational.svg",
  ])
    assert.ok(fs.statSync(path.join(visualStarter, "evals/visual", file)).isFile());
  console.log(
    "Package smoke passed: tarball install, offline first-run scores/coverage/gates/comparison, installed judge validation and offline report example, direct two-image and batch comparison/resume/reuse, authoring skill/map/calibration, text datasets/suites/selection/reference promotion, file and email collector/checker pass and failure, executable bin, init, validate, run, collect, judge, release promotion, verify, installed MCP, and controlled visual capture/pairwise abstention without dev dependencies.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
