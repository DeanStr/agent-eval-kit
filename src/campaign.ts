import fs from "node:fs";
import path from "node:path";
import { createTimestampedDirectory, writeJson } from "./io.js";
import type { EvalConfig, RunReport, Verdict } from "./types.js";

type Measurement<T> =
  | { state: "observed"; value: T; evidence: { availableRuns: number; totalRuns: number } }
  | { state: "unavailable"; value: null; reason: string };

export interface Distribution {
  mean: number;
  median: number;
  minimum: number;
  maximum: number;
  standardDeviation: number;
  confidenceInterval95: {
    lower: number;
    upper: number;
    method: "deterministic_percentile_run_bootstrap";
    resamplingUnit: "complete evaluation run";
    resamples: 2_000;
  } | null;
}

export interface CompleteCampaignRunRecord {
  ordinal: number;
  status: "complete";
  runId: string;
  runDir: string;
  evaluationFingerprint: string;
  inputFingerprint: string;
  scorePct: number | null;
  coveragePct: number;
  scoreWithheld: boolean;
  gatesPassed?: boolean;
  items: Array<{ areaId: string; itemId: string; verdict: Verdict }>;
  cases: Array<{
    areaId: string;
    rubricId: string;
    caseId: string;
    strata: string[];
    split?: "development" | "evaluation";
    verdict: Verdict;
    points: number | null;
  }>;
}

export interface FailedCampaignRunRecord {
  ordinal: number;
  status: "failed";
  error: string;
}

export type CampaignRunRecord = CompleteCampaignRunRecord | FailedCampaignRunRecord;

const campaignVerdicts = new Set<Verdict>(["pass", "partial", "fail", "not_found", "cannot_judge"]);

export function assertCampaignRunRecords(value: unknown): asserts value is CampaignRunRecord[] {
  if (!Array.isArray(value)) throw new Error("Campaign runs must be an array");
  const ordinals = new Set<number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") throw new Error("Campaign run records must be objects");
    const run = candidate as Record<string, unknown>;
    if (!Number.isInteger(run.ordinal) || Number(run.ordinal) < 1 || ordinals.has(Number(run.ordinal))) {
      throw new Error(`Campaign contains an invalid or duplicate run ordinal: ${String(run.ordinal)}`);
    }
    ordinals.add(Number(run.ordinal));
    if (run.status === "failed") {
      if (typeof run.error !== "string" || !run.error.trim()) {
        throw new Error(`Failed campaign run ${run.ordinal} requires an error message`);
      }
      continue;
    }
    if (run.status !== "complete") throw new Error(`Campaign run ${run.ordinal} has invalid status ${String(run.status)}`);
    if (
      typeof run.runId !== "string" || !run.runId || typeof run.runDir !== "string" || !run.runDir ||
      typeof run.evaluationFingerprint !== "string" || !run.evaluationFingerprint ||
      typeof run.inputFingerprint !== "string" || !run.inputFingerprint ||
      (run.scorePct !== null && (typeof run.scorePct !== "number" || !Number.isFinite(run.scorePct))) ||
      typeof run.coveragePct !== "number" || !Number.isFinite(run.coveragePct) ||
      typeof run.scoreWithheld !== "boolean" || !Array.isArray(run.items) || !Array.isArray(run.cases)
    ) {
      throw new Error(`Complete campaign run ${run.ordinal} is missing required v1 measurements or identity`);
    }
    if (run.gatesPassed !== undefined && typeof run.gatesPassed !== "boolean") {
      throw new Error(`Complete campaign run ${run.ordinal} has invalid gate status`);
    }
    if (run.items.some((item) =>
      !item || typeof item !== "object" || typeof item.areaId !== "string" ||
      typeof item.itemId !== "string" || !campaignVerdicts.has(item.verdict as Verdict)
    )) {
      throw new Error(`Complete campaign run ${run.ordinal} has invalid item measurements`);
    }
    if (run.cases.some((item) =>
      !item || typeof item !== "object" || typeof item.areaId !== "string" ||
      typeof item.rubricId !== "string" || typeof item.caseId !== "string" ||
      !Array.isArray(item.strata) || !campaignVerdicts.has(item.verdict as Verdict) ||
      (item.points !== null && (typeof item.points !== "number" || !Number.isFinite(item.points)))
    )) {
      throw new Error(`Complete campaign run ${run.ordinal} has invalid case measurements`);
    }
  }
}

export interface CampaignReport {
  schemaVersion: 1;
  campaignId: string;
  project: string;
  status: "running" | "complete";
  startedAt: string;
  updatedAt: string;
  plannedRepetitions: number;
  compatibility: {
    status: "compatible" | "incompatible" | "unknown";
    evaluationFingerprint?: string;
    fingerprints: string[];
    inputFingerprint?: string;
    inputFingerprints: string[];
  };
  coverage: { completedRuns: number; failedRuns: number; pendingRuns: number };
  scorePct: Measurement<Distribution>;
  evidenceCoveragePct: Measurement<Distribution>;
  criticalGatePassRate: Measurement<number>;
  itemStability: Array<{
    areaId: string;
    itemId: string;
    observedRuns: number;
    verdicts: Record<Verdict, number>;
    fullPassRate: number;
  }>;
  caseStability: Array<{
    areaId: string;
    rubricId: string;
    caseId: string;
    strata: string[];
    split?: "development" | "evaluation";
    observedRuns: number;
    verdicts: Record<Verdict, number>;
    fullPassRate: number;
  }>;
  stratumStability: Array<{
    stratum: string;
    observations: number;
    verdicts: Record<Verdict, number>;
    fullPassRate: number;
  }>;
  runs: CampaignRunRecord[];
  limitations: string[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function seedFromText(text: string): number {
  let seed = 2_166_136_261;
  for (const character of text) {
    seed ^= character.codePointAt(0)!;
    seed = Math.imul(seed, 16_777_619);
  }
  return seed >>> 0;
}

function randomGenerator(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(values: number[], seed: string): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  let confidenceInterval95: Distribution["confidenceInterval95"] = null;
  if (values.length > 1) {
    const random = randomGenerator(seedFromText(seed));
    const means: number[] = [];
    for (let iteration = 0; iteration < 2_000; iteration++) {
      let total = 0;
      for (let sample = 0; sample < values.length; sample++) {
        total += values[Math.floor(random() * values.length)];
      }
      means.push(total / values.length);
    }
    means.sort((left, right) => left - right);
    confidenceInterval95 = {
      lower: round(percentile(means, 0.025)),
      upper: round(percentile(means, 0.975)),
      method: "deterministic_percentile_run_bootstrap",
      resamplingUnit: "complete evaluation run",
      resamples: 2_000,
    };
  }
  return {
    mean: round(mean),
    median: round(percentile(sorted, 0.5)),
    minimum: round(sorted[0]),
    maximum: round(sorted.at(-1)!),
    standardDeviation: round(Math.sqrt(variance)),
    confidenceInterval95,
  };
}

function measuredDistribution(values: number[], totalRuns: number, seed: string, unavailableReason: string): Measurement<Distribution> {
  return values.length
    ? { state: "observed", value: distribution(values, seed), evidence: { availableRuns: values.length, totalRuns } }
    : { state: "unavailable", value: null, reason: unavailableReason };
}

export function campaignRunRecord(ordinal: number, runDir: string, report: RunReport): CompleteCampaignRunRecord {
  const areaGates = report.areas.flatMap((area) => area.gates);
  const cases = report.areas.flatMap((area) => area.caseResults.map((item) => {
    if (item.points === undefined) {
      throw new Error(`Scored report case ${area.id}/${item.rubricId}/${item.caseId} is missing points`);
    }
    return {
      areaId: area.id,
      rubricId: item.rubricId,
      caseId: item.caseId,
      strata: item.strata,
      split: item.split,
      verdict: area.unproven.includes(item.rubricId) ? "cannot_judge" as const : item.verdict,
      points: area.unproven.includes(item.rubricId) ? null : item.points,
    };
  }));
  return {
    ordinal,
    status: "complete",
    runId: report.runId,
    runDir: path.resolve(runDir),
    evaluationFingerprint: report.receipt.evaluationFingerprint,
    inputFingerprint: report.receipt.inputFingerprint,
    scorePct: report.overallScorePct,
    coveragePct: report.overallCoveragePct,
    scoreWithheld: report.scoreWithheld,
    gatesPassed: areaGates.length
      ? report.gates.passed
      : undefined,
    items: report.areas.flatMap((area) => area.items.map((item) => ({
      areaId: area.id,
      itemId: item.id,
      verdict: area.unproven.includes(item.id) ? "cannot_judge" : item.verdict,
    }))),
    cases,
  };
}

export function buildCampaignReport(options: {
  campaignId: string;
  project: string;
  startedAt: string;
  plannedRepetitions: number;
  runs: CampaignRunRecord[];
}): CampaignReport {
  assertCampaignRunRecords(options.runs);
  const complete = options.runs.filter((run) => run.status === "complete");
  const fingerprints = [...new Set(complete.map((run) => run.evaluationFingerprint))].sort();
  const inputFingerprints = [...new Set(complete.map((run) => run.inputFingerprint))].sort();
  const compatibility = complete.length === 0
    ? { status: "unknown" as const, fingerprints, inputFingerprints }
    : fingerprints.length > 1 || inputFingerprints.length > 1
      ? { status: "incompatible" as const, fingerprints, inputFingerprints }
      : {
          status: "compatible" as const,
          evaluationFingerprint: fingerprints[0],
          fingerprints,
          inputFingerprint: inputFingerprints[0],
          inputFingerprints,
        };
  const scores = complete.flatMap((run) => !run.scoreWithheld && typeof run.scorePct === "number" ? [run.scorePct] : []);
  const coverages = complete.map((run) => run.coveragePct);
  const gates = complete.flatMap((run) => typeof run.gatesPassed === "boolean" ? [run.gatesPassed] : []);
  const byItem = new Map<string, { areaId: string; itemId: string; verdicts: Record<Verdict, number>; observedRuns: number }>();
  for (const run of complete) {
    for (const item of run.items) {
      const key = `${item.areaId}\0${item.itemId}`;
      let aggregate = byItem.get(key);
      if (!aggregate) {
        aggregate = {
          areaId: item.areaId,
          itemId: item.itemId,
          observedRuns: 0,
          verdicts: { pass: 0, partial: 0, fail: 0, not_found: 0, cannot_judge: 0 },
        };
        byItem.set(key, aggregate);
      }
      aggregate.observedRuns += 1;
      aggregate.verdicts[item.verdict] += 1;
    }
  }
  const itemStability = [...byItem.values()]
    .map((item) => ({ ...item, fullPassRate: round(item.verdicts.pass / item.observedRuns) }))
    .sort((left, right) => left.areaId.localeCompare(right.areaId) || left.itemId.localeCompare(right.itemId));
  const emptyVerdicts = (): Record<Verdict, number> => ({ pass: 0, partial: 0, fail: 0, not_found: 0, cannot_judge: 0 });
  const byCase = new Map<string, {
    areaId: string; rubricId: string; caseId: string; strata: string[];
    split?: "development" | "evaluation"; observedRuns: number; verdicts: Record<Verdict, number>;
  }>();
  const byStratum = new Map<string, { stratum: string; observations: number; verdicts: Record<Verdict, number> }>();
  for (const run of complete) {
    for (const item of run.cases) {
      const key = `${item.areaId}\0${item.rubricId}\0${item.caseId}`;
      let aggregate = byCase.get(key);
      if (!aggregate) {
        aggregate = { ...item, observedRuns: 0, verdicts: emptyVerdicts() };
        byCase.set(key, aggregate);
      }
      aggregate.observedRuns += 1;
      aggregate.verdicts[item.verdict] += 1;
      for (const stratum of new Set(item.strata)) {
        let stratumAggregate = byStratum.get(stratum);
        if (!stratumAggregate) {
          stratumAggregate = { stratum, observations: 0, verdicts: emptyVerdicts() };
          byStratum.set(stratum, stratumAggregate);
        }
        stratumAggregate.observations += 1;
        stratumAggregate.verdicts[item.verdict] += 1;
      }
    }
  }
  const caseStability = [...byCase.values()]
    .map((item) => ({ ...item, fullPassRate: round(item.verdicts.pass / item.observedRuns) }))
    .sort((left, right) => left.areaId.localeCompare(right.areaId) || left.rubricId.localeCompare(right.rubricId) || left.caseId.localeCompare(right.caseId));
  const stratumStability = [...byStratum.values()]
    .map((item) => ({ ...item, fullPassRate: round(item.verdicts.pass / item.observations) }))
    .sort((left, right) => left.stratum.localeCompare(right.stratum));
  const total = options.plannedRepetitions;
  const compatible = compatibility.status === "compatible";
  return {
    schemaVersion: 1,
    campaignId: options.campaignId,
    project: options.project,
    status: options.runs.length >= total ? "complete" : "running",
    startedAt: options.startedAt,
    updatedAt: new Date().toISOString(),
    plannedRepetitions: total,
    compatibility,
    coverage: {
      completedRuns: complete.length,
      failedRuns: options.runs.filter((run) => run.status === "failed").length,
      pendingRuns: Math.max(0, total - options.runs.length),
    },
    scorePct: compatible
      ? measuredDistribution(scores, total, `${fingerprints[0]}:score`, "No run produced a comparable, non-withheld score")
      : { state: "unavailable", value: null, reason: `Campaign evaluator compatibility is ${compatibility.status}` },
    evidenceCoveragePct: compatible
      ? measuredDistribution(coverages, total, `${fingerprints[0]}:coverage`, "No completed run reported evidence coverage")
      : { state: "unavailable", value: null, reason: `Campaign evaluator compatibility is ${compatibility.status}` },
    criticalGatePassRate: !compatible
      ? { state: "unavailable", value: null, reason: `Campaign evaluator compatibility is ${compatibility.status}` }
      : gates.length
        ? { state: "observed", value: round(gates.filter(Boolean).length / gates.length), evidence: { availableRuns: gates.length, totalRuns: total } }
        : { state: "unavailable", value: null, reason: "No completed run reported critical-gate status" },
    itemStability: compatible ? itemStability : [],
    caseStability: compatible ? caseStability : [],
    stratumStability: compatible ? stratumStability : [],
    runs: [...options.runs].sort((left, right) => left.ordinal - right.ordinal),
    limitations: [
      "Bootstrap intervals are descriptive estimates over completed evaluation runs; small repetition counts are inherently unstable.",
      "Failed and score-withheld runs are reported in coverage but excluded from the score distribution.",
      "AEK does not reset external target data between repetitions; shared mutable state can make repetitions dependent.",
    ],
  };
}

export function createCampaignDirectory(config: EvalConfig, output?: string): string {
  if (output) {
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    try {
      // A user-selected campaign path must also be exclusively reserved; an
      // existing empty directory is not safe under concurrent invocations.
      fs.mkdirSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Campaign output directory already exists: ${resolved}`);
      }
      throw error;
    }
    return resolved;
  }
  const root = path.join(path.dirname(config.paths.runs), "campaigns");
  return createTimestampedDirectory(root);
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const metricText = (measurement: Measurement<Distribution>) => measurement.state === "observed"
  ? `${measurement.value.mean}% mean · ${measurement.value.minimum}–${measurement.value.maximum}% range · σ ${measurement.value.standardDeviation}${measurement.value.confidenceInterval95 ? ` · 95% bootstrap ${measurement.value.confidenceInterval95.lower}–${measurement.value.confidenceInterval95.upper}%` : ""}`
  : `Unavailable: ${measurement.reason}`;

export function writeCampaignArtifacts(directory: string, report: CampaignReport): { json: string; html: string } {
  const json = path.join(directory, "campaign.json");
  const html = path.join(directory, "campaign.html");
  writeJson(json, report);
  const runRows = report.runs.map((run) => run.status === "complete"
    ? `<tr><td>${run.ordinal}</td><td>complete</td><td>${escapeHtml(run.runId)}</td><td>${run.scoreWithheld ? "withheld" : run.scorePct ?? "—"}</td><td>${run.coveragePct}</td><td>${run.gatesPassed === undefined ? "—" : run.gatesPassed ? "pass" : "fail"}</td><td></td></tr>`
    : `<tr><td>${run.ordinal}</td><td>failed</td><td>—</td><td>—</td><td>—</td><td>—</td><td>${escapeHtml(run.error)}</td></tr>`,
  ).join("");
  const itemRows = report.itemStability.map((item) => `<tr><td>${escapeHtml(item.areaId)}</td><td>${escapeHtml(item.itemId)}</td><td>${item.fullPassRate * 100}%</td><td>${Object.entries(item.verdicts).map(([verdict, count]) => `${escapeHtml(verdict)} ${count}`).join(" · ")}</td></tr>`).join("");
  const caseRows = report.caseStability.map((item) => `<tr><td>${escapeHtml(item.areaId)}</td><td>${escapeHtml(item.rubricId)}</td><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.strata.join(", ") || "—")}</td><td>${item.fullPassRate * 100}%</td><td>${item.observedRuns}</td></tr>`).join("");
  const stratumRows = report.stratumStability.map((item) => `<tr><td>${escapeHtml(item.stratum)}</td><td>${item.fullPassRate * 100}%</td><td>${item.observations}</td></tr>`).join("");
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(report.project)} campaign</title><style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;max-width:1100px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .65rem;text-align:left}th{background:#f6f8fa}.warn{color:#cf222e;font-weight:650}code{font-size:.9em}</style></head><body><h1>${escapeHtml(report.project)} repeated evaluation campaign</h1><p><code>${escapeHtml(report.campaignId)}</code> · ${report.coverage.completedRuns}/${report.plannedRepetitions} completed · evaluator and target inputs <strong class="${report.compatibility.status === "compatible" ? "" : "warn"}">${report.compatibility.status}</strong></p><h2>Score</h2><p>${escapeHtml(metricText(report.scorePct))}</p><h2>Evidence coverage</h2><p>${escapeHtml(metricText(report.evidenceCoveragePct))}</p><p><strong>Critical-gate pass rate:</strong> ${report.criticalGatePassRate.state === "observed" ? `${report.criticalGatePassRate.value * 100}%` : escapeHtml(report.criticalGatePassRate.reason)}</p><h2>Runs</h2><table><thead><tr><th>#</th><th>Status</th><th>Run</th><th>Score</th><th>Coverage</th><th>Gates</th><th>Error</th></tr></thead><tbody>${runRows}</tbody></table><h2>Case stability</h2>${caseRows ? `<table><thead><tr><th>Area</th><th>Rubric</th><th>Case</th><th>Strata</th><th>Full-pass rate</th><th>Runs</th></tr></thead><tbody>${caseRows}</tbody></table>` : "<p>No case-level judgements were available.</p>"}<h2>Strata</h2>${stratumRows ? `<table><thead><tr><th>Stratum</th><th>Full-pass rate</th><th>Observations</th></tr></thead><tbody>${stratumRows}</tbody></table>` : "<p>No strata were configured.</p>"}<h2>Rubric stability</h2><table><thead><tr><th>Area</th><th>Item</th><th>Full-pass rate</th><th>Verdicts</th></tr></thead><tbody>${itemRows}</tbody></table><h2>Limitations</h2><ul>${report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></body></html>`);
  return { json, html };
}
