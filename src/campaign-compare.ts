import fs from "node:fs";
import path from "node:path";
import { readJson, safeName, writeJson } from "./io.js";
import { assertCampaignRunRecords, type CampaignReport } from "./campaign.js";

export interface CampaignCaseComparison {
  areaId: string;
  rubricId: string;
  caseId: string;
  strata: string[];
  split?: "development" | "evaluation";
  baselineRuns: number;
  candidateRuns: number;
  baselineMean: number | null;
  candidateMean: number | null;
  delta: number | null;
  change: "improved" | "regressed" | "unchanged" | "gained_coverage" | "lost_coverage" | "added" | "removed" | "unavailable";
}

export interface CampaignComparisonReport {
  schemaVersion: 1;
  createdAt: string;
  baseline: { campaignId: string; project: string; completedRuns: number };
  candidate: { campaignId: string; project: string; completedRuns: number };
  compatibility: { status: "compatible" | "incompatible" | "unknown"; overridden: boolean; reasons: string[] };
  overall: {
    scoreMeanPct: { baseline: number | null; candidate: number | null; delta: number | null };
    criticalGatePassRate: { baseline: number | null; candidate: number | null; delta: number | null };
  };
  pairedCases: {
    common: number;
    judgeable: number;
    baselineOnly: number;
    candidateOnly: number;
    meanDelta: number | null;
    confidenceInterval95: null | {
      lower: number;
      upper: number;
      method: "deterministic_percentile_paired_case_bootstrap";
      resamplingUnit: "matched case";
      resamples: 2_000;
    };
  };
  summary: { improved: number; regressed: number; unchanged: number; gainedCoverage: number; lostCoverage: number; added: number; removed: number; unavailable: number };
  cases: CampaignCaseComparison[];
  strata: Array<{ stratum: string; matchedCases: number; meanDelta: number }>;
  warnings: string[];
}

const round = (value: number) => Math.round(value * 1_000) / 1_000;
const keyFor = (item: { areaId: string; rubricId: string; caseId: string }) => `${item.areaId}\0${item.rubricId}\0${item.caseId}`;

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

function bootstrap(deltas: number[], seed: string): CampaignComparisonReport["pairedCases"]["confidenceInterval95"] {
  if (deltas.length < 2) return null;
  const random = randomGenerator(seedFromText(seed));
  const means: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration++) {
    let total = 0;
    for (let sample = 0; sample < deltas.length; sample++) total += deltas[Math.floor(random() * deltas.length)];
    means.push(total / deltas.length);
  }
  means.sort((left, right) => left - right);
  return {
    lower: round(percentile(means, 0.025)),
    upper: round(percentile(means, 0.975)),
    method: "deterministic_percentile_paired_case_bootstrap",
    resamplingUnit: "matched case",
    resamples: 2_000,
  };
}

interface CaseAggregate {
  areaId: string;
  rubricId: string;
  caseId: string;
  strata: string[];
  split?: "development" | "evaluation";
  values: number[];
}

function aggregateCases(campaign: CampaignReport): Map<string, CaseAggregate> {
  const cases = new Map<string, CaseAggregate>();
  for (const run of campaign.runs.filter((item) => item.status === "complete")) {
    for (const item of run.cases) {
      const key = keyFor(item);
      let aggregate = cases.get(key);
      if (!aggregate) {
        aggregate = { ...item, values: [] };
        cases.set(key, aggregate);
      }
      const value = item.points;
      if (value !== null) aggregate.values.push(value);
    }
  }
  return cases;
}

function evaluationFingerprint(campaign: CampaignReport): string | undefined {
  if (campaign.compatibility.status !== "compatible") return undefined;
  return campaign.compatibility.evaluationFingerprint;
}

export function compareCampaigns(
  baseline: CampaignReport,
  candidate: CampaignReport,
  options: { allowIncompatible?: boolean } = {},
): CampaignComparisonReport {
  const beforeFingerprint = evaluationFingerprint(baseline);
  const afterFingerprint = evaluationFingerprint(candidate);
  const reasons: string[] = [];
  let status: "compatible" | "incompatible" | "unknown";
  if (!beforeFingerprint || !afterFingerprint) {
    status = "unknown";
    reasons.push("At least one campaign lacks one stable evaluator fingerprint.");
  } else if (beforeFingerprint !== afterFingerprint) {
    status = "incompatible";
    reasons.push("Evaluation definitions, providers, fixtures, selection, or split differ.");
  } else status = "compatible";
  const numericAllowed = status === "compatible" || Boolean(options.allowIncompatible);
  const before = aggregateCases(baseline);
  const after = aggregateCases(candidate);
  const allKeys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const cases: CampaignCaseComparison[] = allKeys.map((key) => {
    const left = before.get(key);
    const right = after.get(key);
    const baselineMean = left?.values.length ? round(left.values.reduce((sum, value) => sum + value, 0) / left.values.length) : null;
    const candidateMean = right?.values.length ? round(right.values.reduce((sum, value) => sum + value, 0) / right.values.length) : null;
    const delta = numericAllowed && baselineMean !== null && candidateMean !== null ? round(candidateMean - baselineMean) : null;
    const change = !left
      ? "added" as const
      : !right
        ? "removed" as const
        : !numericAllowed
          ? "unavailable" as const
          : baselineMean === null && candidateMean !== null
            ? "gained_coverage" as const
            : baselineMean !== null && candidateMean === null
              ? "lost_coverage" as const
              : delta === null
                ? "unavailable" as const
                : delta > 0
                  ? "improved" as const
                  : delta < 0
                    ? "regressed" as const
                    : "unchanged" as const;
    return {
      areaId: (right ?? left)!.areaId,
      rubricId: (right ?? left)!.rubricId,
      caseId: (right ?? left)!.caseId,
      strata: (right ?? left)!.strata,
      split: (right ?? left)!.split,
      baselineRuns: left?.values.length ?? 0,
      candidateRuns: right?.values.length ?? 0,
      baselineMean,
      candidateMean,
      delta,
      change,
    };
  });
  const paired = cases.filter((item) => item.delta !== null);
  const deltas = paired.map((item) => item.delta!);
  const strata = new Map<string, number[]>();
  for (const item of paired) {
    for (const stratum of new Set(item.strata)) {
      const values = strata.get(stratum) ?? [];
      values.push(item.delta!);
      strata.set(stratum, values);
    }
  }
  const warnings: string[] = [];
  if (status !== "compatible") warnings.push(`${status === "unknown" ? "Compatibility is unknown" : "Campaigns are incompatible"}; paired deltas ${numericAllowed ? "were explicitly enabled" : "are withheld"}.`);
  if (!paired.length) warnings.push("No common case produced judgeable results in both campaigns.");
  if (baseline.project !== candidate.project) warnings.push(`Project changed from ${baseline.project} to ${candidate.project}.`);
  const baselineScore = baseline.scorePct.state === "observed" ? baseline.scorePct.value.mean : null;
  const candidateScore = candidate.scorePct.state === "observed" ? candidate.scorePct.value.mean : null;
  const baselineGates = baseline.criticalGatePassRate.state === "observed" ? baseline.criticalGatePassRate.value : null;
  const candidateGates = candidate.criticalGatePassRate.state === "observed" ? candidate.criticalGatePassRate.value : null;
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baseline: { campaignId: baseline.campaignId, project: baseline.project, completedRuns: baseline.coverage.completedRuns },
    candidate: { campaignId: candidate.campaignId, project: candidate.project, completedRuns: candidate.coverage.completedRuns },
    compatibility: { status, overridden: Boolean(options.allowIncompatible), reasons },
    overall: {
      scoreMeanPct: {
        baseline: baselineScore,
        candidate: candidateScore,
        delta: numericAllowed && baselineScore !== null && candidateScore !== null ? round(candidateScore - baselineScore) : null,
      },
      criticalGatePassRate: {
        baseline: baselineGates,
        candidate: candidateGates,
        delta: numericAllowed && baselineGates !== null && candidateGates !== null ? round(candidateGates - baselineGates) : null,
      },
    },
    pairedCases: {
      common: allKeys.filter((key) => before.has(key) && after.has(key)).length,
      judgeable: paired.length,
      baselineOnly: allKeys.filter((key) => before.has(key) && !after.has(key)).length,
      candidateOnly: allKeys.filter((key) => !before.has(key) && after.has(key)).length,
      meanDelta: deltas.length ? round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length) : null,
      confidenceInterval95: bootstrap(deltas, `${beforeFingerprint}:${baseline.campaignId}:${candidate.campaignId}`),
    },
    summary: {
      improved: cases.filter((item) => item.change === "improved").length,
      regressed: cases.filter((item) => item.change === "regressed").length,
      unchanged: cases.filter((item) => item.change === "unchanged").length,
      gainedCoverage: cases.filter((item) => item.change === "gained_coverage").length,
      lostCoverage: cases.filter((item) => item.change === "lost_coverage").length,
      added: cases.filter((item) => item.change === "added").length,
      removed: cases.filter((item) => item.change === "removed").length,
      unavailable: cases.filter((item) => item.change === "unavailable").length,
    },
    cases,
    strata: [...strata].map(([stratum, values]) => ({
      stratum,
      matchedCases: values.length,
      meanDelta: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    })).sort((left, right) => left.stratum.localeCompare(right.stratum)),
    warnings,
  };
}

export function loadCampaign(input: string): { file: string; report: CampaignReport } {
  const resolved = path.resolve(input);
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, "campaign.json") : resolved;
  if (!fs.existsSync(file)) throw new Error(`Campaign report does not exist: ${file}`);
  const report = readJson<CampaignReport>(file);
  if (
    report.schemaVersion !== 1 ||
    typeof report.campaignId !== "string" ||
    !Array.isArray(report.runs) ||
    !report.compatibility ||
    !report.coverage ||
    !report.scorePct ||
    !report.evidenceCoveragePct ||
    !report.criticalGatePassRate ||
    !Array.isArray(report.itemStability) ||
    !Array.isArray(report.caseStability) ||
    !Array.isArray(report.stratumStability) ||
    !Array.isArray(report.limitations)
  ) {
    throw new Error(`Invalid Agent Eval Kit campaign: ${file}`);
  }
  try {
    assertCampaignRunRecords(report.runs);
  } catch (error) {
    throw new Error(`Invalid Agent Eval Kit campaign ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { file, report };
}

export function campaignComparisonFailures(
  report: CampaignComparisonReport,
  options: { failOnRegression?: boolean; requireCompatible?: boolean },
): string[] {
  const failures: string[] = [];
  if (options.requireCompatible && report.compatibility.status !== "compatible") {
    failures.push(`evaluator inputs are ${report.compatibility.status}`);
  }
  if (options.failOnRegression) {
    const cases = report.summary.regressed + report.summary.lostCoverage + report.summary.removed;
    if (cases) failures.push(`${cases} case regression(s), coverage loss(es), or removal(s)`);
    if (
      report.overall.scoreMeanPct.baseline !== null &&
      report.overall.scoreMeanPct.candidate === null
    ) {
      failures.push("candidate campaign mean score is unavailable despite an available baseline score");
    } else if ((report.overall.scoreMeanPct.delta ?? 0) < 0) {
      failures.push(`campaign mean score dropped ${Math.abs(report.overall.scoreMeanPct.delta!)} points`);
    }
    if (
      report.overall.criticalGatePassRate.baseline !== null &&
      report.overall.criticalGatePassRate.candidate === null
    ) {
      failures.push("candidate critical-gate pass rate is unavailable despite an available baseline rate");
    } else if ((report.overall.criticalGatePassRate.delta ?? 0) < 0) {
      failures.push(`critical-gate pass rate dropped ${Math.abs(report.overall.criticalGatePassRate.delta!)}`);
    }
  }
  return failures;
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const percent = (value: number | null) => value === null ? "—" : `${value}%`;

export function writeCampaignComparisonArtifacts(directory: string, report: CampaignComparisonReport): { json: string; html: string } {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true });
  const json = path.join(resolved, "campaign-comparison.json");
  const html = path.join(resolved, "campaign-comparison.html");
  writeJson(json, report);
  const rows = report.cases.map((item) => `<tr><td>${escapeHtml(item.areaId)}</td><td>${escapeHtml(item.rubricId)}</td><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.strata.join(", ") || "—")}</td><td>${item.baselineMean ?? "—"}</td><td>${item.candidateMean ?? "—"}</td><td class="${["regressed", "lost_coverage", "removed"].includes(item.change) ? "bad" : ["improved", "gained_coverage", "added"].includes(item.change) ? "good" : ""}">${item.delta === null ? escapeHtml(item.change) : `${item.delta > 0 ? "+" : ""}${item.delta}`}</td></tr>`).join("");
  const strataRows = report.strata.map((item) => `<tr><td>${escapeHtml(item.stratum)}</td><td>${item.matchedCases}</td><td>${item.meanDelta > 0 ? "+" : ""}${item.meanDelta}</td></tr>`).join("");
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Campaign comparison</title><style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;max-width:1120px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .65rem;text-align:left}th{background:#f6f8fa}.good{color:#1a7f37;font-weight:650}.bad,.warn{color:#cf222e;font-weight:650}code{font-size:.9em}</style></head><body><h1>Campaign comparison</h1><p><code>${escapeHtml(report.baseline.campaignId)}</code> → <code>${escapeHtml(report.candidate.campaignId)}</code> · compatibility <strong class="${report.compatibility.status === "compatible" ? "good" : "warn"}">${report.compatibility.status}</strong></p><p><strong>Campaign mean score:</strong> ${percent(report.overall.scoreMeanPct.baseline)} → ${percent(report.overall.scoreMeanPct.candidate)} · Δ ${report.overall.scoreMeanPct.delta === null ? "—" : `${report.overall.scoreMeanPct.delta > 0 ? "+" : ""}${report.overall.scoreMeanPct.delta}`} points<br><strong>Critical-gate pass rate:</strong> ${report.overall.criticalGatePassRate.baseline === null ? "—" : `${report.overall.criticalGatePassRate.baseline * 100}%`} → ${report.overall.criticalGatePassRate.candidate === null ? "—" : `${report.overall.criticalGatePassRate.candidate * 100}%`}</p><p><strong>Mean paired-case delta:</strong> ${report.pairedCases.meanDelta === null ? "unavailable" : `${report.pairedCases.meanDelta > 0 ? "+" : ""}${report.pairedCases.meanDelta}`}${report.pairedCases.confidenceInterval95 ? ` · 95% bootstrap ${report.pairedCases.confidenceInterval95.lower} to ${report.pairedCases.confidenceInterval95.upper}` : ""}</p><p>${report.summary.improved} improved · ${report.summary.regressed} regressed · ${report.summary.gainedCoverage} gained coverage · ${report.summary.lostCoverage} lost coverage · ${report.summary.added} added · ${report.summary.removed} removed · ${report.summary.unchanged} unchanged · ${report.summary.unavailable} unavailable</p><h2>Cases</h2><table><thead><tr><th>Area</th><th>Rubric</th><th>Case</th><th>Strata</th><th>Baseline mean</th><th>Candidate mean</th><th>Δ / status</th></tr></thead><tbody>${rows}</tbody></table><h2>Strata</h2>${strataRows ? `<table><thead><tr><th>Stratum</th><th>Cases</th><th>Mean Δ</th></tr></thead><tbody>${strataRows}</tbody></table>` : "<p>No strata available.</p>"}<h2>Warnings</h2><ul>${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul></body></html>`);
  return { json, html };
}

export function defaultCampaignComparisonOutput(candidateFile: string, baselineId: string): string {
  return path.join(path.dirname(candidateFile), "comparisons", `vs-${safeName(baselineId)}`);
}
