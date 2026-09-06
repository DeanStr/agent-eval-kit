import { requireDefined, omitUndefined } from "./invariants.js";
import fs from "node:fs";
import path from "node:path";
import { campaignReportSchema } from "./artifact-schemas.js";
import { readJson, safeName, stableJson, writeJson } from "./io.js";
import { assertCampaignRunRecords, buildCampaignReport, type CampaignReport } from "./campaign.js";

export interface CampaignCaseComparison {
  areaId: string;
  rubricId: string;
  caseId: string;
  strata: string[];
  split?: "development" | "evaluation";
  baselineRuns: number;
  candidateRuns: number;
  baselineTotalRuns: number;
  candidateTotalRuns: number;
  coverage: { baseline: number | null; candidate: number | null; delta: number | null };
  baselineMean: number | null;
  candidateMean: number | null;
  delta: number | null;
  change:
    | "improved"
    | "regressed"
    | "unchanged"
    | "gained_coverage"
    | "lost_coverage"
    | "added"
    | "removed"
    | "unavailable";
}

export interface CampaignComparisonReport {
  schemaVersion: 1;
  createdAt: string;
  baseline: { campaignId: string; project: string; completedRuns: number };
  candidate: { campaignId: string; project: string; completedRuns: number };
  compatibility: {
    status: "compatible" | "incompatible" | "unknown";
    overridden: boolean;
    reasons: string[];
  };
  overall: {
    completionRate: { baseline: number | null; candidate: number | null; delta: number | null };
    scoreMeanPct: { baseline: number | null; candidate: number | null; delta: number | null };
    criticalGatePassRate: {
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
    };
    evidenceCoverageMeanPct: {
      baseline: number | null;
      candidate: number | null;
      delta: number | null;
    };
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
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    gainedCoverage: number;
    lostCoverage: number;
    added: number;
    removed: number;
    unavailable: number;
  };
  cases: CampaignCaseComparison[];
  strata: Array<{ stratum: string; matchedCases: number; meanDelta: number }>;
  warnings: string[];
}

const round = (value: number) => Math.round(value * 1_000) / 1_000;
const keyFor = (item: { areaId: string; rubricId: string; caseId: string }) =>
  `${item.areaId}\0${item.rubricId}\0${item.caseId}`;

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
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    requireDefined(sorted[lower], "sorted[lower]") +
    (requireDefined(sorted[upper], "sorted[upper]") -
      requireDefined(sorted[lower], "sorted[lower]")) *
      (position - lower)
  );
}

function bootstrap(
  deltas: number[],
  seed: string,
): CampaignComparisonReport["pairedCases"]["confidenceInterval95"] {
  if (deltas.length < 2) return null;
  const random = randomGenerator(seedFromText(seed));
  const means: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration++) {
    let total = 0;
    for (let sample = 0; sample < deltas.length; sample++)
      total += requireDefined(
        deltas[Math.floor(random() * deltas.length)],
        "deltas[Math.floor(random() * deltas.length)]",
      );
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

function headlineMetrics(campaign: CampaignReport): {
  score: number | null;
  coverage: number | null;
  gates: number | null;
} {
  if (campaign.compatibility.status !== "compatible")
    return { score: null, coverage: null, gates: null };
  const complete = campaign.runs.filter((run) => run.status === "complete");
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    score: mean(
      complete.flatMap((run) =>
        !run.scoreWithheld && run.scorePct !== null ? [run.scorePct] : [],
      ),
    ),
    coverage: mean(complete.map((run) => run.coveragePct)),
    gates: mean(
      complete.flatMap((run) =>
        typeof run.gatesPassed === "boolean" ? [Number(run.gatesPassed)] : [],
      ),
    ),
  };
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
  const measurements = allKeys.map((key) => {
    const left = before.get(key);
    const right = after.get(key);
    const baselineMean = left?.values.length
      ? left.values.reduce((sum, value) => sum + value, 0) / left.values.length
      : null;
    const candidateMean = right?.values.length
      ? right.values.reduce((sum, value) => sum + value, 0) / right.values.length
      : null;
    const rawDelta =
      numericAllowed && baselineMean !== null && candidateMean !== null
        ? candidateMean - baselineMean
        : null;
    // Every attempted repetition belongs in the denominator, including failed
    // runs and complete runs that omitted this case. Abstentions never score 0.
    // With identical definitions an omitted case is expected but unobserved.
    // Different definitions cannot establish membership on the missing side.
    const sameDefinitions = status === "compatible";
    const baselineCoverage =
      (left || sameDefinitions) && baseline.runs.length
        ? (left?.values.length ?? 0) / baseline.runs.length
        : null;
    const candidateCoverage =
      (right || sameDefinitions) && candidate.runs.length
        ? (right?.values.length ?? 0) / candidate.runs.length
        : null;
    const coverageDelta =
      numericAllowed && baselineCoverage !== null && candidateCoverage !== null
        ? candidateCoverage - baselineCoverage
        : null;
    const change: CampaignCaseComparison["change"] = (() => {
      if (!sameDefinitions) {
        if (!left) return "added";
        if (!right) return "removed";
      }
      if (!numericAllowed) return "unavailable";
      if (coverageDelta !== null && coverageDelta < 0) return "lost_coverage";
      if (rawDelta !== null && rawDelta < 0) return "regressed";
      if (coverageDelta !== null && coverageDelta > 0) return "gained_coverage";
      if (rawDelta === null) return "unavailable";
      return rawDelta > 0 ? "improved" : "unchanged";
    })();
    return omitUndefined({
      areaId: (right ?? left)!.areaId,
      rubricId: (right ?? left)!.rubricId,
      caseId: (right ?? left)!.caseId,
      strata: (right ?? left)!.strata,
      split: (right ?? left)!.split,
      baselineRuns: left?.values.length ?? 0,
      candidateRuns: right?.values.length ?? 0,
      baselineTotalRuns: baseline.runs.length,
      candidateTotalRuns: candidate.runs.length,
      coverage: { baseline: baselineCoverage, candidate: candidateCoverage, delta: coverageDelta },
      baselineMean: baselineMean === null ? null : round(baselineMean),
      candidateMean: candidateMean === null ? null : round(candidateMean),
      delta: rawDelta === null ? null : round(rawDelta),
      rawDelta,
      change,
    });
  });
  const cases: CampaignCaseComparison[] = measurements.map(
    ({ rawDelta: _rawDelta, ...item }) => item,
  );
  const paired = measurements.filter((item) => item.rawDelta !== null);
  const deltas = paired.map((item) => item.rawDelta!);
  const strata = new Map<string, number[]>();
  for (const item of paired) {
    for (const stratum of new Set(item.strata)) {
      const values = strata.get(stratum) ?? [];
      values.push(item.rawDelta!);
      strata.set(stratum, values);
    }
  }
  const warnings: string[] = [];
  if (status !== "compatible")
    warnings.push(
      `${status === "unknown" ? "Compatibility is unknown" : "Campaigns are incompatible"}; paired deltas ${numericAllowed ? "were explicitly enabled" : "are withheld"}.`,
    );
  if (!paired.length) warnings.push("No common case produced judgeable results in both campaigns.");
  if (baseline.project !== candidate.project)
    warnings.push(`Project changed from ${baseline.project} to ${candidate.project}.`);
  const {
    score: baselineScore,
    gates: baselineGates,
    coverage: baselineCoverage,
  } = headlineMetrics(baseline);
  const {
    score: candidateScore,
    gates: candidateGates,
    coverage: candidateCoverage,
  } = headlineMetrics(candidate);
  // Pending repetitions are excluded; execution failures remain separate from product scores.
  const completionRate = (campaign: CampaignReport) =>
    campaign.runs.length
      ? campaign.runs.filter((run) => run.status === "complete").length / campaign.runs.length
      : null;
  const baselineCompletion = completionRate(baseline),
    candidateCompletion = completionRate(candidate);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baseline: {
      campaignId: baseline.campaignId,
      project: baseline.project,
      completedRuns: baseline.coverage.completedRuns,
    },
    candidate: {
      campaignId: candidate.campaignId,
      project: candidate.project,
      completedRuns: candidate.coverage.completedRuns,
    },
    compatibility: { status, overridden: Boolean(options.allowIncompatible), reasons },
    overall: {
      completionRate: {
        baseline: baselineCompletion,
        candidate: candidateCompletion,
        delta:
          numericAllowed && baselineCompletion !== null && candidateCompletion !== null
            ? candidateCompletion - baselineCompletion
            : null,
      },
      evidenceCoverageMeanPct: {
        baseline: baselineCoverage,
        candidate: candidateCoverage,
        delta:
          numericAllowed && baselineCoverage !== null && candidateCoverage !== null
            ? candidateCoverage - baselineCoverage
            : null,
      },
      scoreMeanPct: {
        baseline: baselineScore,
        candidate: candidateScore,
        delta:
          numericAllowed && baselineScore !== null && candidateScore !== null
            ? candidateScore - baselineScore
            : null,
      },
      criticalGatePassRate: {
        baseline: baselineGates,
        candidate: candidateGates,
        delta:
          numericAllowed && baselineGates !== null && candidateGates !== null
            ? candidateGates - baselineGates
            : null,
      },
    },
    pairedCases: {
      common: allKeys.filter((key) => before.has(key) && after.has(key)).length,
      judgeable: paired.length,
      baselineOnly: allKeys.filter((key) => before.has(key) && !after.has(key)).length,
      candidateOnly: allKeys.filter((key) => !before.has(key) && after.has(key)).length,
      meanDelta: deltas.length
        ? round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length)
        : null,
      confidenceInterval95: bootstrap(
        deltas,
        `${beforeFingerprint}:${baseline.campaignId}:${candidate.campaignId}`,
      ),
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
    strata: [...strata]
      .map(([stratum, values]) => ({
        stratum,
        matchedCases: values.length,
        meanDelta: round(values.reduce((sum, value) => sum + value, 0) / values.length),
      }))
      .sort((left, right) => left.stratum.localeCompare(right.stratum)),
    warnings,
  };
}

export function loadCampaign(input: string): { file: string; report: CampaignReport } {
  const resolved = path.resolve(input);
  const file =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, "campaign.json")
      : resolved;
  if (!fs.existsSync(file)) throw new Error(`Campaign report does not exist: ${file}`);
  const report = readJson<CampaignReport>(file);
  const parsed = campaignReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`Invalid Agent Eval Kit campaign: ${file}: ${parsed.error.message}`);
  }
  try {
    assertCampaignRunRecords(report.runs);
    const rebuilt = buildCampaignReport({
      campaignId: report.campaignId,
      project: report.project,
      startedAt: report.startedAt,
      plannedRepetitions: report.plannedRepetitions,
      runs: report.runs,
    });
    for (const field of [
      "status",
      "compatibility",
      "coverage",
      "scorePct",
      "evidenceCoveragePct",
      "criticalGatePassRate",
      "itemStability",
      "caseStability",
      "stratumStability",
    ] as const) {
      if (stableJson(report[field]) !== stableJson(rebuilt[field])) {
        throw new Error(`${field} does not match the campaign run records`);
      }
    }
  } catch (error) {
    throw new Error(
      `Invalid Agent Eval Kit campaign ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    const completion = report.overall.completionRate;
    if (completion.baseline !== null && completion.candidate === null) {
      failures.push(
        "candidate campaign completion rate is unavailable despite an available baseline rate",
      );
    } else if ((completion.delta ?? 0) < 0) {
      failures.push(
        `campaign completion rate dropped ${displayDrop(completion.delta! * 100)} percentage points`,
      );
    }
    const cases = report.summary.regressed + report.summary.lostCoverage + report.summary.removed;
    if (cases) failures.push(`${cases} case regression(s), coverage loss(es), or removal(s)`);
    const coverage = report.overall.evidenceCoverageMeanPct;
    if (coverage.baseline !== null && coverage.candidate === null) {
      failures.push(
        "candidate campaign evidence coverage is unavailable despite an available baseline coverage",
      );
    } else if ((coverage.delta ?? 0) < 0) {
      failures.push(
        `campaign mean evidence coverage dropped ${displayDrop(coverage.delta!)} points`,
      );
    }
    if (
      report.overall.scoreMeanPct.baseline !== null &&
      report.overall.scoreMeanPct.candidate === null
    ) {
      failures.push(
        "candidate campaign mean score is unavailable despite an available baseline score",
      );
    } else if ((report.overall.scoreMeanPct.delta ?? 0) < 0) {
      failures.push(
        `campaign mean score dropped ${displayDrop(report.overall.scoreMeanPct.delta!)} points`,
      );
    }
    if (
      report.overall.criticalGatePassRate.baseline !== null &&
      report.overall.criticalGatePassRate.candidate === null
    ) {
      failures.push(
        "candidate critical-gate pass rate is unavailable despite an available baseline rate",
      );
    } else if ((report.overall.criticalGatePassRate.delta ?? 0) < 0) {
      failures.push(
        `critical-gate pass rate dropped ${displayDrop(report.overall.criticalGatePassRate.delta!)}`,
      );
    }
  }
  return failures;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const percent = (value: number | null) => (value === null ? "—" : `${round(value)}%`);
const displayDrop = (delta: number) =>
  Math.abs(delta) < 0.001 ? "<0.001" : String(round(Math.abs(delta)));

export function writeCampaignComparisonArtifacts(
  directory: string,
  report: CampaignComparisonReport,
): { json: string; html: string } {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true });
  const json = path.join(resolved, "campaign-comparison.json");
  const html = path.join(resolved, "campaign-comparison.html");
  writeJson(json, report);
  const rows = report.cases
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.areaId)}</td><td>${escapeHtml(item.rubricId)}</td><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.strata.join(", ") || "—")}</td><td>${item.baselineMean ?? "—"}</td><td>${item.candidateMean ?? "—"}</td><td>${item.baselineRuns}/${item.baselineTotalRuns} → ${item.candidateRuns}/${item.candidateTotalRuns}</td><td>${escapeHtml(item.change)}</td><td class="${["regressed", "lost_coverage", "removed"].includes(item.change) ? "bad" : ["improved", "gained_coverage", "added"].includes(item.change) ? "good" : ""}">${item.delta === null ? escapeHtml(item.change) : `${item.delta > 0 ? "+" : ""}${item.delta}`}</td></tr>`,
    )
    .join("");
  const strataRows = report.strata
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.stratum)}</td><td>${item.matchedCases}</td><td>${item.meanDelta > 0 ? "+" : ""}${item.meanDelta}</td></tr>`,
    )
    .join("");
  fs.writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Campaign comparison</title><style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;max-width:1120px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .65rem;text-align:left}th{background:#f6f8fa}.good{color:#1a7f37;font-weight:650}.bad,.warn{color:#cf222e;font-weight:650}code{font-size:.9em}</style></head><body><h1>Campaign comparison</h1><p><code>${escapeHtml(report.baseline.campaignId)}</code> → <code>${escapeHtml(report.candidate.campaignId)}</code> · compatibility <strong class="${report.compatibility.status === "compatible" ? "good" : "warn"}">${report.compatibility.status}</strong></p><p><strong>Completion rate (completed / attempted):</strong> ${report.overall.completionRate.baseline === null ? "—" : percent(report.overall.completionRate.baseline * 100)} → ${report.overall.completionRate.candidate === null ? "—" : percent(report.overall.completionRate.candidate * 100)}<br><strong>Campaign mean score:</strong> ${percent(report.overall.scoreMeanPct.baseline)} → ${percent(report.overall.scoreMeanPct.candidate)} · Δ ${report.overall.scoreMeanPct.delta === null ? "—" : `${report.overall.scoreMeanPct.delta > 0 ? "+" : ""}${round(report.overall.scoreMeanPct.delta)}`} points<br><strong>Mean evidence coverage:</strong> ${percent(report.overall.evidenceCoverageMeanPct.baseline)} → ${percent(report.overall.evidenceCoverageMeanPct.candidate)}<br><strong>Critical-gate pass rate:</strong> ${report.overall.criticalGatePassRate.baseline === null ? "—" : `${round(report.overall.criticalGatePassRate.baseline * 100)}%`} → ${report.overall.criticalGatePassRate.candidate === null ? "—" : `${round(report.overall.criticalGatePassRate.candidate * 100)}%`}</p><p><strong>Mean paired-case delta:</strong> ${report.pairedCases.meanDelta === null ? "unavailable" : `${report.pairedCases.meanDelta > 0 ? "+" : ""}${report.pairedCases.meanDelta}`}${report.pairedCases.confidenceInterval95 ? ` · 95% bootstrap ${report.pairedCases.confidenceInterval95.lower} to ${report.pairedCases.confidenceInterval95.upper}` : ""}</p><p>${report.summary.improved} improved · ${report.summary.regressed} regressed · ${report.summary.gainedCoverage} gained coverage · ${report.summary.lostCoverage} lost coverage · ${report.summary.added} added · ${report.summary.removed} removed · ${report.summary.unchanged} unchanged · ${report.summary.unavailable} unavailable</p><h2>Cases</h2><table><thead><tr><th>Area</th><th>Rubric</th><th>Case</th><th>Strata</th><th>Baseline mean</th><th>Candidate mean</th><th>Judgeable / attempted</th><th>Change</th><th>Δ / status</th></tr></thead><tbody>${rows}</tbody></table><h2>Strata</h2>${strataRows ? `<table><thead><tr><th>Stratum</th><th>Cases</th><th>Mean Δ</th></tr></thead><tbody>${strataRows}</tbody></table>` : "<p>No strata available.</p>"}<h2>Warnings</h2><ul>${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul></body></html>`,
  );
  return { json, html };
}

export function defaultCampaignComparisonOutput(candidateFile: string, baselineId: string): string {
  return path.join(path.dirname(candidateFile), "comparisons", `vs-${safeName(baselineId)}`);
}
