import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs, materializeSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { evaluatePromotion } from "../src/promotion.js";
import { compareReports } from "../src/compare.js";
import { buildReport, scoreArea } from "../src/scoring.js";
import { evaluateCiThresholds } from "../src/ci.js";
import { adjudicateReport } from "../src/report.js";
import { buildRunReceipt } from "../src/receipts.js";
import { verifyArtifactIndex } from "../src/integrity.js";
import { textInstances } from "../src/text/datasets.js";
import { changedTextCases } from "../src/text/selection.js";
import {
  promoteTextReference,
  resolveTextReference,
  loadTextReference,
  listTextReferences,
} from "../src/text/references.js";
import { validateTextRubricResult } from "../src/text/contracts.js";
import { validateEvaluationInputs, evaluatorInputPaths } from "../src/run/inputs.js";
import { judgeCollected } from "../src/judge-run.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-datasets-"));
  const project = path.join(root, "project"),
    bin = path.join(root, "bin");
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const mode = path.join(root, "mode"),
    counter = path.join(root, "counter");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs = require('node:fs'), args=process.argv.slice(2);
if(args.includes('--version')) { console.log('codex dataset fixture 1'); process.exit(0); }
const count = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0)+1;
fs.writeFileSync(${JSON.stringify(counter)}, String(count));
const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, 'utf8') : '';
if(mode === 'interrupt' && count === 2) process.exit(19);
const input = fs.readFileSync(0, 'utf8'), rubric = input.startsWith('TEXT_RUBRIC_EVALUATION:');
const marker = rubric ? 'TEXTS_JSON:\\n' : 'PASSAGES_JSON:\\n';
const texts=JSON.parse(input.slice(input.indexOf(marker)+marker.length));
const citations=Object.entries(texts).map(([text,value])=>({text,quote:value.slice(0,70),explanation:'Fixture citation.'}));
if(mode==='bad') citations[0].quote='A fabricated quotation.';
if(mode==='missing') citations.pop();
const result={...(rubric ? {verdict: Object.values(texts).some(text=>text.includes('FAIL')) ? 'fail' : 'pass'} : {preferred:'equivalent'}),
confidence:mode==='low'?0.1:0.95,reasoning:'Fixture judgment.',citations};
if(mode==='abstain') { if(rubric) result.verdict='cannot_judge'; else result.preferred='abstain'; result.citations=[]; }
if(mode==='tools') console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'ls'}}));
const text=JSON.stringify(result);
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`,
    { mode: 0o755 },
  );
  const configFile = path.join(project, "evalkit.yaml"),
    specFile = path.join(project, "spec.yaml"),
    datasetFile = path.join(project, "posts.json");
  const data = [
    {
      id: "alpha",
      split: "development",
      strata: { surface: "blog" },
      inputs: {
        draft: { text: "Alpha <script>alert('x')</script>" },
        social: { text: "Alpha social" },
        reference: "reference.md",
      },
    },
    {
      id: "beta",
      split: "development",
      strata: { surface: "social" },
      inputs: {
        draft: { text: "Beta FAIL" },
        social: { text: "Beta social" },
        reference: "reference.md",
      },
    },
    {
      id: "reserved",
      split: "evaluation",
      strata: { surface: "blog" },
      inputs: {
        draft: { text: "Reserved" },
        social: { text: "Reserved social" },
        reference: "reference.md",
      },
    },
  ];
  const definition = {
    id: "writing",
    title: "Writing",
    weight: 100,
    description: "Grouped text evaluation",
    datasets: { posts: { file: "posts.json" } },
    templates: {
      voice: {
        criterion: "Which voice is preferable?",
        passCriteria: "No voice regression",
        weight: 1,
        dataset: "posts",
        grader: {
          type: "text-pairwise",
          candidate: "{{inputs.draft}}",
          references: [{ file: "{{inputs.reference}}" }],
          policy: "non_regression",
        },
      },
      quality: {
        criterion: "Are the related texts coherent and faithful to the source?",
        passCriteria: "No contradictions",
        weight: 1,
        dataset: "posts",
        gate: true,
        grader: {
          type: "text-rubric",
          inputs: {
            draft: { file: "{{inputs.draft}}" },
            social: { file: "{{inputs.social}}" },
            source: { file: "{{inputs.reference}}", role: "reference" },
          },
        },
      },
    },
    rubric: [
      { id: "VOICE", template: "voice" },
      { id: "QUALITY", template: "quality" },
    ],
  };
  const configData = {
    version: 1,
    project: { name: "Dataset fixture" },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: { provider: "codex", voting: { minimumVotes: 2, maximumVotes: 3, agreement: 0.8 } },
    paths: { specs: "spec.yaml" },
    scoring: { minimumCoverage: 100 },
  };
  const save = () => {
    fs.writeFileSync(specFile, YAML.stringify(definition));
    fs.writeFileSync(datasetFile, JSON.stringify(data));
  };
  fs.writeFileSync(configFile, YAML.stringify(configData));
  fs.writeFileSync(path.join(project, "reference.md"), "Shared policy and reference voice.");
  save();
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = () => ({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(specFile),
    fixtures: {},
  });
  return {
    root,
    project,
    configFile,
    specFile,
    datasetFile,
    configData,
    data,
    definition,
    save,
    mode,
    counter,
    options,
  };
}

test("datasets bind shared templates, filter splits, retain grouped results and escaped quotation reports", async (t) => {
  const f = fixture(t),
    options = f.options();
  assert.equal(materializeSpecs(options.specs, "evaluation")[0]!.datasets!.posts!.length, 1);
  assert.equal(
    textInstances(options.specs[0]!, options.specs[0]!.rubric[1]!)[0]!.item.grader.type,
    "text-rubric",
  );
  assert.ok(
    evaluatorInputPaths(options.config, options.specs, "development").includes(f.datasetFile),
  );
  const { runDir, report } = await runEvaluation(options);
  assert.equal(report!.overallScorePct, 75);
  assert.equal(report!.overallCoveragePct, 100);
  assert.equal(report!.areas[0]!.items[1]!.verdict, "partial");
  assert.deepEqual(
    report!.areas[0]!.caseResults.map((c) => [c.rubricId, c.caseId, c.verdict]),
    [
      ["VOICE", "alpha", "pass"],
      ["VOICE", "beta", "pass"],
      ["QUALITY", "alpha", "pass"],
      ["QUALITY", "beta", "fail"],
    ],
  );
  assert.equal(
    Number(fs.readFileSync(f.counter, "utf8")),
    8,
    "suite voting defaults reach both direct graders",
  );
  const html = fs.readFileSync(
    path.join(runDir, "areas/writing/text-rubric/QUALITY--alpha/judgment.html"),
    "utf8",
  );
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.equal(verifyArtifactIndex(runDir).ok, true);
  assert.ok(
    !Object.keys(report!.receipt.inputs.textCandidates!).some((key) => key.includes("reserved")),
  );
  fs.rmSync(f.datasetFile);
  const sealed = loadSpecs(path.join(runDir, "inputs/specs"));
  assert.equal(sealed[0]!.datasets!.posts!.length, 3, "snapshot embeds the shared manifest");
  const receipt = buildRunReceipt({
    ...options,
    specs: sealed,
    split: "development",
    evidenceProvenance: report!.receipt,
  });
  assert.deepEqual(receipt.inputs.textCandidates, report!.receipt.inputs.textCandidates);
});

test("changed-case selection uses case inputs, shared references and judging method; skipped cases reduce coverage", async (t) => {
  const f = fixture(t);
  const first = await runEvaluation(f.options());
  assert.deepEqual(
    changedTextCases(first.runDir, buildRunReceipt({ ...f.options(), split: "development" })),
    [],
  );
  const attempted = fs.readFileSync(f.counter, "utf8");
  const empty = await runEvaluation({ ...f.options(), textCaseIds: [] });
  assert.equal(fs.readFileSync(f.counter, "utf8"), attempted);
  assert.equal(empty.report!.overallCoveragePct, 0);
  f.data[0]!.inputs.draft.text += " Revised.";
  f.save();
  const options = f.options(),
    current = buildRunReceipt({ ...options, split: "development" });
  assert.equal(
    current.evaluationFingerprint,
    first.report!.receipt.evaluationFingerprint,
    "inline candidates do not change evaluator identity",
  );
  assert.notEqual(current.inputFingerprint, first.report!.receipt.inputFingerprint);
  assert.deepEqual(changedTextCases(first.runDir, current), ["writing/posts/alpha"]);
  const count = Number(fs.readFileSync(f.counter, "utf8"));
  const subset = await runEvaluation({ ...options, textCaseIds: ["writing/posts/alpha"] });
  assert.equal(Number(fs.readFileSync(f.counter, "utf8")) - count, 4);
  assert.equal(subset.report!.overallCoveragePct, 50);
  assert.equal(subset.report!.scoreWithheld, true);
  assert.equal(subset.report!.gates.passed, false);
  assert.equal(
    subset.report!.areas[0]!.caseResults.filter((c) => c.verdict === "cannot_judge").length,
    2,
  );
  assert.deepEqual(changedTextCases(subset.runDir, current), ["writing/posts/beta"]);
  fs.appendFileSync(path.join(f.project, "reference.md"), " New shared policy.");
  assert.deepEqual(
    changedTextCases(first.runDir, buildRunReceipt({ ...f.options(), split: "development" })),
    ["writing/posts/alpha", "writing/posts/beta"],
  );
  const changedJudge = f.options();
  changedJudge.config.judge.model = "another-model";
  assert.deepEqual(
    changedTextCases(first.runDir, buildRunReceipt({ ...changedJudge, split: "development" })),
    ["writing/posts/alpha", "writing/posts/beta"],
  );
});

test("direct rubric citation errors fail even at low confidence; abstention remains unavailable", async (t) => {
  const texts = { draft: "Literal draft", source: "Literal source" };
  const valid = {
    verdict: "pass",
    confidence: 0.1,
    reasoning: "Evidence",
    citations: [
      { text: "draft", quote: "Literal", explanation: "Source" },
      { text: "source", quote: "source", explanation: "Source" },
    ],
  };
  assert.equal(validateTextRubricResult(valid, texts).verdict, "pass");
  assert.throws(
    () => validateTextRubricResult({ ...valid, citations: valid.citations.slice(0, 1) }, texts),
    /must cite source/,
  );
  assert.throws(
    () =>
      validateTextRubricResult(
        { ...valid, citations: [{ text: "draft", quote: "Invented", explanation: "Source" }] },
        texts,
      ),
    /does not quote/,
  );
  const f = fixture(t);
  f.definition.rubric = [f.definition.rubric[1]!];
  f.save();
  fs.writeFileSync(f.mode, "bad");
  await assert.rejects(runEvaluation(f.options()), /does not quote/);
  fs.writeFileSync(f.mode, "low");
  const low = await runEvaluation(f.options());
  assert.equal(low.report!.overallCoveragePct, 0);
  assert.equal(low.report!.overallScorePct, null);
  const mock = f.options();
  mock.config.judge.provider = "mock";
  const result = await runEvaluation(mock);
  assert.equal(result.report!.areas[0]!.items[0]!.verdict, "cannot_judge");
});

test("dataset validation rejects bad bindings, collisions, unknown templates and malformed manifests before execution", async (t) => {
  const f = fixture(t);
  f.definition.templates.voice.grader.candidate = "{{inputs.unknown}}";
  f.save();
  assert.throws(f.options, /missing input unknown/);
  f.definition.templates.voice.grader.candidate = "{{inputs.draft}}";
  f.data[1]!.id = "ALPHA";
  f.save();
  assert.throws(f.options, /collision|colliding/);
  f.data[1]!.id = "beta";
  f.definition.rubric[0]!.template = "absent";
  f.save();
  assert.throws(f.options, /Unknown rubric template/);
  f.definition.rubric[0]!.template = "voice";
  f.save();
  fs.writeFileSync(f.datasetFile, "{}");
  assert.throws(f.options, /array of cases/);
  f.save();
  f.data[0]!.inputs.draft.text = "\u0000";
  f.save();
  await assert.rejects(
    validateEvaluationInputs(f.options().config, f.options().specs),
    /Inline text/,
  );
  assert.equal(fs.existsSync(path.join(f.project, ".agent-eval/runs")), false);
});

test("named suites resolve shallow defaults and reject unknown or recursive configuration", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.configFile,
    YAML.stringify({
      ...f.configData,
      suites: {
        voice: { instructions: "Voice only", judge: { model: "voice-model" } },
        quality: { instructions: "Quality only", scoring: { minimumCoverage: 90 } },
      },
    }),
  );
  assert.throws(() => loadConfig(f.configFile), /Select a named suite/);
  const voice = loadConfig(f.configFile, { suite: "voice" });
  assert.equal(voice.suite, "voice");
  assert.equal(voice.judge.model, "voice-model");
  assert.equal(voice.judge.voting!.minimumVotes, 2);
  assert.equal(loadConfig(f.configFile, { suite: "quality" }).scoring.minimumCoverage, 90);
  assert.throws(() => loadConfig(f.configFile, { suite: "missing" }), /Known suites/);
});

test("promoted text references preserve sealed bytes, pin historical snapshots, and fail on corruption", async (t) => {
  const f = fixture(t),
    options = f.options();
  const first = await runEvaluation(options);
  const promoted = promoteTextReference({
    config: options.config,
    runDir: first.runDir,
    name: "editorial",
    reviewer: "fixture",
  });
  const source = { reference: "editorial", key: "VOICE--alpha", snapshot: promoted.snapshot };
  assert.match(fs.readFileSync(resolveTextReference(options.config, source), "utf8"), /Alpha/);
  f.data[0]!.inputs.draft.text = "New candidate";
  f.save();
  const second = await runEvaluation(f.options());
  const newer = promoteTextReference({
    config: options.config,
    runDir: second.runDir,
    name: "editorial",
    reviewer: "fixture",
  });
  assert.notEqual(newer.snapshot, promoted.snapshot);
  assert.match(fs.readFileSync(resolveTextReference(options.config, source), "utf8"), /Alpha/);
  assert.equal(
    fs.readFileSync(
      resolveTextReference(options.config, { ...source, snapshot: newer.snapshot }),
      "utf8",
    ),
    "New candidate",
  );
  assert.equal(loadTextReference(options.config, "editorial").snapshot, newer.snapshot);
  assert.throws(
    () => resolveTextReference(options.config, { ...source, key: "missing" }),
    /Unknown text reference key/,
  );
  fs.appendFileSync(resolveTextReference(options.config, source), "tamper");
  assert.throws(() => resolveTextReference(options.config, source), /checksum changed/);
});

test("dataset votes resume without repeating completed votes or changing the recorded subset", async (t) => {
  const f = fixture(t);
  f.definition.rubric = [f.definition.rubric[1]!];
  f.save();
  fs.writeFileSync(f.mode, "interrupt");
  const options = { ...f.options(), textCaseIds: ["writing/posts/alpha"] };
  await assert.rejects(runEvaluation(options), /execution failed/);
  const runDir = path.join(
    options.config.paths.runs,
    fs.readdirSync(options.config.paths.runs)[0]!,
  );
  fs.writeFileSync(f.mode, "");
  const resumed = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(Number(fs.readFileSync(f.counter, "utf8")), 3);
  assert.equal(resumed.report!.overallCoveragePct, 50);
  assert.equal(verifyArtifactIndex(runDir).ok, true);
  await assert.rejects(
    runEvaluation({ ...options, textCaseIds: ["writing/posts/beta"], resumeDir: runDir }),
    /changed since this run began/,
  );
});

test("dataset collect/judge and CLI rescore work from embedded definitions without source manifests", async (t) => {
  const f = fixture(t),
    options = f.options();
  const collection = await runEvaluation({ ...options, collectOnly: true });
  const collectedConfig = loadConfig(f.configFile);
  const judged = await judgeCollected({
    config: collectedConfig,
    configFile: f.configFile,
    specs: options.specs,
    fixtures: {},
    evidenceDir: collection.runDir,
    explicitConfig: true,
  });
  assert.equal(judged.report.areas[0]!.caseResults.length, 4);
  fs.rmSync(f.datasetFile);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rescore", "--run", judged.runDir],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  assert.ok([0, 2].includes(result.status!), result.stderr);
});

test("standalone text rubric supports inline inputs and explicit grader voting overrides", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.specFile,
    YAML.stringify({
      id: "writing",
      title: "Standalone text",
      description: "No dataset or scenario",
      weight: 100,
      rubric: [
        {
          id: "DIRECT",
          criterion: "Does the draft preserve the supplied record?",
          passCriteria: "No unsupported claims",
          weight: 1,
          grader: {
            type: "text-rubric",
            inputs: {
              draft: { file: { text: "A standalone draft." } },
              source: { file: "reference.md", role: "reference" },
            },
            voting: { minimumVotes: 1, maximumVotes: 1, agreement: 1 },
          },
        },
      ],
    }),
  );
  const result = await runEvaluation(f.options());
  assert.equal(result.report!.overallScorePct, 100);
  assert.equal(result.report!.areas[0]!.items[0]!.votes!.attempted, 1);
  assert.deepEqual(result.report!.areas[0]!.caseResults, []);
});

test("setup cannot mutate an inline candidate in a dataset manifest after collection", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.project, "mutate.mjs"),
    `import fs from 'node:fs'; const cases = JSON.parse(fs.readFileSync('posts.json', 'utf8')); cases[0].inputs.draft.text = 'Changed during setup'; fs.writeFileSync('posts.json', JSON.stringify(cases));`,
  );
  const options = f.options();
  options.config.target.setup = { command: "node mutate.mjs", cwd: f.project };
  await assert.rejects(runEvaluation(options), /changed evaluator specs or dataset manifests/);
  assert.equal(fs.existsSync(f.counter), false);
});

test("named references resolve through dataset bindings and reject storage escapes before writing", async (t) => {
  const f = fixture(t),
    options = f.options();
  const run = await runEvaluation(options);
  const saved = promoteTextReference({
    config: options.config,
    runDir: run.runDir,
    name: "selected",
    reviewer: "fixture",
  });
  const data = JSON.parse(fs.readFileSync(f.datasetFile, "utf8"));
  data[0].inputs.reference = {
    reference: "selected",
    key: "VOICE--alpha",
    snapshot: saved.snapshot,
  };
  fs.writeFileSync(f.datasetFile, JSON.stringify(data));
  const current = buildRunReceipt({ ...f.options(), split: "development" });
  assert.equal(
    current.inputs.textReferences!["VOICE--alpha/0"]!.sha256,
    run.report!.receipt.inputs.textCandidates!["VOICE--alpha"]!.sha256,
  );
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.project, "reference-link"));
  options.config.paths.references = path.join(f.project, "reference-link", "new");
  assert.throws(
    () =>
      promoteTextReference({
        config: options.config,
        runDir: run.runDir,
        name: "escape",
        reviewer: "fixture",
      }),
    /within project.root/,
  );
  assert.equal(fs.existsSync(path.join(outside, "new")), false);
});

test("changed dataset manifests cannot be snapshotted against stale loaded definitions", async (t) => {
  const f = fixture(t),
    options = f.options();
  f.data[0]!.inputs.draft.text = "Changed before run";
  f.save();
  await assert.rejects(runEvaluation(options), /changed after loading; reload specs/);
  assert.equal(fs.existsSync(options.config.paths.runs), false);
});

function datasetCli(configFile: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args, "--config", configFile],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    },
  );
}

test("rescore rejects changed dataset text and metadata without rewriting retained judgments", async (t) => {
  const f = fixture(t);
  const original = await runEvaluation(f.options());
  const reportFile = path.join(original.runDir, "report.json");
  const reportBytes = fs.readFileSync(reportFile);
  const cases = JSON.parse(fs.readFileSync(f.datasetFile, "utf8"));
  for (const edit of [
    (data: typeof cases) => {
      data[0].inputs.reference = { text: "A new policy that was never judged" };
    },
    (data: typeof cases) => {
      data[0].inputs.draft.text = "A different candidate";
    },
    (data: typeof cases) => {
      data[0].strata = { surface: "changed" };
    },
  ]) {
    const changed = structuredClone(cases);
    edit(changed);
    fs.writeFileSync(f.datasetFile, JSON.stringify(changed));
    const result = datasetCli(f.configFile, ["rescore", "--run", original.runDir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /judgement-relevant fields/);
    assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
  }
  fs.writeFileSync(f.datasetFile, JSON.stringify(cases));
  const raw = YAML.parse(fs.readFileSync(f.specFile, "utf8"));
  raw.rubric[0].weight = 3;
  fs.writeFileSync(f.specFile, YAML.stringify(raw));
  const reweighted = datasetCli(f.configFile, ["rescore", "--run", original.runDir]);
  assert.equal(reweighted.status, 2, reweighted.stdout + reweighted.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportFile, "utf8")).overallScorePct, 87.5);
});

test("strata use the same per-case dataset weights as the headline score", async (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.specFile, "utf8"));
  raw.datasets = {
    one: [{ id: "one", strata: ["shared"], inputs: { draft: { text: "FAIL" } } }],
    many: Array.from({ length: 3 }, (_, i) => ({
      id: `case${i}`,
      strata: ["shared"],
      inputs: { draft: { text: "Pass" } },
    })),
  };
  delete raw.templates;
  raw.rubric = ["one", "many"].map((dataset) => ({
    id: dataset,
    dataset,
    weight: 1,
    criterion: "Check the text",
    passCriteria: "Pass the check",
    grader: {
      type: "text-rubric",
      inputs: { draft: { file: "{{inputs.draft}}" } },
      voting: { minimumVotes: 1, maximumVotes: 1 },
    },
  }));
  fs.writeFileSync(f.specFile, YAML.stringify(raw));
  const result = await runEvaluation(f.options());
  assert.equal(result.report!.overallScorePct, 50);
  assert.equal(result.report!.byStratum.shared!.scorePct, 50);
  assert.ok(Math.abs(result.report!.areas[0]!.byStratum.shared!.total - 2) < 1e-12);
});

test("inactive dataset areas do not execute unrelated collection scenarios", (t) => {
  const f = fixture(t);
  const active = f.options().specs[0]!;
  const inactive = {
    ...structuredClone(active),
    id: "reserved-area",
    rubric: [{ ...active.rubric[0]!, id: "RESERVED" }],
    datasets: { posts: active.datasets!.posts!.filter((c) => c.split === "evaluation") },
    scenarios: [
      {
        id: "UNUSED",
        name: "Unused",
        instructions: "Must not execute",
        successSignals: [],
        dependsOn: [],
        requiresAuth: false,
      },
    ],
  };
  const planned = materializeSpecs([active, inactive], "development");
  assert.deepEqual(
    planned.map((spec) => spec.id),
    [active.id],
  );
});

test("suite selection works for detached judging and named-baseline commands", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.configFile,
    YAML.stringify({ ...f.configData, suites: { policy: { instructions: "Evaluate policy" } } }),
  );
  const config = loadConfig(f.configFile, { suite: "policy" });
  const options = {
    config,
    configFile: f.configFile,
    configOverrides: { suite: "policy" },
    specs: loadSpecs(f.specFile),
    fixtures: {},
  };
  const collection = await runEvaluation({ ...options, collectOnly: true });
  const judged = datasetCli(f.configFile, [
    "judge",
    "--suite",
    "policy",
    "--evidence",
    collection.runDir,
  ]);
  assert.equal(judged.status, 2, judged.stdout + judged.stderr);
  const runDir = judged.stdout.match(/Artifacts: (.+)/)![1]!;
  const promoted = datasetCli(f.configFile, [
    "baseline",
    "promote",
    "--suite",
    "policy",
    "--run",
    runDir,
    "--name",
    "review",
    "--reviewer",
    "fixture",
    "--mode",
    "milestone",
    "--reason",
    "Fixture",
  ]);
  assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
  const listed = datasetCli(f.configFile, ["baseline", "list", "--suite", "policy"]);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /review/);
  const compared = datasetCli(f.configFile, [
    "compare",
    "--suite",
    "policy",
    "--baseline-name",
    "review",
    "--candidate",
    runDir,
  ]);
  assert.equal(compared.status, 0, compared.stdout + compared.stderr);
  const inherited = datasetCli(f.configFile, [
    "compare",
    "--baseline-name",
    "review",
    "--candidate",
    runDir,
  ]);
  assert.equal(inherited.status, 0, inherited.stdout + inherited.stderr);
  const wrongSuite = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "rescore", "--run", runDir, "--suite", "wrong"],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  assert.equal(wrongSuite.status, 1, wrongSuite.stdout + wrongSuite.stderr);
  assert.match(wrongSuite.stderr, /does not match the sealed run/);
});

test("suite defaults reject malformed sections and resolve environment selection", (t) => {
  const f = fixture(t);
  for (const invalid of [null, [], 42]) {
    fs.writeFileSync(
      f.configFile,
      YAML.stringify({
        ...f.configData,
        judge: invalid,
        suites: { policy: { judge: { model: "fixture" } } },
      }),
    );
    assert.throws(() => loadConfig(f.configFile, { suite: "policy" }), /Invalid .*evalkit.yaml/);
  }
  fs.writeFileSync(f.configFile, "");
  assert.throws(() => loadConfig(f.configFile), /Invalid .*evalkit.yaml/);
  const variable = "AEK_DATASET_TEST_SUITE";
  const original = process.env[variable];
  process.env[variable] = "policy";
  t.after(() => {
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
  });
  fs.writeFileSync(
    f.configFile,
    YAML.stringify({
      ...f.configData,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Config interpolation is performed by loadConfig.
      suite: "${AEK_DATASET_TEST_SUITE}",
      suites: { policy: { instructions: "Evaluate policy" } },
    }),
  );
  assert.equal(loadConfig(f.configFile).suite, "policy");
});

test("release promotion rejects missing or incomplete text case fingerprints", async (t) => {
  const f = fixture(t),
    options = f.options();
  options.config.promotion = { minimumCoverage: 0, split: "development", includeOptional: false };
  const result = await runEvaluation({ ...options, textCaseIds: ["writing/posts/alpha"] });
  const report = result.report!;
  assert.ok(
    evaluatePromotion(options.config, report, "release").failures.some((failure) =>
      failure.includes("selection is incomplete"),
    ),
  );
  options.config.promotion.split = "all";
  assert.ok(
    evaluatePromotion(options.config, report, "release").failures.some((failure) =>
      failure.includes("does not match promotion split"),
    ),
  );
  options.config.promotion.split = "development";
  for (const fingerprints of [
    undefined,
    {},
    { "writing/posts/alpha": report.receipt.inputs.textCases!["writing/posts/alpha"]! },
  ]) {
    const invalid = structuredClone(report);
    Reflect.set(invalid.receipt.inputs, "textCases", fingerprints);
    assert.throws(
      () => evaluatePromotion(options.config, invalid, "release"),
      /requires complete case fingerprints/,
    );
  }
});

test("text reference operations require the resolved storage path", (t) => {
  const f = fixture(t),
    config = f.options().config;
  Reflect.deleteProperty(config.paths, "references");
  assert.throws(() => listTextReferences(config), /missing paths.references/);
  assert.equal(fs.existsSync(path.join(f.project, "evals")), false);
});

test("reference promotion distinguishes existing locks from filesystem failures", async (t) => {
  const f = fixture(t),
    options = f.options();
  const result = await runEvaluation(options);
  const root = path.join(options.config.paths.references, "locked");
  const lock = path.join(root, ".promote.lock");
  fs.mkdirSync(lock, { recursive: true });
  const promote = () =>
    promoteTextReference({
      config: options.config,
      runDir: result.runDir,
      name: "locked",
      reviewer: "fixture",
    });
  assert.throws(promote, /promotion is locked/);
  fs.rmdirSync(lock);
  const mkdir = fs.mkdirSync;
  for (const code of ["EACCES", "ENOSPC", "EIO"]) {
    const failure = Object.assign(new Error(`Fixture filesystem failure: ${code}`), { code });
    const intercepted = t.mock.method(
      fs,
      "mkdirSync",
      (...args: Parameters<typeof fs.mkdirSync>) => {
        if (args[0] === lock) throw failure;
        return mkdir(...args);
      },
    );
    assert.throws(promote, (error) => error === failure);
    intercepted.mock.restore();
    assert.equal(fs.existsSync(path.join(root, "current.json")), false);
  }
});

test("normalized spec methods ignore YAML presentation while retaining source provenance", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "draft.md"), "Candidate text.");
  for (const grader of [
    { type: "manual" },
    {
      type: "text-pairwise",
      candidate: "draft.md",
      references: [{ file: "reference.md" }],
      policy: "non_regression",
    },
    {
      type: "text-rubric",
      inputs: {
        draft: { file: { text: "Candidate text." } },
        source: { file: "reference.md", role: "reference" },
      },
    },
  ]) {
    const definition = {
      id: "writing",
      title: "Writing",
      description: "Check writing",
      weight: 100,
      rubric: [
        {
          id: "CHECK",
          criterion: "Preserves the source",
          passCriteria: "Faithful",
          weight: 1,
          ...(grader.type === "manual"
            ? { manualInstructions: "Read the draft and record a judgment" }
            : {}),
          grader,
        },
      ],
    };
    fs.writeFileSync(f.specFile, YAML.stringify(definition));
    const first = buildRunReceipt(f.options());
    fs.writeFileSync(
      f.specFile,
      `# Presentation only\n${YAML.stringify({ ...definition, optional: false, scenarios: [] }, { indent: 4 })}`,
    );
    const formatted = buildRunReceipt(f.options());
    assert.deepEqual(formatted.inputs.specMethods, first.inputs.specMethods);
    assert.equal(formatted.evaluationFingerprint, first.evaluationFingerprint);
    assert.notEqual(formatted.inputs.specs.writing!.sha256, first.inputs.specs.writing!.sha256);
    assert.notEqual(formatted.inputFingerprint, first.inputFingerprint);
    for (const edit of [
      { criterion: "A changed criterion" },
      { passCriteria: "A changed standard" },
      { weight: 2 },
      { tags: ["changed"] },
    ]) {
      fs.writeFileSync(
        f.specFile,
        YAML.stringify({ ...definition, rubric: [{ ...definition.rubric[0], ...edit }] }),
      );
      const changed = buildRunReceipt(f.options());
      assert.notEqual(changed.inputs.specMethods.writing, first.inputs.specMethods.writing);
      assert.notEqual(changed.evaluationFingerprint, first.evaluationFingerprint);
    }
  }
});

test("standalone candidate source representations share evaluator identity while references do not", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "draft.md"), "Candidate text.");
  const definition = {
    id: "writing",
    title: "Writing",
    description: "Check writing",
    weight: 100,
    rubric: [
      {
        id: "CHECK",
        criterion: "Preserves the source",
        passCriteria: "Faithful",
        weight: 1,
        grader: {
          type: "text-pairwise",
          candidate: "draft.md",
          references: [{ file: { text: "Reference text." } }],
          policy: "non_regression",
        },
      },
    ],
  };
  const receipt = (candidate: string | { text: string }, reference = "Reference text.") => {
    const item = definition.rubric[0]!;
    fs.writeFileSync(
      f.specFile,
      YAML.stringify({
        ...definition,
        rubric: [
          {
            ...item,
            grader: { ...item.grader, candidate, references: [{ file: { text: reference } }] },
          },
        ],
      }),
    );
    return buildRunReceipt(f.options());
  };
  const file = receipt("draft.md"),
    inline = receipt({ text: "Candidate text." }),
    changed = receipt({ text: "Changed candidate." });
  assert.equal(file.evaluationFingerprint, inline.evaluationFingerprint);
  assert.equal(file.evaluationFingerprint, changed.evaluationFingerprint);
  assert.deepEqual(file.inputs.textCandidates, inline.inputs.textCandidates);
  assert.notDeepEqual(inline.inputs.textCandidates, changed.inputs.textCandidates);
  assert.notEqual(file.inputFingerprint, inline.inputFingerprint);
  assert.notEqual(inline.inputFingerprint, changed.inputFingerprint);
  const reference = receipt({ text: "Changed candidate." }, "Changed reference.");
  assert.notEqual(reference.inputs.specMethods.writing, changed.inputs.specMethods.writing);
  assert.notEqual(reference.evaluationFingerprint, changed.evaluationFingerprint);
});

test("failed reference pointer publication preserves the previous snapshot and releases the lock", async (t) => {
  const f = fixture(t),
    options = f.options();
  const run = await runEvaluation(options);
  const promote = (reviewer: string) =>
    promoteTextReference({ config: options.config, runDir: run.runDir, name: "atomic", reviewer });
  const original = promote("original");
  const root = path.dirname(original.directory),
    current = path.join(root, "current.json");
  const previous = fs.readFileSync(current),
    rename = fs.renameSync;
  const failure = Object.assign(new Error("Fixture pointer publication failure"), { code: "EIO" });
  const intercepted = t.mock.method(
    fs,
    "renameSync",
    (...args: Parameters<typeof fs.renameSync>) => {
      if (args[1] === current) throw failure;
      return rename(...args);
    },
  );
  assert.throws(
    () => promote("interrupted"),
    (error) => error === failure,
  );
  intercepted.mock.restore();
  assert.deepEqual(fs.readFileSync(current), previous);
  assert.equal(loadTextReference(options.config, "atomic").snapshot, original.snapshot);
  assert.equal(fs.existsSync(path.join(root, ".promote.lock")), false);
  assert.ok(
    !fs.readdirSync(root).some((name) => name.startsWith(".stage-") || name.includes(".tmp-")),
  );
  const recovered = promote("recovered");
  assert.equal(loadTextReference(options.config, "atomic").snapshot, recovered.snapshot);
});

test("evaluator identity preserves dataset rubric grouping and its scoring weights", async (t) => {
  const f = fixture(t);
  const definition = {
    id: "writing",
    title: "Writing",
    description: "Grouped scoring",
    weight: 100,
    datasets: {
      posts: [
        { id: "alpha", inputs: { draft: { text: "Pass" } } },
        { id: "beta", inputs: { draft: { text: "FAIL" } } },
      ],
    },
    rubric: [
      {
        id: "QUALITY",
        dataset: "posts",
        criterion: "Clear",
        passCriteria: "Clear",
        weight: 1,
        grader: { type: "text-rubric", inputs: { draft: { file: "{{inputs.draft}}" } } },
      },
      {
        id: "OTHER",
        criterion: "Other",
        passCriteria: "Other",
        weight: 1,
        grader: { type: "text-rubric", inputs: { draft: { file: { text: "Pass" } } } },
      },
    ],
  };
  fs.writeFileSync(f.specFile, YAML.stringify(definition));
  const options = f.options();
  const grouped = await runEvaluation(options);
  const spec = options.specs[0]!;
  fs.writeFileSync(
    f.specFile,
    YAML.stringify({
      ...definition,
      rubric: spec.rubric.flatMap((item) =>
        textInstances(spec, item).map((instance) => instance.item),
      ),
    }),
  );
  const standalone = await runEvaluation(f.options());
  assert.equal(grouped.report!.overallScorePct, 75);
  assert.equal(standalone.report!.overallScorePct, 66.667);
  assert.notEqual(
    grouped.report!.receipt.evaluationFingerprint,
    standalone.report!.receipt.evaluationFingerprint,
  );
  assert.equal(
    compareReports(grouped.report!, standalone.report!).compatibility.status,
    "incompatible",
  );
});

test("text-case selections are canonical in receipts, saved state, and resume", async (t) => {
  const f = fixture(t),
    options = f.options();
  const canonical = ["writing/posts/alpha", "writing/posts/beta"];
  const reordered = [canonical[1]!, canonical[0]!, canonical[1]!];
  const first = buildRunReceipt({ ...options, split: "development", textCaseIds: canonical });
  const second = buildRunReceipt({ ...options, split: "development", textCaseIds: reordered });
  assert.deepEqual(second.inputs.selection.textCases, canonical);
  assert.equal(second.evaluationFingerprint, first.evaluationFingerprint);
  assert.equal(second.inputFingerprint, first.inputFingerprint);
  const run = await runEvaluation({ ...options, textCaseIds: reordered });
  const state = JSON.parse(fs.readFileSync(path.join(run.runDir, "run-state.json"), "utf8"));
  assert.deepEqual(state.selectedTextCases, canonical);
  const votes = fs.readFileSync(f.counter, "utf8");
  const resumed = await runEvaluation({
    ...options,
    textCaseIds: canonical,
    resumeDir: run.runDir,
  });
  assert.equal(resumed.report!.receipt.inputFingerprint, run.report!.receipt.inputFingerprint);
  assert.equal(fs.readFileSync(f.counter, "utf8"), votes);
});

test("fully judged large datasets meet exact coverage and score thresholds", (t) => {
  const f = fixture(t);
  const raw = YAML.parse(fs.readFileSync(f.specFile, "utf8"));
  raw.rubric = [{ ...raw.templates.quality, id: "QUALITY", gate: false }];
  delete raw.templates;
  raw.datasets = {
    posts: Array.from({ length: 154 }, (_, index) => ({
      ...structuredClone(f.data[0]),
      id: `case${index}`,
    })),
  };
  fs.writeFileSync(f.specFile, YAML.stringify(raw));
  const options = f.options();
  options.config.scoring.minimumCoverage = 100;
  options.config.scoring.partialCredit = 0.3;
  const spec = materializeSpecs(options.specs, "development")[0]!;
  const receipt = buildRunReceipt({ ...options, split: "development" });
  for (const verdict of ["pass", "partial"] as const) {
    const judgement = {
      id: "QUALITY",
      source: "text-rubric" as const,
      verdict,
      confidence: "high" as const,
      reasoning: "Observed",
      evidenceRefs: [],
    };
    const cases = spec.datasets!.posts!.map((entry) => ({
      ...judgement,
      areaId: spec.id,
      rubricId: "QUALITY",
      caseId: entry.id,
      strata: [],
      scenarioIds: [],
    }));
    const area = scoreArea({
      spec,
      config: options.config,
      judgements: [judgement],
      evidence: [],
      caseResults: cases,
    });
    const report = buildReport({
      runId: "precision",
      startedAt: "2026-01-01T00:00:00Z",
      config: options.config,
      areas: [area],
      receipt,
    });
    assert.equal(area.judgeable, area.total);
    assert.equal(report.scoreWithheld, false);
    assert.deepEqual(
      evaluateCiThresholds(report, {
        minimumCoverage: 100,
        minimumScore: verdict === "pass" ? 100 : 30,
      }),
      [],
    );
    const incomplete = scoreArea({
      spec,
      config: options.config,
      judgements: [{ ...judgement, verdict: "cannot_judge" }],
      evidence: [],
      caseResults: cases.map((entry, index) =>
        index === 0 ? { ...entry, verdict: "cannot_judge" } : entry,
      ),
    });
    const withheld = buildReport({
      runId: "incomplete",
      startedAt: report.startedAt,
      config: options.config,
      areas: [incomplete],
      receipt,
    });
    assert.equal(withheld.scoreWithheld, true);
    assert.ok(
      evaluateCiThresholds(withheld, { minimumCoverage: 100 }).some((failure) =>
        failure.startsWith("coverage"),
      ),
    );
  }
});

test("withdrawing dataset adjudication restores the original automatic coverage", async (t) => {
  const f = fixture(t),
    options = f.options();
  const run = await runEvaluation({ ...options, textCaseIds: ["writing/posts/alpha"] });
  const original = run.report!;
  assert.equal(original.overallCoveragePct, 50);
  fs.writeFileSync(
    path.join(f.project, "review.txt"),
    "Human assessment of the complete criterion.",
  );
  const inputFile = path.join(f.project, "decisions.json");
  const decision = {
    areaId: "writing",
    itemId: "QUALITY",
    previousRevision: null as string | null,
    verdict: "pass",
    rationale: "Complete criterion reviewed",
    evidence: [
      {
        kind: "human",
        path: "review.txt",
        description: "Review",
        observedAt: "2026-09-06T00:00:00Z",
      },
    ],
  };
  fs.writeFileSync(inputFile, JSON.stringify({ schemaVersion: 1, decisions: [decision] }));
  const reviewOptions = {
    config: options.config,
    specs: materializeSpecs(options.specs, "development"),
    runDir: run.runDir,
    inputFile,
    reviewer: "fixture",
  };
  const resolved = adjudicateReport({ ...reviewOptions, report: original });
  assert.equal(resolved.overallCoveragePct, 75);
  decision.previousRevision = resolved.areas[0]!.items.find((item) => item.id === "QUALITY")!
    .adjudication!.revisionHash;
  decision.verdict = "cannot_judge";
  decision.rationale = "Withdraw the human assessment";
  decision.evidence = [];
  fs.writeFileSync(inputFile, JSON.stringify({ schemaVersion: 1, decisions: [decision] }));
  const withdrawn = adjudicateReport({ ...reviewOptions, report: resolved });
  assert.equal(withdrawn.overallCoveragePct, original.overallCoveragePct);
  assert.equal(withdrawn.overallScorePct, original.overallScorePct);
  assert.deepEqual(
    withdrawn.areas[0]!.items.find((item) => item.id === "QUALITY")!.score,
    original.areas[0]!.items.find((item) => item.id === "QUALITY")!.score,
  );
  assert.deepEqual(withdrawn.areas[0]!.caseResults, original.areas[0]!.caseResults);
  assert.equal(verifyArtifactIndex(run.runDir).ok, true);
});
