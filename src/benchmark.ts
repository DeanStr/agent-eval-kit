import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadComparisonInput } from "./compare.js";
import {
  compareCampaigns,
  loadCampaign,
  writeCampaignComparisonArtifacts,
} from "./campaign-compare.js";
import { campaignRunRecord, buildCampaignReport, type CampaignRunRecord } from "./campaign.js";
import { readEvidenceFile } from "./evidence/files.js";
import { stableJson, writeJson } from "./io.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { escapeHtml } from "./report-presentation.js";
import { aggregateAreaMeasurements, belowPercentageThreshold } from "./score-slice.js";
import type { RunReport } from "./types.js";

const text = z.string().trim().min(1);
const identity = z.object({ id: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const metric = z
  .object({
    id: text,
    unit: text,
    preferredDirection: z.enum(["lower", "higher"]),
    scope: z.enum(["application", "remote_execution", "evaluation"]),
    observation: z.discriminatedUnion("state", [
      z.object({ state: z.literal("observed"), samples: z.array(z.number()).min(1) }).strict(),
      z.object({ state: z.literal("unavailable"), reason: text }).strict(),
    ]),
  })
  .strict();

/** Project-owned measurement scripts publish this as an ordinary retained file. */
export const benchmarkMeasurementsSchema = z
  .object({
    version: z.literal(1),
    candidate: z.object({ id: text, revision: text }).strict(),
    workload: identity,
    method: identity,
    // The project declares all relevant application/remote settings, including
    // hardware/runtime, cache policy, concurrency, seeds, and service region.
    environment: z
      .record(text, z.union([text, z.number(), z.boolean()]))
      .refine((value) => Object.keys(value).length > 0, "Declare relevant environment settings"),
    work: z
      .object({
        unit: text,
        requested: z.number().int().positive(),
        completed: z.number().int().nonnegative(),
      })
      .strict(),
    outcome: z.discriminatedUnion("state", [
      z.object({ state: z.literal("completed") }).strict(),
      z.object({ state: z.literal("blocked"), reason: text }).strict(),
    ]),
    metrics: z.array(metric).min(1),
    correctness: z.array(z.object({ scenarioId: text, fileLabel: text }).strict()),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.work.completed > value.work.requested)
      context.addIssue({ code: "custom", message: "completed work exceeds requested work" });
    if (new Set(value.metrics.map((metric) => metric.id)).size !== value.metrics.length)
      context.addIssue({ code: "custom", message: "Duplicate metric ids" });
    if (value.outcome.state === "completed" && !value.correctness.length)
      context.addIssue({
        code: "custom",
        message: "Completed measurements require correctness evidence",
      });
  });

export type BenchmarkMeasurements = z.infer<typeof benchmarkMeasurementsSchema>;
export interface BenchmarkSelection {
  scenarioId: string;
  fileLabel: string;
}

function correctness(report: RunReport, evidenceRefs: string[]) {
  const gates = report.areas.flatMap((area) =>
    area.gates.map((gate) => ({ areaId: area.id, ...gate })),
  );
  const linkedGates = report.areas.flatMap((area) =>
    area.gates.filter((gate) =>
      area.items
        .find((item) => item.id === gate.itemId)
        ?.evidenceRefs.some((ref) => evidenceRefs.includes(ref)),
    ),
  );
  const state =
    gates.some((gate) => gate.status === "failed") ||
    report.areas.some((area) =>
      area.items.some(
        (item) =>
          !area.unproven.includes(item.id) &&
          ["fail", "partial", "not_found"].includes(item.verdict),
      ),
    )
      ? ("requirement_failure" as const)
      : !linkedGates.length ||
          gates.some((gate) => gate.status === "unavailable") ||
          report.scoreWithheld ||
          belowPercentageThreshold(aggregateAreaMeasurements(report.areas).coveragePct, 100)
        ? ("inconclusive" as const)
        : ("pass" as const);
  const scoreWithheld = report.scoreWithheld || state === "inconclusive" || !linkedGates.length;
  return {
    state,
    gates,
    evidenceGateCount: linkedGates.length,
    coveragePct: linkedGates.length ? report.overallCoveragePct : 0,
    scorePct: scoreWithheld ? null : report.overallScorePct,
    scoreWithheld,
  };
}

/** Reads sealed evidence only. Never starts candidates, workloads, or graders. */
export function loadBenchmarkRun(run: string, selection: BenchmarkSelection) {
  const { report, file } = loadComparisonInput(run);
  const directory = path.dirname(file);
  assertArtifactIntegrity(directory, { require: true });
  const scenarios = report.areas.flatMap((area) => area.scenarios);
  const scenario = scenarios.find((entry) => entry.scenarioId === selection.scenarioId);
  if (!scenario) throw new Error(`Benchmark scenario is absent: ${selection.scenarioId}`);
  const measurementFile = scenario.files?.find((entry) => entry.label === selection.fileLabel);
  let measurements: BenchmarkMeasurements | null = null;
  let reason: string | undefined;
  const correctnessEvidence = [];
  if (!measurementFile) {
    if (scenario.outcome !== "blocked")
      throw new Error(`Missing benchmark measurement file: ${selection.fileLabel}`);
    reason = scenario.summary;
  } else {
    measurements = benchmarkMeasurementsSchema.parse(
      JSON.parse(
        readEvidenceFile(path.join(directory, scenario.scenarioId), measurementFile).toString(
          "utf8",
        ),
      ),
    );
    if (scenario.outcome === "blocked" && measurements.outcome.state !== "blocked")
      throw new Error("Blocked collection cannot claim completed benchmark measurements");
    for (const reference of measurements.correctness) {
      const source = scenarios.find((entry) => entry.scenarioId === reference.scenarioId);
      const evidence = source?.files?.find((entry) => entry.label === reference.fileLabel);
      if (!source || !evidence)
        throw new Error(
          `Missing benchmark correctness evidence: ${reference.scenarioId}/${reference.fileLabel}`,
        );
      if (source === scenario && evidence === measurementFile)
        throw new Error("Benchmark measurements must reference separate correctness evidence");
      readEvidenceFile(path.join(directory, source.scenarioId), evidence);
      correctnessEvidence.push({
        ref: `${source.scenarioId}/${evidence.path}`,
        sha256: evidence.sha256,
        bytes: evidence.bytes,
      });
    }
    if (measurements.outcome.state === "blocked") reason = measurements.outcome.reason;
    else if (measurements.work.completed !== measurements.work.requested)
      reason = "Workload completed only part of the requested work";
  }
  return {
    report,
    measurements,
    reason,
    correctness: correctness(
      report,
      correctnessEvidence.map((evidence) => evidence.ref),
    ),
    correctnessEvidence,
    // Harness duration includes collection and judging; never application time.
    evaluationDurationMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
    evaluator: report.receipt.evaluationFingerprint,
    target: report.receipt.target,
    runtime: {
      node: report.receipt.runtime.node,
      platform: report.receipt.runtime.platform,
      arch: report.receipt.runtime.arch,
    },
  };
}

function loadSide(input: string, selection: BenchmarkSelection) {
  const { report } = loadCampaign(input);
  const attempts = report.runs.map((record) => {
    if (record.status === "failed")
      return {
        ordinal: record.ordinal,
        status: "error" as const,
        runDir: record.runDir,
        error: record.error,
      };
    try {
      const loaded = loadBenchmarkRun(record.runDir, selection);
      if (
        stableJson(campaignRunRecord(record.ordinal, record.runDir, loaded.report)) !==
        stableJson(record)
      )
        throw new Error("Campaign record does not match its sealed run");
      const { report: _report, ...observation } = loaded;
      return {
        ordinal: record.ordinal,
        runDir: record.runDir,
        status: loaded.reason ? ("blocked" as const) : ("observed" as const),
        ...observation,
      };
    } catch (error) {
      return {
        ordinal: record.ordinal,
        runDir: record.runDir,
        status: "error" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  // Correctness aggregates may use only the runs accepted above. A rejected
  // sealed run must not retain its original score or gates through its campaign.
  const runs: CampaignRunRecord[] = report.runs.map((record, index) => {
    const attempt = attempts[index]!;
    if (attempt.status === "error")
      return {
        ordinal: record.ordinal,
        status: "failed",
        error: attempt.error,
        ...(record.runDir ? { runDir: record.runDir } : {}),
      };
    if (record.status === "complete" && attempt.correctness.scoreWithheld) {
      // The evaluation completed, but none of its grading proves the declared
      // benchmark outputs. Keep completion distinct from correctness coverage.
      const { gatesPassed: _gatesPassed, ...unscored } = record;
      const noProof = attempt.correctness.evidenceGateCount === 0;
      return {
        ...unscored,
        ...(!noProof &&
        attempt.correctness.state === "requirement_failure" &&
        record.gatesPassed !== undefined
          ? { gatesPassed: record.gatesPassed }
          : {}),
        scorePct: null,
        scoreWithheld: true,
        coveragePct: attempt.correctness.coveragePct,
        items: noProof
          ? record.items.map((item) => ({ ...item, verdict: "cannot_judge" as const }))
          : record.items,
        cases: noProof
          ? record.cases.map((item) => ({
              ...item,
              verdict: "cannot_judge" as const,
              points: null,
            }))
          : record.cases,
      };
    }
    return record;
  });
  return {
    campaign: buildCampaignReport({
      campaignId: report.campaignId,
      project: report.project,
      startedAt: report.startedAt,
      plannedRepetitions: report.plannedRepetitions,
      runs,
    }),
    attempts,
  };
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value / values.length, 0);

/** Compare existing campaigns and retain every repetition, including errors. */
export function compareBenchmarkCampaigns(
  baseline: string,
  candidate: string,
  selection: BenchmarkSelection,
) {
  const before = loadSide(baseline, selection),
    after = loadSide(candidate, selection);
  const correctnessComparison = compareCampaigns(before.campaign, after.campaign);
  const attempts = [...before.attempts, ...after.attempts];
  const observations = attempts.flatMap((attempt) =>
    "measurements" in attempt && attempt.measurements ? [attempt] : [],
  );
  const incompatible: string[] = [];
  const unavailable: string[] = [];
  if (correctnessComparison.compatibility.status === "incompatible")
    incompatible.push(...correctnessComparison.compatibility.reasons);
  else if (correctnessComparison.compatibility.status !== "compatible")
    unavailable.push(...correctnessComparison.compatibility.reasons);
  for (const [label, side] of [
    ["baseline", before],
    ["candidate", after],
  ] as const) {
    if (side.campaign.coverage.pendingRuns)
      unavailable.push(`${label} has unattempted repetitions`);
    if (side.attempts.some((attempt) => attempt.status !== "observed"))
      unavailable.push(`${label} has missing, blocked, partial-work, or erroneous observations`);
    const identities = side.attempts.flatMap((attempt) =>
      "measurements" in attempt && attempt.measurements
        ? [stableJson(attempt.measurements.candidate)]
        : [],
    );
    if (new Set(identities).size > 1)
      incompatible.push(`${label} candidate identity changed between repetitions`);
  }
  const first = observations[0];
  if (!first) unavailable.push("No measurement observations are available");
  else {
    // Candidate/target identity is deliberately excluded from method identity.
    for (const field of ["workload", "method", "environment"] as const)
      if (
        observations.some(
          (attempt) =>
            stableJson(attempt.measurements![field]) !== stableJson(first.measurements![field]),
        )
      )
        incompatible.push(`Benchmark ${field} differs`);
    if (observations.some((attempt) => stableJson(attempt.runtime) !== stableJson(first.runtime)))
      incompatible.push("AEK collection runtime differs");
    const work = (value: BenchmarkMeasurements) => ({
      unit: value.work.unit,
      requested: value.work.requested,
    });
    if (
      observations.some(
        (attempt) =>
          stableJson(work(attempt.measurements!)) !== stableJson(work(first.measurements!)),
      )
    )
      incompatible.push("Requested workload counts or work units differ");
    const definitions = (value: BenchmarkMeasurements) =>
      value.metrics
        .map(({ observation: _observation, ...definition }) => definition)
        .sort((a, b) => a.id.localeCompare(b.id));
    if (
      observations.some(
        (attempt) =>
          stableJson(definitions(attempt.measurements!)) !==
          stableJson(definitions(first.measurements!)),
      )
    )
      incompatible.push("Metric ids, units, preferred directions, or timing scopes differ");
  }
  const status = incompatible.length
    ? ("incompatible" as const)
    : unavailable.length
      ? ("inconclusive" as const)
      : ("compatible" as const);
  const ids = [
    ...new Set(
      observations.flatMap((attempt) => attempt.measurements!.metrics.map((metric) => metric.id)),
    ),
  ].sort();
  const measurements = ids.map((id) => {
    const summarize = (side: typeof before) => {
      const runs = side.attempts.flatMap((attempt) => {
        if (!("measurements" in attempt) || !attempt.measurements) return [];
        const metric = attempt.measurements.metrics.find((metric) => metric.id === id);
        if (!metric || metric.observation.state !== "observed") return [];
        return [
          {
            ordinal: attempt.ordinal,
            samples: metric.observation.samples,
            mean: average(metric.observation.samples),
          },
        ];
      });
      return {
        observedRuns: runs.length,
        attemptedRuns: side.attempts.length,
        plannedRuns: side.campaign.plannedRepetitions,
        mean:
          status === "compatible" && runs.length === side.campaign.plannedRepetitions
            ? average(runs.map((run) => run.mean))
            : null,
        runs,
      };
    };
    const baseline = summarize(before),
      candidate = summarize(after);
    const definition = observations
      .flatMap((attempt) => attempt.measurements!.metrics)
      .find((metric) => metric.id === id)!;
    const { observation: _observation, ...metadata } = definition;
    const complete =
      status === "compatible" &&
      baseline.observedRuns === baseline.plannedRuns &&
      candidate.observedRuns === candidate.plannedRuns;
    const delta =
      complete && baseline.mean !== null && candidate.mean !== null
        ? candidate.mean - baseline.mean
        : null;
    return {
      ...metadata,
      baseline,
      candidate,
      delta,
      relativeChangePct:
        delta === null || baseline.mean === null || baseline.mean === 0
          ? null
          : (delta / Math.abs(baseline.mean)) * 100,
      change:
        delta === null
          ? "unavailable"
          : delta === 0
            ? "unchanged"
            : delta < 0 === (definition.preferredDirection === "lower")
              ? "improved"
              : "regressed",
      ...(delta === null
        ? {
            reason: [
              ...incompatible,
              ...unavailable,
              ...(!complete ? ["Every planned repetition must supply this metric"] : []),
            ].join("; "),
          }
        : {}),
    };
  });
  const executionErrors = attempts.some((attempt) => attempt.status === "error");
  const requirementFailure = attempts.some(
    (attempt) => "correctness" in attempt && attempt.correctness.state === "requirement_failure",
  );
  const inconclusive =
    status !== "compatible" ||
    measurements.some((metric) => metric.delta === null) ||
    attempts.some(
      (attempt) => "correctness" in attempt && attempt.correctness.state === "inconclusive",
    );
  return {
    schemaVersion: 1 as const,
    outcome: executionErrors
      ? ("execution_error" as const)
      : requirementFailure
        ? ("requirement_failure" as const)
        : inconclusive
          ? ("inconclusive" as const)
          : ("compared" as const),
    validity: { status, reasons: [...incompatible, ...unavailable] },
    baseline: {
      campaignId: before.campaign.campaignId,
      attempts: before.attempts,
      pendingRuns: before.campaign.coverage.pendingRuns,
    },
    candidate: {
      campaignId: after.campaign.campaignId,
      attempts: after.attempts,
      pendingRuns: after.campaign.coverage.pendingRuns,
    },
    measurements,
    correctness: correctnessComparison,
    limitation:
      "Descriptive means weight each run equally. Samples within one run are not independent repetitions. Application measurements exclude harness and remote-execution overhead; correctness gates are project-owned. No automatic performance acceptance threshold or superiority claim is inferred.",
  };
}

export function writeBenchmarkComparison(
  directory: string,
  report: ReturnType<typeof compareBenchmarkCampaigns>,
) {
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "benchmark-comparison.json"), report);
  writeCampaignComparisonArtifacts(path.join(directory, "correctness"), report.correctness);
  const rows = report.measurements
    .map(
      (metric) =>
        `<tr><td>${escapeHtml(metric.id)}</td><td>${escapeHtml(metric.scope)}</td><td>${escapeHtml(metric.unit)} (${metric.preferredDirection})</td><td>${metric.baseline.mean ?? "unavailable"}</td><td>${metric.candidate.mean ?? "unavailable"}</td><td>${metric.delta ?? "unavailable"}</td><td>${metric.relativeChangePct ?? "unavailable"}</td><td>${escapeHtml(metric.reason ?? metric.change)}</td></tr>`,
    )
    .join("");
  const attempts = (["baseline", "candidate"] as const)
    .flatMap((side) =>
      report[side].attempts.map(
        (attempt) =>
          `<tr><td>${side} ${attempt.ordinal}</td><td>${attempt.status}</td><td>${"measurements" in attempt && attempt.measurements ? `${attempt.measurements.work.completed}/${attempt.measurements.work.requested} ${escapeHtml(attempt.measurements.work.unit)}` : "unavailable"}</td><td>${"correctness" in attempt ? escapeHtml(attempt.correctness.state) : "unavailable"}</td><td>${"evaluationDurationMs" in attempt ? attempt.evaluationDurationMs : "unavailable"}</td><td>${escapeHtml(("error" in attempt ? attempt.error : attempt.reason) ?? "")}</td></tr>`,
      ),
    )
    .join("");
  fs.writeFileSync(
    path.join(directory, "benchmark-comparison.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>Benchmark comparison</title><style>body{font:15px/1.5 system-ui;max-width:1200px;margin:2rem auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.5rem}</style></head><body><h1>Benchmark comparison</h1><p>${report.outcome} · measurement validity: ${report.validity.status}</p><p>${escapeHtml(report.validity.reasons.join("; "))}</p><p><a href="benchmark-comparison.json">Raw observations and identities</a> · <a href="correctness/campaign-comparison.html">Correctness gates, coverage, and changes</a></p><table><thead><tr><th>Metric</th><th>Scope</th><th>Unit (preferred)</th><th>Baseline mean</th><th>Candidate mean</th><th>Change</th><th>Change %</th><th>Interpretation</th></tr></thead><tbody>${rows}</tbody></table><h2>Every attempt</h2><table><thead><tr><th>Attempt</th><th>Status</th><th>Completed work</th><th>Correctness</th><th>AEK duration (ms)</th><th>Diagnostic</th></tr></thead><tbody>${attempts}</tbody></table><p>Unattempted: baseline ${report.baseline.pendingRuns}; candidate ${report.candidate.pendingRuns}.</p><p>${escapeHtml(report.limitation)}</p></body></html>`,
  );
}
