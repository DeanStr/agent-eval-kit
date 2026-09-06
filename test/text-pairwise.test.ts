import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { buildRunReceipt } from "../src/receipts.js";
import { verifyArtifactIndex } from "../src/integrity.js";
import { compareReports, loadComparisonInput } from "../src/compare.js";
import {
  MAX_TEXT_BYTES,
  textPairwiseSchema,
  validateTextPairResult,
} from "../src/text/contracts.js";
import {
  readText,
  readTextSnapshot,
  snapshotTextInputs,
  textInputPath,
  textInputs,
} from "../src/text/inputs.js";
import { textPairPrompt } from "../src/text/pairwise.js";
import { pairOutcome, decideVotes, pairwiseVoteVerdict } from "../src/visual/votes.js";

function fixture(t: TestContext, provider = "mock") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-text-"));
  const project = path.join(root, "project"),
    bin = path.join(root, "bin");
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const counter = path.join(root, "counter"),
    mode = path.join(root, "mode");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex text fixture 1');process.exit(0)}
const count=Number(fs.existsSync(${JSON.stringify(counter)})?fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;
fs.writeFileSync(${JSON.stringify(counter)},String(count));
const mode=fs.existsSync(${JSON.stringify(mode)})?fs.readFileSync(${JSON.stringify(mode)},'utf8'):'';
if(mode==='interrupt'&&count===2)process.exit(19);
const input=fs.readFileSync(0,'utf8');
const passages=JSON.parse(input.slice(input.indexOf('PASSAGES_JSON:\\n')+'PASSAGES_JSON:\\n'.length));
let preferred='equivalent';
if(mode==='prefer')preferred=passages.A.includes('CANDIDATE')?'A':'B';
if(mode==='mixed'){
  const marker=passages.A.includes('SECOND')||passages.B.includes('SECOND')?'SECOND':'CANDIDATE';
  preferred=passages.A.includes(marker)?'A':'B';
}
if(mode==='abstain')preferred='abstain';
const result={preferred,confidence:mode==='low'?0.1:0.95,reasoning:'Fixture editorial comparison.',citations:preferred==='abstain'?[]:Object.entries(passages).map(([text,value])=>({text,quote:value.slice(0,80),explanation:'Fixture evidence.'}))};
if(mode==='bad-quote')result.citations[0].quote='Invented words that are absent.';
if(mode==='missing')result.citations=[];
if(mode==='invalid')result.preferred='tie';
if(mode==='tools')console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'ls'}}));
const text=JSON.stringify(result);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(project, "candidate.md"),
    'CANDIDATE: The service finished in 12 seconds.\n\n<script>alert("candidate")</script>',
  );
  fs.writeFileSync(
    path.join(project, "reference.md"),
    "REFERENCE: We waited 12 seconds for the transcript.\n",
  );
  fs.writeFileSync(
    path.join(project, "style.md"),
    "STYLE: We measured the delay because it interrupted every conversation.\n",
  );
  const configFile = path.join(project, "evalkit.yaml"),
    specFile = path.join(project, "spec.yaml");
  const definition = {
    id: "writing",
    title: "Writing",
    weight: 100,
    description: "Direct editorial comparison",
    scenarios: [],
    rubric: [
      {
        id: "STYLE",
        criterion: "Which passage is better written?",
        weight: 1,
        gate: true,
        passCriteria: "The candidate is at least as well written as the reference.",
        grader: {
          type: "text-pairwise",
          candidate: "candidate.md",
          references: [{ file: "reference.md" }],
          policy: "non_regression",
          voting: { minimumVotes: 2, maximumVotes: 3 },
        },
      },
    ],
  };
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Text fixture" },
      target: { kind: "repository" },
      agent: { provider: "mock" },
      judge: { provider, timeoutSeconds: 10 },
      paths: { specs: "spec.yaml" },
    }),
  );
  fs.writeFileSync(specFile, YAML.stringify(definition));
  t.after(() => {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    mode,
    counter,
    configFile,
    specFile,
    definition,
    config: loadConfig(configFile),
    specs: loadSpecs(specFile),
    fixtures: {},
  };
}

function setGrader(value: ReturnType<typeof fixture>, fields: Record<string, unknown>) {
  Object.assign(
    requireDefined(value.definition.rubric[0], "value.definition.rubric[0]").grader,
    fields,
  );
  fs.writeFileSync(value.specFile, YAML.stringify(value.definition));
  value.specs = loadSpecs(value.specFile);
}
function pairDir(runDir: string) {
  return path.join(runDir, "areas/writing/text-pairwise/STYLE/1");
}

test("text mock is unavailable, with full retained evidence and no collection scenarios", async (t) => {
  const value = fixture(t);
  const result = await runEvaluation(value),
    report = result.report!;
  assert.equal(report.overallCoveragePct, 0);
  assert.equal(report.overallScorePct, null);
  assert.equal(report.gates.passed, false);
  assert.deepEqual(requireDefined(report.areas[0], "report.areas[0]").scenarios, []);
  assert.equal(
    requireDefined(
      requireDefined(report.areas[0], "report.areas[0]").items[0],
      "report.areas[0].items[0]",
    ).source,
    "text-pairwise",
  );
  assert.equal(
    requireDefined(
      requireDefined(report.areas[0], "report.areas[0]").items[0],
      "report.areas[0].items[0]",
    ).votes?.attempted,
    3,
  );
  assert.equal(verifyArtifactIndex(result.runDir).ok, true);
  assert.deepEqual(
    loadComparisonInput(result.runDir).report.receipt.inputs.textCandidates,
    report.receipt.inputs.textCandidates,
  );
  const html = fs.readFileSync(path.join(pairDir(result.runDir), "comparison.html"), "utf8");
  assert.ok(html.includes("&lt;script&gt;alert(&quot;candidate&quot;)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  const prompt = fs.readFileSync(path.join(pairDir(result.runDir), "vote-01/prompt.md"), "utf8");
  assert.ok(!prompt.includes(value.project));
  assert.ok(!prompt.includes("candidate.md"));
  assert.ok(!prompt.includes("reference.md"));
  assert.match(prompt, /editorial taste holistically/);
});

test("interrupted direct text judging resumes sealed votes, produces scored reports, and detects tampering", async (t) => {
  const value = fixture(t, "codex");
  setGrader(value, { styleTarget: { file: "style.md" } });
  fs.writeFileSync(value.mode, "interrupt");
  await assert.rejects(runEvaluation(value), /Text pairwise judge execution failed/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const firstFile = path.join(pairDir(runDir), "vote-01/vote.json"),
    first = fs.readFileSync(firstFile, "utf8");
  fs.unlinkSync(value.mode);
  const resumed = await runEvaluation({ ...value, resumeDir: runDir });
  assert.equal(fs.readFileSync(value.counter, "utf8"), "3");
  assert.equal(fs.readFileSync(firstFile, "utf8"), first);
  assert.equal(resumed.report?.overallScorePct, 100);
  assert.equal(resumed.report?.overallCoveragePct, 100);
  assert.equal(resumed.report?.gates.passed, true);
  assert.equal(verifyArtifactIndex(runDir).ok, true);
  assert.equal(
    requireDefined(
      requireDefined(
        loadComparisonInput(runDir).report.areas[0],
        "loadComparisonInput(runDir).report.areas[0]",
      ).items[0],
      "loadComparisonInput(runDir).report.areas[0].items[0]",
    ).votes?.attempted,
    2,
  );
  const comparison = JSON.parse(
    fs.readFileSync(path.join(pairDir(runDir), "comparison.json"), "utf8"),
  );
  assert.deepEqual(
    comparison.normalizedVotes[0].citations.map((c: { text: string }) => c.text).sort(),
    ["Candidate", "Reference", "Style target"],
  );
  assert.match(
    fs.readFileSync(path.join(pairDir(runDir), "comparison.html"), "utf8"),
    /A = (Candidate; B = Reference|Reference; B = Candidate)/,
  );
  await runEvaluation({ ...value, resumeDir: runDir });
  assert.equal(
    fs.readFileSync(value.counter, "utf8"),
    "3",
    "completed area requires no new provider calls",
  );
  fs.appendFileSync(firstFile, " ");
  await assert.rejects(runEvaluation({ ...value, resumeDir: runDir }), /integrity|changed/i);
});

test("preference requires candidate wins; equivalence is observed failure, low confidence is unavailable", async (t) => {
  const value = fixture(t, "codex");
  setGrader(value, { policy: "preference" });
  const equal = await runEvaluation(value);
  assert.equal(equal.report?.overallScorePct, 0);
  assert.equal(equal.report?.overallCoveragePct, 100);
  fs.writeFileSync(value.mode, "prefer");
  const win = await runEvaluation(value);
  assert.equal(win.report?.overallScorePct, 100);
  fs.writeFileSync(value.mode, "low");
  const low = await runEvaluation(value);
  assert.equal(low.report?.overallCoveragePct, 0);
  assert.equal(low.report?.gates.passed, false);
  fs.writeFileSync(value.mode, "abstain");
  const abstain = await runEvaluation(value);
  assert.equal(abstain.report?.overallCoveragePct, 0);
});

test("multiple reference judgments aggregate observed mixed outcomes without inventing a full pass", async (t) => {
  const value = fixture(t, "codex");
  fs.writeFileSync(path.join(value.project, "second.md"), "SECOND: another reference passage.");
  setGrader(value, {
    policy: "preference",
    references: [{ file: "reference.md" }, { file: "second.md" }],
  });
  fs.writeFileSync(value.mode, "mixed");
  const result = await runEvaluation(value);
  assert.equal(
    requireDefined(
      requireDefined(result.report?.areas[0], "result.report?.areas[0]").items[0],
      "(result.report?.areas[0]).items[0]",
    ).verdict,
    "partial",
  );
  assert.equal(result.report?.overallCoveragePct, 100);
  assert.equal(result.report?.gates.passed, false);
  assert.equal(
    requireDefined(
      requireDefined(result.report?.areas[0], "result.report?.areas[0]").items[0],
      "(result.report?.areas[0]).items[0]",
    ).comparisons?.length,
    2,
  );
});

test("invalid quotations, missing citations, malformed preferences, and tool use abort without journaling votes", async (t) => {
  const value = fixture(t, "codex");
  for (const mode of ["bad-quote", "missing", "invalid", "tools"]) {
    fs.writeFileSync(value.mode, mode);
    await assert.rejects(
      runEvaluation(value),
      /Text pairwise judge (returned invalid output|execution failed)/,
    );
  }
  for (const run of fs.readdirSync(value.config.paths.runs)) {
    assert.equal(
      fs.existsSync(
        path.join(pairDir(path.join(value.config.paths.runs, run)), "vote-01/vote.json"),
      ),
      false,
    );
  }
});

test("candidate edits preserve evaluator compatibility, reference/style changes do not, and offline provenance needs no originals", async (t) => {
  const value = fixture(t);
  setGrader(value, { styleTarget: { file: "style.md" } });
  const { runDir, report } = await runEvaluation(value),
    before = report!.receipt;
  fs.writeFileSync(path.join(value.project, "candidate.md"), "An edited candidate.");
  const changed = buildRunReceipt({ ...value, split: "development" });
  assert.equal(changed.evaluationFingerprint, before.evaluationFingerprint);
  assert.notEqual(changed.inputFingerprint, before.inputFingerprint);
  await assert.rejects(
    runEvaluation({ ...value, resumeDir: runDir }),
    /changed since this run began/,
  );
  for (const name of ["reference.md", "style.md"]) {
    const file = path.join(value.project, name),
      original = fs.readFileSync(file);
    fs.appendFileSync(file, "Changed target taste.");
    assert.notEqual(
      buildRunReceipt({ ...value, split: "development" }).evaluationFingerprint,
      before.evaluationFingerprint,
    );
    fs.writeFileSync(file, original);
  }
  for (const name of ["candidate.md", "reference.md", "style.md"])
    fs.unlinkSync(path.join(value.project, name));
  const offline = buildRunReceipt({ ...value, split: "development", evidenceProvenance: before });
  assert.deepEqual(offline.inputs.textCandidates, before.inputs.textCandidates);
  assert.deepEqual(offline.inputs.textReferences, before.inputs.textReferences);
  assert.equal(offline.inputFingerprint, before.inputFingerprint);
  assert.match(readTextSnapshot(runDir, before, "STYLE", "textCandidates").text, /CANDIDATE/);
  const rescore = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
      "rescore",
      "--config",
      value.configFile,
      "--run",
      runDir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(rescore.status, 2, rescore.stdout + rescore.stderr);
  assert.match(rescore.stdout + rescore.stderr, /critical gates not satisfied/);
  assert.equal(verifyArtifactIndex(runDir).ok, true);
  const damaged = structuredClone(before);
  delete damaged.inputs.textCandidates;
  assert.throws(() => buildRunReceipt({ ...value, evidenceProvenance: damaged }), /provenance/);
  const snapshot = textInputPath(runDir, "STYLE", "textCandidates");
  fs.writeFileSync(snapshot, "Altered snapshot.");
  assert.throws(
    () => readTextSnapshot(runDir, before, "STYLE", "textCandidates"),
    /receipt mismatch/,
  );
});

test("text snapshots reject source races and path escapes; preflight rejects missing, empty, invalid, and oversized files", async (t) => {
  const value = fixture(t),
    receipt = buildRunReceipt(value);
  const runDir = path.join(value.config.paths.runs, "snapshot");
  fs.appendFileSync(path.join(value.project, "reference.md"), "Changed reference.");
  assert.throws(
    () => snapshotTextInputs(value.config, value.specs, runDir, "all", receipt.inputs),
    /changed after receipt/,
  );
  const outside = path.join(value.root, "outside.md");
  fs.writeFileSync(outside, "Outside text.");
  fs.symlinkSync(outside, path.join(value.project, "link.md"));
  for (const file of ["../outside.md", "link.md"]) {
    setGrader(value, { references: [{ file }] });
    assert.throws(() => textInputs(value.config, value.specs), /escapes project.root/);
  }
  setGrader(value, { references: [{ file: "reference.md" }] });
  fs.rmSync(value.config.paths.runs, { recursive: true, force: true });
  const candidate = path.join(value.project, "candidate.md");
  for (const content of [
    Buffer.from(" \n\t"),
    Buffer.from([0xff]),
    Buffer.from("hello\0world"),
    Buffer.alloc(MAX_TEXT_BYTES + 1, 65),
  ]) {
    fs.writeFileSync(candidate, content);
    await assert.rejects(runEvaluation({ ...value, dryRun: true }), /Text input/);
    assert.equal(fs.existsSync(value.config.paths.runs), false);
  }
  fs.unlinkSync(candidate);
  await assert.rejects(runEvaluation(value), /Save the text file/);
  assert.equal(fs.existsSync(value.config.paths.runs), false);
  fs.writeFileSync(candidate, "Café\r\n\r\nExact spacing.\n");
  assert.equal(readText(candidate).text, "Café\r\n\r\nExact spacing.\n");
});

test("text contracts require exact quotes, supported local inputs, empty scenario selectors, and a fixed style target when R is cited", (t) => {
  const value = fixture(t);
  const valid = {
    preferred: "A",
    confidence: 0.9,
    reasoning: "A has stronger prose.",
    citations: [
      { text: "A", quote: "Alpha.", explanation: "Specific." },
      { text: "B", quote: "Beta.", explanation: "Vague." },
    ],
  };
  const texts = { A: "Alpha.", B: "Beta." };
  assert.equal(validateTextPairResult(valid, texts).preferred, "A");
  assert.throws(() => validateTextPairResult(valid, { ...texts, R: "Target." }), /must cite R/);
  assert.throws(
    () =>
      validateTextPairResult(
        {
          ...valid,
          citations: [...valid.citations, { text: "R", quote: "Target.", explanation: "Voice." }],
        },
        texts,
      ),
    /supplied text R/,
  );
  assert.throws(
    () =>
      validateTextPairResult(
        { ...valid, citations: [{ text: "A", quote: " ", explanation: "Empty." }] },
        texts,
      ),
    /does not quote/,
  );
  assert.throws(
    () => validateTextPairResult({ ...valid, confidence: 0.1, citations: [] }, texts),
    /must cite A/,
  );
  const grader = requireDefined(value.definition.rubric[0], "value.definition.rubric[0]").grader;
  for (const invalid of [
    { candidate: "https://example.com/text" },
    { references: [] },
    { panel: {} },
    { references: [{ file: "file:///tmp/text" }] },
    { references: [{ baseline: "accepted" }] },
    { voting: { minimumVotes: 5, maximumVotes: 2 } },
  ])
    assert.throws(() => textPairwiseSchema.parse({ ...grader, ...invalid }));
  Object.assign(requireDefined(value.definition.rubric[0], "value.definition.rubric[0]"), {
    scenarios: ["S"],
  });
  fs.writeFileSync(value.specFile, YAML.stringify(value.definition));
  assert.throws(() => loadSpecs(value.specFile), /scenarios must be empty/);
  const prompt = textPairPrompt(
    requireDefined(
      requireDefined(value.specs[0], "value.specs[0]").rubric[0],
      "value.specs[0].rubric[0]",
    ),
    { ...texts, R: "Target." },
  );
  assert.match(prompt, /R is a fixed example/);
  assert.match(prompt, /untrusted evaluation data/);
});

test("shared pairwise normalization handles both anonymous orders and unavailable comparisons", () => {
  const policy = textPairwiseSchema.parse({
    type: "text-pairwise",
    candidate: "a.md",
    references: [{ file: "b.md" }],
    policy: "non_regression",
  }).voting;
  for (const candidateIsA of [true, false]) {
    assert.equal(
      pairOutcome({ preferred: candidateIsA ? "A" : "B", confidence: 1 }, candidateIsA, 0.55),
      "win",
    );
    assert.equal(
      pairOutcome({ preferred: candidateIsA ? "B" : "A", confidence: 1 }, candidateIsA, 0.55),
      "loss",
    );
  }
  const decision = decideVotes(Array(9).fill("abstain"), policy, ["win", "equivalent"]);
  assert.equal(pairwiseVoteVerdict(decision.decision, "non_regression"), "cannot_judge");
});

test("CLI validate checks text files without a provider call or run directory", (t) => {
  const value = fixture(t);
  const args = [
    "--import",
    "tsx",
    path.resolve("src/cli.ts"),
    "validate",
    "--config",
    value.configFile,
  ];
  const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /0 scenario templates/);
  fs.unlinkSync(path.join(value.project, "reference.md"));
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Text input.*unavailable/);
  assert.equal(fs.existsSync(value.config.paths.runs), false);
  assert.equal(fs.existsSync(value.counter), false);
});

test("lifecycle mutation of candidate text fails before any judge vote", async (t) => {
  const value = fixture(t);
  const config = YAML.parse(fs.readFileSync(value.configFile, "utf8"));
  config.target.setup = {
    command: `node -e "require('node:fs').writeFileSync('candidate.md','Changed during setup.')"`,
  };
  fs.writeFileSync(value.configFile, YAML.stringify(config));
  value.config = loadConfig(value.configFile);
  await assert.rejects(runEvaluation(value), /changed snapshotted candidate text/);
  assert.equal(fs.existsSync(value.counter), false);
});

test("first-vote failure seals direct text inputs and resumes without repeating completed setup", async (t) => {
  const value = fixture(t, "codex");
  const config = YAML.parse(fs.readFileSync(value.configFile, "utf8"));
  config.target.setup = {
    command: `node -e "const fs=require('node:fs');const p='setup-count';fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1))"`,
  };
  fs.writeFileSync(value.configFile, YAML.stringify(config));
  value.config = loadConfig(value.configFile);
  fs.writeFileSync(value.mode, "invalid");
  await assert.rejects(runEvaluation(value), /Text pairwise judge returned invalid output/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const index = verifyArtifactIndex(runDir, {
    require: true,
    allowUnindexed: (relative) => relative.startsWith("areas/"),
  });
  assert.equal(index.ok, true, index.errors.join("\n"));
  assert.ok(index.index!.entries.some((entry) => entry.path.startsWith("inputs/textCandidates/")));
  assert.ok(index.index!.entries.some((entry) => entry.path === "lifecycle/setup.stdout.log"));
  const snapshot = textInputPath(runDir, "STYLE", "textCandidates"),
    original = fs.readFileSync(snapshot);
  fs.appendFileSync(snapshot, "Unexpected edit.");
  await assert.rejects(
    runEvaluation({ ...value, resumeDir: runDir }),
    /Artifact integrity verification failed/,
  );
  fs.writeFileSync(snapshot, original);
  fs.unlinkSync(value.mode);
  const result = await runEvaluation({ ...value, resumeDir: runDir });
  assert.equal(result.report!.overallScorePct, 100);
  assert.equal(fs.readFileSync(path.join(value.project, "setup-count"), "utf8"), "1");
});

test("comparison reports identify changes to reference writing and style targets", async (t) => {
  const value = fixture(t);
  setGrader(value, { styleTarget: { file: "style.md" } });
  const baseline = (await runEvaluation(value)).report!;
  for (const file of ["reference.md", "style.md"]) {
    const absolute = path.join(value.project, file),
      original = fs.readFileSync(absolute);
    fs.appendFileSync(absolute, "New reference wording.");
    const candidate = (await runEvaluation(value)).report!;
    const comparison = compareReports(baseline, candidate);
    assert.equal(comparison.compatibility.status, "incompatible");
    assert.ok(
      comparison.compatibility.differences.some((reason) =>
        /text reference|style target/i.test(reason),
      ),
    );
    assert.ok(
      !comparison.compatibility.differences.some((reason) => /unknown reason/.test(reason)),
    );
    fs.writeFileSync(absolute, original);
  }
});
