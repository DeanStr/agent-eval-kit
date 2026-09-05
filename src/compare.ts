import fs from "node:fs";
import path from "node:path";
import { runReportSchema } from "./artifact-schemas.js";
import { scoreRatios } from "./score-slice.js";
import { readJson, safeName, writeJson } from "./io.js";
import type { AreaResult, JudgedItem, RunReceipt, RunReport, ScoreSlice, Verdict } from "./types.js";

export type ItemChange =
  | "improved"
  | "regressed"
  | "unchanged"
  | "changed"
  | "unavailable"
  | "gained_coverage"
  | "lost_coverage"
  | "added"
  | "removed";

export interface MetricComparison {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

export interface RunSnapshot {
  runId: string;
  project: string;
  finishedAt: string;
  scorePct: number | null;
  coveragePct: number;
  scoreWithheld: boolean;
  evaluationFingerprint: string;
  git?: RunReceipt["target"]["git"];
  treeSha256?: string;
}

export interface ComparisonCompatibility {
  status: "compatible" | "incompatible";
  differences: string[];
  overridden: boolean;
}

export interface AreaComparison {
  id: string;
  title: string;
  status: "compared" | "added" | "removed";
  scorePct: MetricComparison;
  coveragePct: MetricComparison;
}

export interface TagComparison {
  tag: string;
  status: "compared" | "added" | "removed";
  scorePct: MetricComparison;
  coveragePct: MetricComparison;
}

export interface ItemComparison {
  areaId: string;
  id: string;
  baselineVerdict?: Verdict;
  candidateVerdict?: Verdict;
  scorePct: MetricComparison;
  coveragePct: MetricComparison;
  change: ItemChange;
}

export interface ComparisonReport {
  schemaVersion: 1;
  createdAt: string;
  baseline: RunSnapshot;
  candidate: RunSnapshot;
  overall: {
    scorePct: MetricComparison;
    coveragePct: MetricComparison;
  };
  compatibility: ComparisonCompatibility;
  summary: Record<ItemChange, number> & { areasAdded: number; areasRemoved: number };
  warnings: string[];
  areas: AreaComparison[];
  tags: TagComparison[];
  items: ItemComparison[];
}

export interface ComparisonThresholds {
  failOnRegression?: boolean;
  maxScoreDrop?: number;
  maxCoverageDrop?: number;
  requireCompatible?: boolean;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function metric(baseline: number | null, candidate: number | null, comparable = true): MetricComparison {
  return {
    baseline,
    candidate,
    delta: !comparable || baseline === null || candidate === null ? null : round(candidate - baseline),
  };
}

function comparableScore(report: RunReport): number | null {
  return report.scoreWithheld ? null : report.overallScorePct;
}

function snapshot(report: RunReport): RunSnapshot {
  return {
    runId: report.runId,
    project: report.project,
    finishedAt: report.finishedAt,
    scorePct: report.overallScorePct,
    coveragePct: report.overallCoveragePct,
    scoreWithheld: report.scoreWithheld,
    evaluationFingerprint: report.receipt.evaluationFingerprint,
    git: report.receipt.target.git,
    treeSha256: report.receipt.target.treeSha256,
  };
}

function unionById<T extends { id: string }>(baseline: T[], candidate: T[]): string[] {
  return [...new Set([...baseline.map(({ id }) => id), ...candidate.map(({ id }) => id)])];
}

function areaComparison(baseline: AreaResult | undefined, candidate: AreaResult | undefined, comparable: boolean): AreaComparison {
  const status = !baseline ? "added" : !candidate ? "removed" : "compared";
  return {
    id: (candidate ?? baseline)!.id,
    title: (candidate ?? baseline)!.title,
    status,
    scorePct: metric(baseline?.scorePct ?? null, candidate?.scorePct ?? null, comparable),
    coveragePct: metric(baseline?.coveragePct ?? null, candidate?.coveragePct ?? null, comparable),
  };
}

function tagComparison(tag: string, baseline: ScoreSlice | undefined, candidate: ScoreSlice | undefined, comparable: boolean): TagComparison {
  return {
    tag,
    status: !baseline ? "added" : !candidate ? "removed" : "compared",
    scorePct: metric(baseline?.scorePct ?? null, candidate?.scorePct ?? null, comparable),
    coveragePct: metric(baseline?.coveragePct ?? null, candidate?.coveragePct ?? null, comparable),
  };
}

function itemChange(baseline?: JudgedItem, candidate?: JudgedItem): ItemChange {
  if (!baseline) return "added";
  if (!candidate) return "removed";
  if (!baseline.score || !candidate.score) {
    throw new Error(`Item ${baseline.id} is missing required scored measurements.`);
  }
  const beforeRatios = scoreRatios(baseline.score);
  const afterRatios = scoreRatios(candidate.score);
  if (afterRatios.coverage < beforeRatios.coverage) return "lost_coverage";
  const before = beforeRatios.score;
  const after = afterRatios.score;
  if (before !== null && after !== null && after < before) return "regressed";
  if (afterRatios.coverage > beforeRatios.coverage) return "gained_coverage";
  if (before !== null && after !== null && after > before) return "improved";
  // Verdict ordering is semantic, independent of configurable partial credit.
  // A pass -> partial transition still loses a critical gate at partialCredit=1.
  const rank: Partial<Record<Verdict, number>> = { pass: 2, partial: 1, fail: 0, not_found: 0 };
  const beforeRank = rank[baseline.verdict];
  const afterRank = rank[candidate.verdict];
  if (beforeRank !== undefined && afterRank !== undefined) {
    if (afterRank < beforeRank) return "regressed";
    if (afterRank > beforeRank) return "improved";
  }
  return baseline.verdict === candidate.verdict ? "unchanged" : "changed";
}

function recordHashes<T extends { sha256: string }>(value: Record<string, T> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).map(([name, receipt]) => [name, receipt.sha256]));
}

function compatibility(
  baseline: RunReceipt,
  candidate: RunReceipt,
  overridden: boolean,
): ComparisonCompatibility {
  if (baseline.evaluationFingerprint === candidate.evaluationFingerprint) {
    return { status: "compatible", differences: [], overridden };
  }
  const differences: string[] = [];
  if (baseline.inputs.methodSha256 !== candidate.inputs.methodSha256) {
    differences.push("Evaluator configuration, provider version, scoring, variables, or instructions changed.");
  }
  if (stableValue(recordHashes(baseline.inputs.graderMethods)) !== stableValue(recordHashes(candidate.inputs.graderMethods))) {
    differences.push("One or more declared command grader method files changed.");
  }
  if (stableValue(baseline.inputs.selection) !== stableValue(candidate.inputs.selection)) {
    differences.push("Selected areas or scenarios changed.");
  }
  if (stableValue(recordHashes(baseline.inputs.specs)) !== stableValue(recordHashes(candidate.inputs.specs))) {
    differences.push("One or more evaluation specs changed.");
  }
  if (stableValue(recordHashes(baseline.inputs.textReferences)) !== stableValue(recordHashes(candidate.inputs.textReferences))) {
    differences.push("One or more text references or style targets changed.");
  }
  const beforeFixtures = baseline.inputs.fixtures;
  const afterFixtures = candidate.inputs.fixtures;
  if (beforeFixtures?.manifest.sha256 !== afterFixtures?.manifest.sha256) {
    differences.push("The fixture manifest changed.");
  }
  if (stableValue(recordHashes(beforeFixtures?.files)) !== stableValue(recordHashes(afterFixtures?.files))) {
    differences.push("One or more fixture files changed.");
  }
  if (!differences.length) differences.push("The evaluation fingerprint changed for an unknown reason.");
  return { status: "incompatible", differences, overridden };
}

function stableValue(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function compareReports(
  baseline: RunReport,
  candidate: RunReport,
  options: { allowIncompatible?: boolean } = {},
): ComparisonReport {
  const compatible = compatibility(baseline.receipt, candidate.receipt, Boolean(options.allowIncompatible));
  const metricsComparable = compatible.status === "compatible" || Boolean(options.allowIncompatible);
  const baselineAreas = new Map(baseline.areas.map((area) => [area.id, area]));
  const candidateAreas = new Map(candidate.areas.map((area) => [area.id, area]));
  const areaIds = unionById(baseline.areas, candidate.areas);
  const areas = areaIds.map((id) => areaComparison(baselineAreas.get(id), candidateAreas.get(id), metricsComparable));
  const tags = [...new Set([...Object.keys(baseline.byTag), ...Object.keys(candidate.byTag)])]
    .sort()
    .map((tag) => tagComparison(tag, baseline.byTag[tag], candidate.byTag[tag], metricsComparable));
  const items: ItemComparison[] = [];
  for (const areaId of areaIds) {
    const baselineArea = baselineAreas.get(areaId);
    const candidateArea = candidateAreas.get(areaId);
    const unavailableIfUnproven = (item: JudgedItem, area: AreaResult | undefined): JudgedItem =>
      area?.unproven.includes(item.id)
        ? { ...item, verdict: "cannot_judge", confidence: "low", score: item.score && !item.components ? { ...item.score, earned: 0, judgeable: 0, scorePct: null, coveragePct: 0 } : item.score }
        : item;
    const beforeItems = (baselineArea?.items ?? []).map((item) => unavailableIfUnproven(item, baselineArea));
    const afterItems = (candidateArea?.items ?? []).map((item) => unavailableIfUnproven(item, candidateArea));
    const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
    const afterById = new Map(afterItems.map((item) => [item.id, item]));
    for (const id of unionById(beforeItems, afterItems)) {
      const before = beforeById.get(id);
      const after = afterById.get(id);
      items.push({
        areaId,
        id,
        baselineVerdict: before?.verdict,
        candidateVerdict: after?.verdict,
        scorePct: metric(before?.score?.scorePct ?? null, after?.score?.scorePct ?? null, metricsComparable),
        coveragePct: metric(before?.score?.coveragePct ?? null, after?.score?.coveragePct ?? null, metricsComparable),
        change: before && after && !metricsComparable ? "unavailable" : itemChange(before, after),
      });
    }
  }

  const changes: ItemChange[] = [
    "improved", "regressed", "unchanged", "changed", "unavailable", "gained_coverage", "lost_coverage", "added", "removed",
  ];
  const summary = Object.fromEntries(changes.map((change) => [change, 0])) as ComparisonReport["summary"];
  for (const item of items) summary[item.change]++;
  summary.areasAdded = areas.filter(({ status }) => status === "added").length;
  summary.areasRemoved = areas.filter(({ status }) => status === "removed").length;

  const warnings: string[] = [];
  if (baseline.project !== candidate.project) {
    warnings.push(`Project changed from ${baseline.project} to ${candidate.project}.`);
  }
  if (baseline.scoreWithheld || candidate.scoreWithheld) {
    warnings.push("Overall score delta is unavailable because at least one run has a withheld score.");
  }
  if (compatible.status !== "compatible") {
    warnings.push(
      `Evaluation inputs are incompatible; numeric deltas ${metricsComparable ? "were explicitly enabled" : "are withheld"}.`,
    );
    warnings.push(...compatible.differences);
  }
  if (!areas.some(({ status }) => status === "compared")) {
    warnings.push("The reports have no area IDs in common.");
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    baseline: snapshot(baseline),
    candidate: snapshot(candidate),
    overall: {
      scorePct: metric(comparableScore(baseline), comparableScore(candidate), metricsComparable),
      coveragePct: metric(baseline.overallCoveragePct, candidate.overallCoveragePct, metricsComparable),
    },
    compatibility: compatible,
    summary,
    warnings,
    areas,
    tags,
    items,
  };
}

export function comparisonFailures(
  comparison: ComparisonReport,
  thresholds: ComparisonThresholds,
): string[] {
  const failures: string[] = [];
  if (thresholds.requireCompatible && comparison.compatibility.status !== "compatible") {
    failures.push(`evaluation inputs are ${comparison.compatibility.status}: ${comparison.compatibility.differences.join(" ")}`);
  }
  if (thresholds.failOnRegression) {
    const count = comparison.summary.regressed + comparison.summary.lost_coverage + comparison.summary.removed;
    if (count > 0 || comparison.summary.areasRemoved > 0) {
      failures.push(
        `${count} item regression(s) or removals and ${comparison.summary.areasRemoved} removed area(s)`,
      );
    }
  }
  if (thresholds.maxScoreDrop !== undefined) {
    const delta = comparison.overall.scorePct.delta;
    if (delta === null) {
      failures.push(`score delta is unavailable; cannot enforce maximum drop ${thresholds.maxScoreDrop} points`);
    } else if (delta < -thresholds.maxScoreDrop) {
      failures.push(`score dropped ${round(-delta)} points; maximum allowed is ${thresholds.maxScoreDrop}`);
    }
  }
  if (thresholds.maxCoverageDrop !== undefined) {
    const delta = comparison.overall.coveragePct.delta;
    if (delta === null) {
      failures.push(`coverage delta is unavailable; cannot enforce maximum drop ${thresholds.maxCoverageDrop} points`);
    } else if (delta < -thresholds.maxCoverageDrop) {
      failures.push(`coverage dropped ${round(-delta)} points; maximum allowed is ${thresholds.maxCoverageDrop}`);
    }
  }
  return failures;
}

function resolveReportFile(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Comparison input does not exist: ${resolved}`);
  const file = fs.statSync(resolved).isDirectory() ? path.join(resolved, "report.json") : resolved;
  if (!fs.existsSync(file)) throw new Error(`Comparison report does not exist: ${file}`);
  return file;
}

function reportContainsSelectedAreas(report: RunReport, allowPartial: boolean): boolean {
  const selected = report.receipt.inputs.selection.areas;
  const reported = report.areas.map((area) => area.id);
  return selected.every((id): id is string => typeof id === "string") &&
    new Set(selected).size === selected.length &&
    new Set(reported).size === reported.length &&
    reported.every((id) => selected.includes(id)) &&
    (allowPartial || selected.length === reported.length);
}

function loadReport(input: string, allowPartial: boolean): { file: string; report: RunReport } {
  const file = resolveReportFile(input);
  const report = readJson<RunReport>(file);
  const parsed = runReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`Invalid Agent Eval Kit report: ${file}: ${parsed.error.message}`);
  }
  if (!reportContainsSelectedAreas(report, allowPartial)) {
    throw new Error(`Invalid Agent Eval Kit report: ${file}: selected areas do not match reported areas`);
  }
  return { file, report };
}

/** Load a complete report suitable for comparison, publication, or baselines. */
export function loadComparisonInput(input: string): { file: string; report: RunReport } {
  return loadReport(input, false);
}

/** Load a sealed in-progress report whose areas may be a subset of the selected run. */
export function loadResumableRunReport(input: string): { file: string; report: RunReport } {
  return loadReport(input, true);
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const display = (value: number | null, suffix = "%") => value === null ? "—" : `${value}${suffix}`;
const delta = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value}`;

function metricRows(rows: Array<{ name: string; status: string; scorePct: MetricComparison; coveragePct: MetricComparison }>): string {
  return rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.status)}</td><td>${display(row.scorePct.baseline)}</td><td>${display(row.scorePct.candidate)}</td><td>${delta(row.scorePct.delta)}</td><td>${display(row.coveragePct.baseline)}</td><td>${display(row.coveragePct.candidate)}</td><td>${delta(row.coveragePct.delta)}</td></tr>`).join("");
}

export function comparisonHtml(comparison: ComparisonReport): string {
  const changed = comparison.items.filter(({ change }) => change !== "unchanged");
  const warnings = comparison.warnings.length
    ? `<div class="warn"><strong>Notes</strong><ul>${comparison.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";
  const itemRows = changed.map((item) => `<tr><td>${escapeHtml(item.areaId)}</td><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.baselineVerdict ?? "—")}</td><td>${escapeHtml(item.candidateVerdict ?? "—")}</td><td>${display(item.scorePct.baseline)} → ${display(item.scorePct.candidate)}</td><td>${display(item.coveragePct.baseline)} → ${display(item.coveragePct.candidate)}</td><td class="${item.change === "regressed" || item.change === "lost_coverage" || item.change === "removed" ? "bad" : item.change === "improved" || item.change === "gained_coverage" ? "good" : ""}">${escapeHtml(item.change)}</td></tr>`).join("");
  const compatibilityHtml = `<p class="${comparison.compatibility.status === "compatible" ? "good" : "bad"}"><strong>Evaluation inputs:</strong> ${escapeHtml(comparison.compatibility.status)}${comparison.compatibility.overridden ? " (override enabled)" : ""}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(comparison.candidate.project)} comparison</title><style>
body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2328;max-width:1120px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.45rem .65rem;text-align:left}th{background:#f6f8fa}.headline{font-size:1.6rem;font-weight:750}.good{color:#1a7f37;font-weight:650}.bad{color:#cf222e;font-weight:650}.warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;padding:.6rem 1rem}code{font-size:.9em}</style></head><body>
<h1>${escapeHtml(comparison.candidate.project)} evaluation comparison</h1><p><code>${escapeHtml(comparison.baseline.runId)}</code> → <code>${escapeHtml(comparison.candidate.runId)}</code></p>${compatibilityHtml}${warnings}
<p class="headline">Score ${display(comparison.overall.scorePct.candidate)} <span class="${(comparison.overall.scorePct.delta ?? 0) < 0 ? "bad" : "good"}">(${delta(comparison.overall.scorePct.delta)} points)</span> · Coverage ${display(comparison.overall.coveragePct.candidate)} <span class="${(comparison.overall.coveragePct.delta ?? 0) < 0 ? "bad" : "good"}">(${delta(comparison.overall.coveragePct.delta)} points)</span></p>
<p>${comparison.summary.improved} improved · ${comparison.summary.regressed} regressed · ${comparison.summary.gained_coverage} gained coverage · ${comparison.summary.lost_coverage} lost coverage · ${comparison.summary.added} added · ${comparison.summary.removed} removed · ${comparison.summary.unavailable} unavailable</p>
<h2>Areas</h2><table><thead><tr><th>Area</th><th>Status</th><th>Base score</th><th>Candidate</th><th>Δ score</th><th>Base coverage</th><th>Candidate</th><th>Δ coverage</th></tr></thead><tbody>${metricRows(comparison.areas.map((area) => ({ ...area, name: area.title })))}</tbody></table>
<h2>Tags</h2><table><thead><tr><th>Tag</th><th>Status</th><th>Base score</th><th>Candidate</th><th>Δ score</th><th>Base coverage</th><th>Candidate</th><th>Δ coverage</th></tr></thead><tbody>${metricRows(comparison.tags.map((tag) => ({ ...tag, name: tag.tag })))}</tbody></table>
<h2>Changed rubric items</h2>${changed.length ? `<table><thead><tr><th>Area</th><th>Item</th><th>Baseline</th><th>Candidate</th><th>Score</th><th>Coverage</th><th>Change</th></tr></thead><tbody>${itemRows}</tbody></table>` : "<p>No rubric item changed.</p>"}</body></html>`;
}

export function writeComparisonArtifacts(
  outputDir: string,
  comparison: ComparisonReport,
): { json: string; html: string } {
  const resolved = path.resolve(outputDir);
  fs.mkdirSync(resolved, { recursive: true });
  const json = path.join(resolved, "comparison.json");
  const html = path.join(resolved, "comparison.html");
  writeJson(json, comparison);
  fs.writeFileSync(html, comparisonHtml(comparison));
  return { json, html };
}

export function defaultComparisonOutput(candidateFile: string, baselineRunId: string): string {
  return path.join(path.dirname(candidateFile), "comparisons", `vs-${safeName(baselineRunId)}`);
}
