import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import {
  benchmarkMeasurementsSchema,
  compareBenchmarkCampaigns,
  loadBenchmarkRun,
  writeBenchmarkComparison,
  type BenchmarkMeasurements,
} from "../src/benchmark.js";
import {
  buildCampaignReport,
  campaignRunRecord,
  writeCampaignArtifacts,
  type CampaignRunRecord,
} from "../src/campaign.js";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { scoreArea, buildReport } from "../src/scoring.js";
import { writeArtifactIndex } from "../src/integrity.js";
import type { Verdict } from "../src/types.js";

const selection = { scenarioId: "WORKLOAD", fileLabel: "measurements" };
const collector = `import fs from 'node:fs'; import path from 'node:path';
const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8'));
const subject=JSON.parse(fs.readFileSync(c.sources.subject.path,'utf8'));
if(subject.crash) throw Error('Measurement subprocess crashed');
const files=[];
if(!subject.omit) {
 fs.writeFileSync(path.join(c.outputDir,'measurements.json'),JSON.stringify(subject.measurements));
 files.push({label:'measurements',path:'measurements.json',filename:'measurements.json',mediaType:'application/json'});
}
fs.writeFileSync(path.join(c.outputDir,'correctness.json'),JSON.stringify({valid:subject.valid,uncited:subject.uncited}));
files.push({label:'correctness',path:'correctness.json',filename:'correctness.json',mediaType:'application/json'});
console.log(JSON.stringify({version:1,outcome:subject.omit?'blocked':'completed',summary:subject.omit?'No GPU query available':'Work observed',observations:['Project-owned correctness evidence'],files}));`;
const checker = `import fs from 'node:fs';import path from 'node:path';
const dir=path.join(process.env.AEK_RUN_DIR,'WORKLOAD');
const evidence=JSON.parse(fs.readFileSync(path.join(dir,'evidence.json'),'utf8'));
const file=evidence.files.find(file=>file.label==='correctness');
const value=JSON.parse(fs.readFileSync(path.join(dir,file.path),'utf8'));
console.log(JSON.stringify({verdict:evidence.outcome==='blocked'?'cannot_judge':value.valid?'pass':'fail',confidence:'high',reasoning:'Independent output check',evidenceRefs:[value.uncited?'WORKLOAD/evidence.json':'WORKLOAD/'+file.path]}));`;

function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-benchmark-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function measurements(id: string, samples = [10, 20]): BenchmarkMeasurements {
  return {
    version: 1,
    candidate: { id, revision: `revision-${id}` },
    workload: { id: "fixed-work", sha256: "a".repeat(64) },
    method: { id: "project-timer-v1", sha256: "b".repeat(64) },
    environment: { hardware: "fixture", concurrency: 1, warm: true },
    work: { unit: "items", requested: 10, completed: 10 },
    outcome: { state: "completed" },
    metrics: [
      {
        id: "time",
        unit: "ms",
        preferredDirection: "lower",
        scope: "application",
        observation: { state: "observed", samples },
      },
      {
        id: "transport",
        unit: "ms",
        preferredDirection: "lower",
        scope: "remote_execution",
        observation: { state: "observed", samples: [9000] },
      },
    ],
    correctness: [{ scenarioId: "WORKLOAD", fileLabel: "correctness" }],
  };
}

async function campaign(
  root: string,
  id: string,
  subject: object,
  failed = false,
  minimumCoverage = 100,
) {
  const project = path.join(root, id);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "subject.json"), JSON.stringify(subject));
  fs.writeFileSync(path.join(project, "collect.mjs"), collector);
  fs.writeFileSync(path.join(project, "check.mjs"), checker);
  const configFile = path.join(project, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Benchmark fixture" },
      target: { kind: "command" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
      scoring: { minimumCoverage },
    }),
  );
  fs.writeFileSync(
    path.join(project, "spec.yaml"),
    YAML.stringify({
      id: "benchmark",
      title: "Benchmark",
      description: "Project-owned workload",
      weight: 100,
      scenarios: [
        {
          id: "WORKLOAD",
          name: "Measure",
          kind: "command",
          instructions: "Observe project workload",
          collect: {
            command: "node collect.mjs",
            methodFiles: ["collect.mjs"],
            sources: { subject: "subject.json" },
            files: ["measurements", "correctness"],
          },
        },
      ],
      rubric: [
        {
          id: "CORRECT",
          criterion: "Correct output",
          passCriteria: "Project oracle matches",
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
  const config = loadConfig(configFile),
    specs = loadSpecs(config.paths.specs);
  const records: CampaignRunRecord[] = [];
  for (let ordinal = 1; ordinal <= 2; ordinal++) {
    if (failed && ordinal === 2) {
      records.push({ ordinal, status: "failed", error: "Remote runner unavailable" });
      continue;
    }
    const result = await runEvaluation({ config, configFile, specs, fixtures: {} });
    records.push(campaignRunRecord(ordinal, result.runDir, result.report!));
  }
  const directory = path.join(root, `${id}-campaign`);
  writeCampaignArtifacts(
    directory,
    buildCampaignReport({
      campaignId: id,
      project: "Benchmark fixture",
      startedAt: new Date().toISOString(),
      plannedRepetitions: 2,
      runs: records,
    }),
  );
  return { directory, records, project, configFile };
}

test("benchmarks retain raw application/transport observations, identities, counts and correctness gates", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const candidate = await campaign(root, "candidate", {
    measurements: measurements("candidate", [5, 10]),
    valid: false,
  });
  const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
  assert.equal(report.validity.status, "compatible");
  assert.equal(report.outcome, "requirement_failure", "A faster incorrect candidate cannot pass");
  const time = report.measurements.find((metric) => metric.id === "time")!;
  assert.equal(time.baseline.mean, 15);
  assert.equal(time.candidate.mean, 7.5);
  assert.equal(time.delta, -7.5);
  assert.equal(time.relativeChangePct, -50);
  assert.equal(time.change, "improved");
  assert.deepEqual(time.candidate.runs[0]!.samples, [5, 10]);
  assert.equal(
    report.measurements.find((metric) => metric.id === "transport")!.baseline.mean,
    9000,
  );
  assert.equal(report.correctness.overall.criticalGatePassRate.candidate, 0);
  const observed = report.candidate.attempts[0]!;
  assert.ok("measurements" in observed && observed.measurements);
  assert.equal(observed.measurements.work.completed, 10);
  assert.equal(observed.measurements.candidate.id, "candidate");
  assert.equal(observed.correctnessEvidence.length, 1);
  assert.match(observed.correctnessEvidence[0]!.sha256, /^[a-f0-9]{64}$/);
  assert.ok("evaluator" in observed);
  const output = path.join(root, "comparison");
  writeBenchmarkComparison(output, report);
  assert.match(
    fs.readFileSync(path.join(output, "benchmark-comparison.html"), "utf8"),
    /requirement_failure/,
  );
  assert.ok(fs.existsSync(path.join(output, "correctness/campaign-comparison.html")));
});

test("benchmark validity withholds deltas for changed workloads, methods, environments and metric definitions", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const changes: Array<[string, (value: BenchmarkMeasurements) => void]> = [
    [
      "workload",
      (value) => {
        value.workload.sha256 = "c".repeat(64);
      },
    ],
    [
      "method",
      (value) => {
        value.method.sha256 = "c".repeat(64);
      },
    ],
    [
      "environment",
      (value) => {
        value.environment.concurrency = 2;
      },
    ],
    [
      "units",
      (value) => {
        value.metrics[0]!.unit = "seconds";
      },
    ],
    [
      "direction",
      (value) => {
        value.metrics[0]!.preferredDirection = "higher";
      },
    ],
    [
      "scope",
      (value) => {
        value.metrics[0]!.scope = "evaluation";
      },
    ],
    [
      "work-count",
      (value) => {
        value.work.requested = 20;
        value.work.completed = 20;
      },
    ],
  ];
  for (const [id, change] of changes) {
    const value = measurements(id);
    change(value);
    const candidate = await campaign(root, id, { measurements: value, valid: true });
    const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
    assert.equal(report.validity.status, "incompatible", id);
    assert.equal(report.outcome, "inconclusive", id);
    for (const metric of report.measurements) {
      assert.equal(metric.delta, null, id);
      assert.equal(metric.baseline.mean, null, id);
      assert.equal(metric.candidate.mean, null, id);
    }
  }
});

test("missing, blocked and partial work are inconclusive; failed repetitions and malformed evidence are errors", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const blocked = await campaign(root, "blocked", { omit: true, valid: true });
  const blockedReport = compareBenchmarkCampaigns(baseline.directory, blocked.directory, selection);
  assert.equal(blockedReport.outcome, "inconclusive");
  assert.equal(blockedReport.candidate.attempts.length, 2);
  assert.equal(blockedReport.measurements[0]!.candidate.mean, null);
  const value = measurements("partial");
  value.work.completed = 3;
  const partial = await campaign(root, "partial", { measurements: value, valid: true });
  assert.equal(
    compareBenchmarkCampaigns(baseline.directory, partial.directory, selection).outcome,
    "inconclusive",
  );
  const unavailable = measurements("unavailable");
  unavailable.metrics[0]!.observation = { state: "unavailable", reason: "GPU queries unsupported" };
  const missing = await campaign(root, "unavailable", { measurements: unavailable, valid: true });
  const missingReport = compareBenchmarkCampaigns(baseline.directory, missing.directory, selection);
  assert.equal(missingReport.outcome, "inconclusive");
  assert.equal(
    missingReport.measurements.find((metric) => metric.id === "time")!.candidate.mean,
    null,
  );
  const failed = await campaign(
    root,
    "failed",
    { measurements: measurements("failed"), valid: true },
    true,
  );
  const failedReport = compareBenchmarkCampaigns(baseline.directory, failed.directory, selection);
  assert.equal(failedReport.outcome, "execution_error");
  assert.equal(failedReport.candidate.attempts.length, 2);
  assert.equal(failedReport.candidate.attempts[1]!.status, "error");
  assert.ok(!Object.hasOwn(failedReport.candidate.attempts[1]!, "correctness"));
  const malformed = await campaign(root, "malformed", {
    measurements: { version: 1 },
    valid: true,
  });
  const malformedReport = compareBenchmarkCampaigns(
    baseline.directory,
    malformed.directory,
    selection,
  );
  assert.equal(malformedReport.outcome, "execution_error");
  assert.equal(malformedReport.measurements[0]!.delta, null);
  for (const label of ["missing", "measurements"]) {
    const unbound = measurements(`unbound-${label}`);
    unbound.correctness = [{ scenarioId: "WORKLOAD", fileLabel: label }];
    const candidate = await campaign(root, `unbound-${label}`, {
      measurements: unbound,
      valid: true,
    });
    const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
    assert.equal(report.outcome, "execution_error");
    assert.equal(report.candidate.attempts[0]!.status, "error");
    for (const metric of report.measurements) assert.equal(metric.delta, null);
  }
  const record = baseline.records[0]!;
  assert.equal(record.status, "complete");
  if (record.status === "complete") {
    const evidence = JSON.parse(
      fs.readFileSync(path.join(record.runDir, "WORKLOAD/evidence.json"), "utf8"),
    );
    fs.appendFileSync(path.join(record.runDir, "WORKLOAD", evidence.files[0].path), "tampered");
    assert.throws(() => loadBenchmarkRun(record.runDir, selection), /integrity|changed|match/i);
  }
});

test("measurement contracts reject fabricated or ambiguous observations", () => {
  const value = measurements("fixture");
  assert.equal(
    benchmarkMeasurementsSchema.safeParse({
      ...value,
      metrics: [{ ...value.metrics[0], observation: { state: "observed", samples: [] } }],
    }).success,
    false,
  );
  assert.equal(
    benchmarkMeasurementsSchema.safeParse({ ...value, work: { ...value.work, completed: 11 } })
      .success,
    false,
  );
  assert.equal(benchmarkMeasurementsSchema.safeParse({ ...value, environment: {} }).success, false);
  assert.equal(benchmarkMeasurementsSchema.safeParse({ ...value, correctness: [] }).success, false);
  assert.equal(
    benchmarkMeasurementsSchema.safeParse({
      ...value,
      metrics: [value.metrics[0], value.metrics[0]],
    }).success,
    false,
  );
});

test("correctness requires a gate citing the declared correctness file", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const candidate = await campaign(root, "uncited", {
    measurements: measurements("candidate"),
    valid: true,
    uncited: true,
  });
  const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
  assert.equal(report.outcome, "inconclusive");
  const attempt = report.candidate.attempts[0]!;
  assert.ok("correctness" in attempt);
  assert.equal(attempt.correctness.evidenceGateCount, 0);
  assert.equal(attempt.correctness.scorePct, null);
  assert.equal(attempt.correctness.scoreWithheld, true);
  assert.equal(attempt.correctness.coveragePct, 0);
  assert.equal(report.correctness.overall.completionRate.candidate, 1);
  assert.equal(report.correctness.overall.scoreMeanPct.candidate, null);
  assert.equal(report.correctness.overall.criticalGatePassRate.candidate, null);
  assert.equal(report.correctness.overall.evidenceCoverageMeanPct.candidate, 0);
});

test("benchmark reads require the seal even when tampered file metadata agrees", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const candidate = await campaign(root, "candidate", {
    measurements: measurements("candidate"),
    valid: true,
  });
  const record = candidate.records[0]!;
  assert.equal(record.status, "complete");
  if (record.status !== "complete") return;
  const reportFile = path.join(record.runDir, "report.json");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const file = report.areas[0].scenarios[0].files.find(
    (file: { label: string }) => file.label === "measurements",
  );
  const data = measurements("candidate", [0.01]);
  const bytes = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(record.runDir, "WORKLOAD", file.path), bytes);
  file.bytes = bytes.length;
  file.sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const evidenceFile = path.join(record.runDir, "WORKLOAD/evidence.json");
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
  Object.assign(
    evidence.files.find((entry: { label: string }) => entry.label === "measurements"),
    file,
  );
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  assert.throws(
    () => loadBenchmarkRun(record.runDir, selection),
    /Artifact integrity verification failed/,
  );
  const comparison = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
  assert.equal(comparison.outcome, "execution_error");
  assert.equal(comparison.candidate.attempts[0]!.status, "error");
  assert.equal(comparison.measurements[0]!.delta, null);
  const other = candidate.records[1]!;
  assert.equal(other.status, "complete");
  if (other.status === "complete") {
    fs.unlinkSync(path.join(other.runDir, "artifact-index.json"));
    assert.throws(() => loadBenchmarkRun(other.runDir, selection), /integrity/i);
  }
  const rejected = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
  assert.equal(rejected.correctness.candidate.completedRuns, 0);
  assert.equal(rejected.correctness.overall.completionRate.candidate, 0);
  assert.equal(rejected.correctness.overall.scoreMeanPct.candidate, null);
  assert.equal(rejected.correctness.overall.criticalGatePassRate.candidate, null);
  assert.equal(rejected.correctness.overall.evidenceCoverageMeanPct.candidate, null);
});

test("mismatched campaign records cannot publish correctness scores from rejected runs", async (t) => {
  const root = temporary(t);
  const baseline = await campaign(root, "baseline", {
    measurements: measurements("baseline"),
    valid: true,
  });
  const candidate = await campaign(root, "candidate", {
    measurements: measurements("candidate"),
    valid: true,
  });
  for (const record of candidate.records) {
    assert.equal(record.status, "complete");
    if (record.status === "complete") record.scorePct = 0;
  }
  writeCampaignArtifacts(
    candidate.directory,
    buildCampaignReport({
      campaignId: "candidate",
      project: "Benchmark fixture",
      startedAt: new Date().toISOString(),
      plannedRepetitions: 2,
      runs: candidate.records,
    }),
  );
  const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
  assert.equal(report.outcome, "execution_error");
  assert.equal(report.correctness.overall.scoreMeanPct.candidate, null);
  assert.equal(report.correctness.overall.criticalGatePassRate.candidate, null);
  assert.equal(report.correctness.overall.completionRate.candidate, 0);
  for (const attempt of report.candidate.attempts) {
    assert.equal(attempt.status, "error");
    assert.ok("error" in attempt && /does not match/.test(attempt.error));
  }
});

test("unproven negative verdicts remain inconclusive benchmark correctness", async (t) => {
  const root = temporary(t);
  for (const verdict of ["fail", "partial", "not_found"] as const) {
    const baseline = await campaign(
      root,
      `baseline-${verdict}`,
      {
        measurements: measurements("baseline"),
        valid: true,
      },
      false,
      verdict === "not_found" ? 0 : 100,
    );
    const candidate = await campaign(
      root,
      `candidate-${verdict}`,
      {
        measurements: measurements("candidate"),
        valid: true,
      },
      false,
      verdict === "not_found" ? 0 : 100,
    );
    // Build valid sealed scorer outputs, where an automatic negative verdict is
    // retained as unproven. Consumers must use the scorer's evidence decision.
    for (const side of [baseline, candidate]) {
      const config = loadConfig(side.configFile);
      const spec = loadSpecs(config.paths.specs)[0]!;
      spec.rubric.push({
        ...spec.rubric[0]!,
        id: "UNPROVEN",
        scenarios: ["BLOCKED"],
        grader: { type: "llm" },
      });
      if (verdict === "not_found") {
        const unproven = spec.rubric.at(-1)!;
        unproven.weight = 0.000001;
        unproven.gate = false;
      }
      for (const record of side.records) {
        assert.equal(record.status, "complete");
        if (record.status !== "complete") continue;
        const file = path.join(record.runDir, "report.json");
        const original = loadBenchmarkRun(record.runDir, selection).report;
        const area = original.areas[0]!;
        const blocked = {
          ...area.scenarios[0]!,
          scenarioId: "BLOCKED",
          outcome: "blocked" as const,
          files: [],
          summary: "Evidence unavailable",
        };
        const scored = scoreArea({
          config,
          spec,
          evidence: [...area.scenarios, blocked],
          judgements: [
            ...area.items,
            {
              id: "UNPROVEN",
              verdict: verdict as Verdict,
              confidence: "high",
              reasoning: "Negative automatic verdict without backing evidence",
              evidenceRefs: [],
              source: "llm",
            },
          ],
        });
        const updated = buildReport({
          config,
          runId: original.runId,
          startedAt: original.startedAt,
          areas: [scored],
          receipt: original.receipt,
        });
        fs.writeFileSync(file, JSON.stringify(updated));
        writeArtifactIndex(record.runDir);
        Object.assign(record, campaignRunRecord(record.ordinal, record.runDir, updated));
      }
      writeCampaignArtifacts(
        side.directory,
        buildCampaignReport({
          campaignId: path.basename(side.directory),
          project: "Benchmark fixture",
          startedAt: new Date().toISOString(),
          plannedRepetitions: 2,
          runs: side.records,
        }),
      );
    }
    const report = compareBenchmarkCampaigns(baseline.directory, candidate.directory, selection);
    assert.equal(report.outcome, "inconclusive");
    assert.equal(report.correctness.overall.scoreMeanPct.candidate, null);
    assert.equal(report.correctness.overall.criticalGatePassRate.candidate, null);
    for (const attempt of [...report.baseline.attempts, ...report.candidate.attempts]) {
      assert.ok("correctness" in attempt);
      assert.equal(attempt.correctness.state, "inconclusive");
      assert.equal(attempt.correctness.coveragePct, verdict === "not_found" ? 100 : 50);
      assert.equal(attempt.correctness.scorePct, null);
      if (verdict !== "not_found")
        assert.equal(
          attempt.correctness.gates.find((gate) => gate.itemId === "UNPROVEN")!.status,
          "unavailable",
        );
    }
  }
});
