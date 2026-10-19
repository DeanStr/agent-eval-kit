import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { judgeCollected } from "../src/judge-run.js";
import { loadJudgeValidationReview } from "../src/judge-validation-review.js";
import { assertArtifactIntegrity } from "../src/integrity.js";
import { sha256, writeJson } from "../src/io.js";
import { validationMetrics, verdictOutcome } from "../src/validation-metrics.js";
import {
  runJudgeValidation,
  validateValidationDataset,
  validationDatasetSchema,
  validationLabelsSchema,
  validationConfigurationsSchema,
  validationConfigurationResults,
} from "../src/judge-validation.js";
import { referenceOutcomes } from "../scripts/reference-results.js";
import type { RunReport } from "../src/types.js";

test("validation denominators retain abstentions and errors without inventing decisions", () => {
  const metrics = validationMetrics([
    { expected: "fail", ...verdictOutcome("pass") },
    { expected: "fail", status: "execution_error", error: "judge timeout" },
    { expected: "pass", ...verdictOutcome("partial") },
    { expected: "pass", ...verdictOutcome("cannot_judge") },
    { expected: "cannot_judge", ...verdictOutcome("pass") },
    { expected: "cannot_judge", ...verdictOutcome("cannot_judge") },
  ]);
  assert.deepEqual(metrics.falsePasses, { count: 1, denominator: 2, rate: 0.5 });
  assert.deepEqual(metrics.falseFailures, { count: 1, denominator: 2, rate: 0.5 });
  assert.equal(metrics.executionErrors.count, 1);
  assert.equal(metrics.abstentions.count, 2);
  assert.equal(metrics.abstentions.denominator, 6);
  assert.equal(metrics.decisionCoverage.count, 3);
  assert.deepEqual(metrics.unsupportedDecisions, { count: 1, denominator: 2, rate: 0.5 });
  assert.equal(validationMetrics([]).falsePasses.rate, null);
});

test("reviewer evidence retains pinned reference bytes when configurations replace references", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-reviewed-reference-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const spec = (reference: string) => ({
    id: "core",
    title: "Core",
    description: "Reference replacement",
    weight: 100,
    scenarios: [],
    rubric: [
      {
        id: "CHECK",
        criterion: "Match the reference",
        passCriteria: "Matches",
        weight: 1,
        grader: {
          type: "text-rubric",
          inputs: {
            draft: { file: { text: "A draft" } },
            source: { file: { text: reference }, role: "reference" },
          },
          voting: { minimumVotes: 1, maximumVotes: 1, agreement: 1 },
        },
      },
    ],
  });
  fs.writeFileSync(
    path.join(project, "original.yaml"),
    YAML.stringify(spec("ORIGINAL_REVIEWED_REFERENCE")),
  );
  fs.writeFileSync(
    path.join(project, "replacement.yaml"),
    YAML.stringify(spec("DIFFERENT_CANDIDATE_REFERENCE")),
  );
  const config = {
    version: 1,
    project: { name: "Reference validation", root: "." },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: { provider: "mock" },
    paths: { specs: "original.yaml", runs: "../collections" },
  };
  const configFile = path.join(project, "evalkit.yaml");
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(
    path.join(project, "replacement-config.yaml"),
    YAML.stringify({ ...config, paths: { ...config.paths, specs: "replacement.yaml" } }),
  );
  const collection = await runEvaluation({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(path.join(project, "original.yaml")),
    fixtures: {},
    collectOnly: true,
  });
  const rootSha256 = assertArtifactIntegrity(collection.runDir, { require: true })!.rootSha256;
  const ref = `inputs/textReferences/${sha256("CHECK/source")}.txt`;
  writeJson(path.join(root, "cases.json"), {
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence: { directory: collection.runDir, rootSha256 },
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
    ],
  });
  writeJson(path.join(root, "labels.json"), {
    version: 1,
    labels: [
      {
        caseId: "one",
        evidenceRootSha256: rootSha256,
        area: "core",
        rubric: "CHECK",
        reviewer: { name: "Reference reviewer", kind: "human" },
        application: {
          verdict: "unknown",
          rationale: "No independent application result",
          sources: ["Review note"],
        },
        evidence: {
          verdict: "cannot_judge",
          rationale: "The original reference is insufficient",
          refs: [ref],
        },
      },
    ],
  });
  writeJson(path.join(root, "configurations.json"), {
    version: 1,
    configurations: [
      { id: "original", config: configFile },
      { id: "replacement", config: path.join(project, "replacement-config.yaml") },
    ],
  });
  const result = await runJudgeValidation({
    datasetFile: path.join(root, "cases.json"),
    labelsFile: path.join(root, "labels.json"),
    configurationsFile: path.join(root, "configurations.json"),
    output: path.join(root, "comparison"),
  });
  assert.ok(result.report.observations.every((observation) => observation.status === "abstained"));
  const html = fs.readFileSync(path.join(result.output, "validation-results.html"), "utf8");
  const reviewed = html.slice(
    html.indexOf("<h3>Reviewed expectations"),
    html.indexOf('<div class="decisions">'),
  );
  assert.match(reviewed, /ORIGINAL_REVIEWED_REFERENCE/);
  assert.doesNotMatch(reviewed, /DIFFERENT_CANDIDATE_REFERENCE/);
  assert.match(html, /DIFFERENT_CANDIDATE_REFERENCE/);
  const snapshot = fs.readFileSync(path.join(result.output, "review/evidence/one", ref), "utf8");
  assert.equal(snapshot, "ORIGINAL_REVIEWED_REFERENCE");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(result.output, "review/evidence/one.json"), "utf8"),
  );
  assert.equal(manifest.evidenceRootSha256, rootSha256);
  assert.equal(
    manifest.artifacts.find((artifact: { path: string }) => artifact.path === ref).sha256,
    sha256(snapshot),
  );
});

test("reference results require real verdicts and distinguish missing evidence from abstention", () => {
  assert.throws(() => referenceOutcomes(undefined, false), /without a report/);
  const report = { areas: [{ id: "reference", items: [], scenarios: [] }] } as unknown as RunReport;
  assert.throws(() => referenceOutcomes(report, false), /exactly one TOTAL/);
  report.areas[0]!.items.push({
    id: "TOTAL",
    verdict: "cannot_judge",
    reasoning: "Blocked",
    evidenceRefs: [],
    confidence: "high",
    source: "llm",
  });
  assert.deepEqual(referenceOutcomes(report, false), [
    { status: "abstained", actual: "cannot_judge" },
  ]);
  report.areas[0]!.items.push({
    id: "PERSIST",
    verdict: "pass",
    reasoning: "Unsupported",
    evidenceRefs: [],
    confidence: "high",
    source: "llm",
  });
  assert.throws(() => referenceOutcomes(report, true), /lacks required browser screenshot/);
});

test("reference CLI counts failed executions and retains diagnostics without verdicts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-reference-errors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('codex-cli reference-test');
else if (process.argv.includes('status')) console.log('Logged in using ChatGPT');
else { console.error('reference provider transport failure'); process.exitCode = 9; }
`,
    { mode: 0o755 },
  );
  const output = path.join(root, "output");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/reference-eval.ts", "--provider", "codex", "--output", output],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, "reference-results.json"), "utf8"));
  assert.equal(report.observations.length, report.plannedObservations);
  assert.equal(report.metrics.executionErrors, report.plannedObservations);
  assert.equal(report.metrics.abstentions, 0);
  assert.equal(report.passed, false);
  for (const item of report.observations) {
    assert.equal(item.status, "execution_error");
    assert.equal(Object.hasOwn(item, "actual"), false);
    assert.equal(Object.hasOwn(item, "score"), false);
    assert.ok(item.error);
    assert.match(
      fs.readFileSync(path.join(item.runDir, "SOURCE/provider-stderr.log"), "utf8"),
      /reference provider transport failure/,
    );
  }
});

test("related examples and identical evidence cannot cross splits or lose label identity", () => {
  const evidence = { directory: "collection", rootSha256: "a".repeat(64) };
  const dataset = validationDatasetSchema.parse({
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence,
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
      {
        id: "two",
        group: "family",
        split: "evaluation",
        evidence,
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
    ],
  });
  const labels = validationLabelsSchema.parse({
    version: 1,
    labels: dataset.cases.map((item) => ({
      caseId: item.id,
      evidenceRootSha256: evidence.rootSha256,
      area: item.area,
      rubric: item.rubric,
      reviewer: { name: "Test author", kind: "agent" },
      application: {
        verdict: "pass",
        rationale: "Known application behavior",
        sources: ["independent observation"],
      },
      evidence: { verdict: "cannot_judge", rationale: "Missing observation", refs: [] },
    })),
  });
  assert.throws(() => validateValidationDataset(dataset, labels), /crosses dataset splits/);
  dataset.cases[1]!.group = "another";
  assert.throws(() => validateValidationDataset(dataset, labels), /Identical evidence/);
  dataset.cases[1]!.group = "family";
  dataset.cases[1]!.split = "development";
  validateValidationDataset(dataset, labels);
  const caseAliases = {
    ...dataset,
    cases: [dataset.cases[0]!, { ...dataset.cases[0]!, id: "ONE" }],
  };
  const aliasLabels = {
    ...labels,
    labels: [labels.labels[0]!, { ...labels.labels[0]!, caseId: "ONE" }],
  };
  assert.throws(() => validateValidationDataset(caseAliases, aliasLabels), /duplicate case ID/i);
  assert.throws(
    () =>
      validationConfigurationsSchema.parse({
        version: 1,
        configurations: [
          { id: "judge", config: "first.yaml" },
          { id: "JUDGE", config: "second.yaml" },
        ],
      }),
    /duplicate configuration ID/i,
  );
  assert.doesNotThrow(() =>
    validationDatasetSchema.parse({
      ...dataset,
      cases: [{ ...dataset.cases[0], area: "core.v2", rubric: "CHECK.1" }],
    }),
  );
  labels.labels[0]!.evidenceRootSha256 = "b".repeat(64);
  assert.throws(() => validateValidationDataset(dataset, labels), /mismatched reviewer label/);
});

test("reviewer labels remain bound to the selected area and rubric", () => {
  const dataset = validationDatasetSchema.parse({
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence: { directory: "collection", rootSha256: "a".repeat(64) },
        area: "core",
        rubric: "A",
        sources: [],
      },
    ],
  });
  const labels = {
    version: 1 as const,
    labels: [
      {
        caseId: "one",
        evidenceRootSha256: "a".repeat(64),
        area: "core",
        rubric: "A",
        reviewer: { name: "Fixture author", kind: "agent" as const },
        application: { verdict: "pass" as const, rationale: "A holds", sources: ["fixture"] },
        evidence: {
          verdict: "pass" as const,
          rationale: "A was observed",
          refs: ["evidence.json"],
        },
      },
    ],
  };
  validationLabelsSchema.parse(labels);
  const missingCriterion = structuredClone(labels);
  Reflect.deleteProperty(missingCriterion.labels[0]!, "area");
  Reflect.deleteProperty(missingCriterion.labels[0]!, "rubric");
  assert.throws(() => validationLabelsSchema.parse(missingCriterion), /area|rubric/);
  validateValidationDataset(dataset, labels);
  dataset.cases[0]!.rubric = "B";
  assert.throws(() => validateValidationDataset(dataset, labels), /reviewer label.*criterion/i);
  dataset.cases[0]!.rubric = "A";
  dataset.cases[0]!.area = "other";
  assert.throws(() => validateValidationDataset(dataset, labels), /reviewer label.*criterion/i);
});

test("validation rejects hybrid and manual targets before judging or recording abstentions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-validation-automatic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const spec = {
    id: "core",
    title: "Core",
    description: "Automatic validation",
    weight: 100,
    scenarios: [
      { id: "OBSERVE", name: "Observe", kind: "workspace", instructions: "Observe source" },
    ],
    rubric: [
      {
        id: "CHECK",
        criterion: "Observed behavior",
        weight: 1,
        scenarios: ["OBSERVE"],
        grader: { type: "llm" },
        passCriteria: "Use supplied evidence",
      },
    ],
  };
  const config = {
    version: 1,
    project: { name: "Validation fixture", root: "." },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: { provider: "mock" },
    paths: { specs: "spec.yaml", runs: "../collections" },
  };
  const configFile = path.join(project, "evalkit.yaml");
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(path.join(project, "spec.yaml"), YAML.stringify(spec));
  const collection = await runEvaluation({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(path.join(project, "spec.yaml")),
    fixtures: {},
    collectOnly: true,
  });
  const evidenceRootSha256 = assertArtifactIntegrity(collection.runDir, {
    require: true,
  })!.rootSha256;
  writeJson(path.join(root, "cases.json"), {
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence: { directory: collection.runDir, rootSha256: evidenceRootSha256 },
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
    ],
  });
  const labels = validationLabelsSchema.parse({
    version: 1,
    labels: [
      {
        caseId: "one",
        evidenceRootSha256,
        area: "core",
        rubric: "CHECK",
        reviewer: { name: "Fixture author", kind: "agent" },
        application: { verdict: "pass", rationale: "Fixture", sources: ["fixture"] },
        evidence: { verdict: "pass", rationale: "Fixture", refs: ["OBSERVE/evidence.json"] },
      },
    ],
  });
  writeJson(path.join(root, "labels.json"), labels);
  const configurations = ["hybrid", "manual"].map((type) => {
    const specFile = path.join(project, `${type}.yaml`);
    fs.writeFileSync(
      specFile,
      YAML.stringify({
        ...spec,
        rubric: [
          {
            ...spec.rubric[0],
            grader: type === "hybrid" ? { type, autoShare: 0.5 } : { type },
            manualInstructions: "Review independently",
          },
        ],
      }),
    );
    const file = path.join(project, `config-${type}.yaml`);
    fs.writeFileSync(
      file,
      YAML.stringify({ ...config, paths: { ...config.paths, specs: specFile } }),
    );
    return { id: type, config: file };
  });
  writeJson(path.join(root, "configurations.json"), { version: 1, configurations });
  const result = await runJudgeValidation({
    datasetFile: path.join(root, "cases.json"),
    labelsFile: path.join(root, "labels.json"),
    configurationsFile: path.join(root, "configurations.json"),
    output: path.join(root, "comparison"),
  });
  for (const observation of result.report.observations) {
    assert.equal(observation.status, "execution_error");
    if (observation.status !== "execution_error") throw new Error("Expected execution error");
    assert.match(observation.error, /automatic rubric.*hybrid|automatic rubric.*manual/);
    assert.equal(Object.hasOwn(observation, "actual"), false);
    assert.equal(observation.runDir, undefined);
    assert.equal(
      fs.existsSync(path.join(result.output, "attempts", observation.configuration, "one", "runs")),
      false,
    );
  }
  assert.ok(
    result.report.results.every(
      ({ metrics }) => metrics.executionErrors.count === 1 && metrics.abstentions.count === 0,
    ),
  );
  loadJudgeValidationReview(result.output);

  // An older comparison can contain a sealed hybrid aggregate. The journal
  // reader must also reject it, even if its summary agrees with the report.
  const hybridFile = configurations[0]!.config;
  const hybridConfig = loadConfig(hybridFile);
  hybridConfig.paths.runs = path.join(result.output, "attempts/hybrid/one/runs");
  const historical = await judgeCollected({
    evidenceDir: collection.runDir,
    config: hybridConfig,
    configFile: hybridFile,
    specs: loadSpecs(hybridConfig.paths.specs),
    fixtures: {},
    explicitConfig: true,
  });
  const judgement = historical.report.areas[0]!.items[0]!;
  result.report.observations[0] = {
    caseId: "one",
    configuration: "hybrid",
    split: "development",
    evidenceRootSha256,
    ...verdictOutcome(judgement.verdict),
    runDir: historical.runDir,
    evaluationFingerprint: historical.report.receipt.evaluationFingerprint,
    reasoning: judgement.reasoning,
    evidenceRefs: judgement.evidenceRefs,
  };
  result.report.results = validationConfigurationResults(
    ["hybrid", "manual"],
    result.report.observations,
    labels,
  );
  writeJson(path.join(result.output, "validation-results.json"), result.report);
  assert.throws(() => loadJudgeValidationReview(result.output), /automatic rubric.*hybrid/);
});

test("validation reuses identical sealed evidence, isolates labels, and retains failed judge diagnostics", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const spec = {
    id: "core",
    title: "Core",
    description: "Fixed evidence judgement",
    weight: 100,
    scenarios: [
      { id: "OBSERVE", name: "Observe", kind: "workspace", instructions: "Observe source" },
    ],
    rubric: [
      {
        id: "CHECK",
        criterion: "Observed behavior",
        weight: 1,
        scenarios: ["OBSERVE"],
        grader: { type: "llm" },
        passCriteria: "Use supplied evidence",
      },
    ],
  };
  fs.writeFileSync(path.join(project, "spec.yaml"), YAML.stringify(spec));
  const config = {
    version: 1,
    project: { name: "Validation fixture", root: "." },
    target: { kind: "repository" },
    agent: { provider: "mock" },
    judge: { provider: "mock" },
    paths: { specs: "spec.yaml", runs: "../collections" },
  };
  const configFile = path.join(project, "evalkit.yaml");
  fs.writeFileSync(configFile, YAML.stringify(config));
  const collection = await runEvaluation({
    config: loadConfig(configFile),
    configFile,
    specs: loadSpecs(path.join(project, "spec.yaml")),
    fixtures: {},
    collectOnly: true,
  });
  const index = assertArtifactIntegrity(collection.runDir, { require: true })!;
  const dataset = {
    version: 1,
    cases: [
      {
        id: "one",
        group: "family",
        split: "development",
        evidence: { directory: collection.runDir, rootSha256: index.rootSha256 },
        area: "core",
        rubric: "CHECK",
        sources: [],
      },
    ],
  };
  const labels = {
    version: 1,
    labels: [
      {
        caseId: "one",
        evidenceRootSha256: index.rootSha256,
        area: "core",
        rubric: "CHECK",
        reviewer: { name: "Test reviewer", kind: "agent" },
        application: {
          verdict: "pass",
          rationale: "External success KNOWN_OUTCOME_SECRET",
          sources: ["outside observation"],
        },
        evidence: {
          verdict: "cannot_judge",
          rationale: "No evidence LABEL_RATIONALE_SECRET",
          refs: [],
        },
      },
    ],
  };
  const alternate = path.join(project, "alternate.yaml");
  fs.writeFileSync(
    alternate,
    YAML.stringify({ ...config, judge: { provider: "mock", model: "alternate" } }),
  );
  // Valid configuration, incompatible collection contract: an execution error, not abstention.
  const incompatible = path.join(project, "incompatible.yaml");
  fs.writeFileSync(
    incompatible,
    YAML.stringify({ ...config, instructions: "Changed collection instructions" }),
  );
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('Claude Code validation-test');
else if (process.argv.includes('wait')) {
  require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "waiting.pid"))}, String(process.pid));
  setInterval(() => {}, 1000);
}
else if (process.argv.includes('empty-reasoning')) {
  const judgement = { verdict: 'cannot_judge', confidence: 'low', reasoning: '', evidenceRefs: [] };
  const structured = {
    items: [{ id: 'CHECK', ...judgement }],
    cases: [{ rubricId: 'CHECK', caseId: 'default', ...judgement }],
    defects: [], notes: '',
  };
  console.log(JSON.stringify({ type: 'result', structured_output: structured, result: JSON.stringify(structured) }));
}
else { console.error('fixture judge crashed before producing a judgement'); process.exitCode = 1; }
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const crashed = path.join(project, "crashed.yaml");
  fs.writeFileSync(
    crashed,
    YAML.stringify({ ...config, judge: { provider: "claude", timeoutSeconds: 10 } }),
  );
  const emptyReasoning = path.join(project, "empty-reasoning.yaml");
  fs.writeFileSync(
    emptyReasoning,
    YAML.stringify({
      ...config,
      judge: { provider: "claude", model: "empty-reasoning", timeoutSeconds: 10 },
    }),
  );
  writeJson(path.join(root, "cases.json"), dataset);
  writeJson(path.join(root, "labels.json"), labels);
  writeJson(path.join(root, "configurations.json"), {
    version: 1,
    configurations: [
      { id: "first", config: configFile },
      { id: "second", config: alternate },
      { id: "error", config: incompatible },
      { id: "crashed", config: crashed },
      { id: "empty", config: emptyReasoning },
    ],
  });
  const run = () =>
    runJudgeValidation({
      datasetFile: path.join(root, "cases.json"),
      labelsFile: path.join(root, "labels.json"),
      configurationsFile: path.join(root, "configurations.json"),
      output: path.join(root, "comparison"),
    });
  const result = await run();
  const html = fs.readFileSync(path.join(result.output, "validation-results.html"), "utf8");
  assert.match(html, /Reviewed expectations/);
  assert.match(html, /Evidence-supported expectation: cannot_judge/);
  assert.match(html, /Known application outcome: pass/);
  assert.match(html, /first: cannot_judge/);
  assert.match(html, /error: execution error/);
  assert.match(html, /Attempt diagnostic/);
  assert.match(html, /KNOWN_OUTCOME_SECRET/);
  assert.match(html, /LABEL_RATIONALE_SECRET/);
  assert.match(html, /False passes/);
  assert.match(html, /0\/0 \(unavailable\)/);
  assert.match(html, /href="attempts\/first\/one\/runs\//);
  assert.deepEqual(
    result.report.observations.map((item) => item.status),
    ["abstained", "abstained", "execution_error", "execution_error", "abstained"],
  );
  // Empty reasoning is valid under the existing provider/report contracts.
  // The review reader must accept it exactly as recorded, without a default.
  assert.equal(result.report.observations[4]!.reasoning, "");
  const failure = result.report.observations[2]!;
  assert.equal(Object.hasOwn(failure, "actual"), false);
  assert.equal(Object.hasOwn(failure, "score"), false);
  assert.match(
    failure.status === "execution_error" ? failure.error : "",
    /Collection configuration changed/,
  );
  assert.equal(result.report.results[2]!.metrics.executionErrors.count, 1);
  assert.equal(result.report.results[2]!.metrics.abstentions.count, 0);
  assert.equal(result.report.results[0]!.metrics.correctAbstentions.count, 1);
  const crashedResult = result.report.observations[3]!;
  assert.equal(Object.hasOwn(crashedResult, "actual"), false);
  assert.equal(fs.existsSync(path.join(crashedResult.runDir!, "report.json")), false);
  assert.match(
    fs.readFileSync(
      path.join(crashedResult.runDir!, "areas/core/_judge/provider-stderr.log"),
      "utf8",
    ),
    /fixture judge crashed/,
  );
  const first = result.report.observations[0]!,
    second = result.report.observations[1]!;
  assert.notEqual(first.evaluationFingerprint, second.evaluationFingerprint);
  for (const item of [first, second]) {
    const receipt = JSON.parse(fs.readFileSync(path.join(item.runDir!, "receipt.json"), "utf8"));
    assert.equal(receipt.collection.artifactRootSha256, index.rootSha256);
    const prompt = fs.readFileSync(path.join(item.runDir!, "areas/core/_judge/prompt.md"), "utf8");
    assert.doesNotMatch(prompt, /KNOWN_OUTCOME_SECRET|LABEL_RATIONALE_SECRET/);
  }
  assert.equal(
    assertArtifactIntegrity(collection.runDir, { require: true })!.rootSha256,
    index.rootSha256,
  );
  const resultFile = path.join(result.output, "validation-results.json");
  const originalSummary = fs.readFileSync(resultFile);
  const record = () =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "examples/judge-validation/record-review.ts", root, result.output],
      { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 },
    );
  const sealedDestination = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "examples/judge-validation/record-review.ts",
      collection.runDir,
      result.output,
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(sealedDestination.error);
  assert.equal(sealedDestination.status, 1, sealedDestination.stderr);
  assert.equal(fs.existsSync(path.join(collection.runDir, "journal.ndjson")), false);
  for (const mutation of [
    (report: typeof result.report) =>
      Object.assign(report.observations[0]!, { status: "judged", actual: "pass" }),
    (report: typeof result.report) => {
      report.observations[1] = report.observations[0]!;
    },
    (report: typeof result.report) => {
      report.observations[0]!.evaluationFingerprint = "0".repeat(64);
    },
    (report: typeof result.report) => {
      report.results[0]!.metrics.abstentions.count = 0;
    },
  ]) {
    const changed = JSON.parse(originalSummary.toString()) as typeof result.report;
    mutation(changed);
    writeJson(resultFile, changed);
    const rejected = record();
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.equal(fs.existsSync(path.join(root, "journal.ndjson")), false);
  }
  fs.writeFileSync(resultFile, originalSummary);
  const datasetSnapshotFile = path.join(result.output, "review/dataset.json");
  const originalDatasetSnapshot = fs.readFileSync(datasetSnapshotFile);
  const retargetedDataset = JSON.parse(originalDatasetSnapshot.toString());
  retargetedDataset.cases[0].rubric = "ANOTHER";
  writeJson(datasetSnapshotFile, retargetedDataset);
  const retargetedSummary = JSON.parse(originalSummary.toString());
  retargetedSummary.inputs.dataset.sha256 = sha256(fs.readFileSync(datasetSnapshotFile));
  writeJson(resultFile, retargetedSummary);
  assert.throws(() => loadJudgeValidationReview(result.output), /reviewer label.*criterion/i);
  fs.writeFileSync(datasetSnapshotFile, originalDatasetSnapshot);
  fs.writeFileSync(resultFile, originalSummary);
  const snapshotFile = path.join(result.output, "review/labels.json");
  const snapshot = fs.readFileSync(snapshotFile);
  fs.appendFileSync(snapshotFile, " ");
  assert.equal(record().status, 1);
  assert.equal(fs.existsSync(path.join(root, "journal.ndjson")), false);
  fs.writeFileSync(snapshotFile, snapshot);
  const recorded = record();
  assert.ifError(recorded.error);
  assert.equal(recorded.status, 0, recorded.stderr);
  const journal = fs
    .readFileSync(path.join(root, "journal.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(journal.length, 5);
  assert.equal(journal[0].verdicts.CHECK, "cannot_judge");
  assert.equal(journal[3].exitCode, 1);
  assert.equal(Object.hasOwn(journal[3], "verdicts"), false);
  assert.equal(Object.hasOwn(journal[3], "score"), false);
  assert.equal(journal[4].verdicts.CHECK, "cannot_judge");

  // Execution errors fail; reviewer disagreement does not enforce product gates.
  const cliFile = path.resolve(import.meta.dirname, "../src/cli.ts");
  const cliArgs = (
    output: string,
    configurations = "configurations.json",
    labelFile = "labels.json",
  ) => [
    "--import",
    "tsx",
    cliFile,
    "judge",
    "validate",
    "--dataset",
    path.join(root, "cases.json"),
    "--labels",
    path.join(root, labelFile),
    "--configurations",
    path.join(root, configurations),
    "--output",
    path.join(root, output),
  ];
  const cliError = spawnSync(process.execPath, cliArgs("cli-error"), {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(cliError.error);
  assert.equal(cliError.status, 1, cliError.stdout + cliError.stderr);
  assert.ok(fs.existsSync(path.join(root, "cli-error/validation-results.html")));
  writeJson(path.join(root, "cli-configurations.json"), {
    version: 1,
    configurations: [{ id: "first", config: configFile }],
  });
  writeJson(path.join(root, "disagreement-labels.json"), {
    ...labels,
    labels: [
      {
        ...labels.labels[0],
        evidence: {
          verdict: "fail",
          rationale: "A deliberately different reviewed expectation",
          refs: ["OBSERVE/evidence.json"],
        },
      },
    ],
  });
  const cliDisagreement = spawnSync(
    process.execPath,
    cliArgs("cli-disagreement", "cli-configurations.json", "disagreement-labels.json"),
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(cliDisagreement.error);
  assert.equal(cliDisagreement.status, 0, cliDisagreement.stdout + cliDisagreement.stderr);
  assert.match(
    fs.readFileSync(path.join(root, "cli-disagreement/validation-results.html"), "utf8"),
    /Differs from evidence expectation/,
  );

  if (process.platform !== "win32") {
    const waiting = path.join(project, "waiting.yaml");
    fs.writeFileSync(
      waiting,
      YAML.stringify({
        ...config,
        judge: { provider: "claude", model: "wait", timeoutSeconds: 15 },
      }),
    );
    writeJson(path.join(root, "waiting-configurations.json"), {
      version: 1,
      configurations: [
        { id: "waiting", config: waiting },
        { id: "pending", config: configFile },
      ],
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const marker = path.join(root, "waiting.pid");
      fs.rmSync(marker, { force: true });
      const child = spawn(
        process.execPath,
        cliArgs(`cli-${signal}`, "waiting-configurations.json"),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null)
          await delay(20);
        assert.ok(fs.existsSync(marker), output);
        child.kill(signal);
        assert.equal(await exited, signal === "SIGINT" ? 130 : 143, output);
        assert.throws(() => process.kill(Number(fs.readFileSync(marker, "utf8")), 0), /ESRCH/);
        const partial = JSON.parse(
          fs.readFileSync(path.join(root, `cli-${signal}/validation-results.json`), "utf8"),
        );
        assert.equal(partial.observations.length, 1);
        assert.equal(partial.observations[0].status, "execution_error");
        assert.equal(Object.hasOwn(partial.observations[0], "actual"), false);
        const partialHtml = fs.readFileSync(
          path.join(root, `cli-${signal}/validation-results.html`),
          "utf8",
        );
        assert.match(partialHtml, /Comparison incomplete/);
        assert.match(partialHtml, /Not attempted/);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
      }
    }
  }

  const originalSpec = fs.readFileSync(path.join(project, "spec.yaml"));
  writeJson(path.join(root, "drift-cases.json"), {
    ...dataset,
    cases: [...dataset.cases, { ...dataset.cases[0], id: "two" }],
  });
  writeJson(path.join(root, "drift-labels.json"), {
    ...labels,
    labels: [...labels.labels, { ...labels.labels[0], caseId: "two" }],
  });
  const drift = await runJudgeValidation({
    datasetFile: path.join(root, "drift-cases.json"),
    labelsFile: path.join(root, "drift-labels.json"),
    configurationsFile: path.join(root, "configurations.json"),
    output: path.join(root, "drift"),
    onProgress: (message) => {
      if (message === "first/two")
        fs.writeFileSync(
          path.join(project, "spec.yaml"),
          YAML.stringify({
            ...spec,
            rubric: [{ ...spec.rubric[0], passCriteria: "Changed during comparison" }],
          }),
        );
    },
  });
  assert.deepEqual(
    drift.report.observations.slice(0, 2).map((item) => item.status),
    ["abstained", "execution_error"],
  );
  fs.writeFileSync(path.join(project, "spec.yaml"), originalSpec);
  writeJson(path.join(root, "colliding-configurations.json"), {
    version: 1,
    configurations: [
      { id: "judge", config: configFile },
      { id: "JUDGE", config: alternate },
    ],
  });
  await assert.rejects(
    runJudgeValidation({
      datasetFile: path.join(root, "cases.json"),
      labelsFile: path.join(root, "labels.json"),
      configurationsFile: path.join(root, "colliding-configurations.json"),
      output: path.join(root, "collision"),
    }),
    /duplicate configuration ID/i,
  );
  assert.equal(fs.existsSync(path.join(root, "collision")), false);
  await assert.rejects(run(), /EEXIST/);
  fs.copyFileSync(path.join(root, "labels.json"), path.join(project, "labels.json"));
  await assert.rejects(
    runJudgeValidation({
      datasetFile: path.join(root, "cases.json"),
      labelsFile: path.join(project, "labels.json"),
      configurationsFile: path.join(root, "configurations.json"),
      output: path.join(root, "other"),
    }),
    /outside judge inputs/,
  );
  fs.appendFileSync(
    path.join(collection.runDir, "OBSERVE/evidence.json"),
    " TAMPERED_REVIEW_PREVIEW",
  );
  writeJson(path.join(root, "corrupt-labels.json"), {
    ...labels,
    labels: [
      {
        ...labels.labels[0],
        evidence: { ...labels.labels[0]!.evidence, refs: ["OBSERVE/evidence.json"] },
      },
    ],
  });
  const corrupted = await runJudgeValidation({
    datasetFile: path.join(root, "cases.json"),
    labelsFile: path.join(root, "corrupt-labels.json"),
    configurationsFile: path.join(root, "configurations.json"),
    output: path.join(root, "corruption"),
  });
  assert.ok(corrupted.report.observations.every((item) => item.status === "execution_error"));
  assert.ok(corrupted.report.results.every((item) => item.metrics.abstentions.count === 0));
  const corruptedHtml = fs.readFileSync(
    path.join(root, "corruption/validation-results.html"),
    "utf8",
  );
  assert.match(corruptedHtml, /Reviewer evidence previews unavailable/);
  assert.doesNotMatch(corruptedHtml, /TAMPERED_REVIEW_PREVIEW/);
});
