import { omitUndefined } from "./invariants.js";
import fs from "node:fs";
import path from "node:path";
import { runReportSchema } from "./artifact-schemas.js";
import { assertReportAdjudications } from "./adjudication.js";
import { scoreRatios } from "./score-slice.js";
import { readJson, safeName, writeJson } from "./io.js";
import {
  escapeHtml,
  evidenceHtml,
  evidencePreviews,
  reportDocument,
  type ReportEvidence,
} from "./report-presentation.js";
import type {
  AreaResult,
  JudgedItem,
  RunReceipt,
  RunReport,
  ScoreSlice,
  Verdict,
  GateResult,
} from "./types.js";

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
  baseline?: ComparisonDecision;
  candidate?: ComparisonDecision;
  scorePct: MetricComparison;
  coveragePct: MetricComparison;
  change: ItemChange;
}

export interface ComparisonDecision {
  verdict: Verdict;
  confidence: JudgedItem["confidence"];
  reasoning: string;
  evidenceRefs: string[];
  evidence: ReportEvidence[];
  gate?: GateResult;
  adjudication?: Pick<
    NonNullable<JudgedItem["adjudication"]>,
    "verdict" | "reviewer" | "reviewedAt" | "rationale" | "revisionHash"
  > & {
    original: Pick<
      JudgedItem,
      "verdict" | "confidence" | "reasoning" | "evidenceRefs" | "source" | "components"
    >;
  };
  unproven: boolean;
}

function comparisonDecision(item: JudgedItem, area: AreaResult): ComparisonDecision {
  const gate = area.gates.find((gate) => gate.itemId === item.id);
  return {
    verdict: item.verdict,
    confidence: item.confidence,
    reasoning: item.reasoning,
    evidenceRefs: item.evidenceRefs,
    evidence: evidencePreviews(
      [
        ...new Set([
          ...item.evidenceRefs,
          ...(item.comparisons ?? []),
          ...(item.adjudication?.evidence.map((entry) => entry.path) ?? []),
        ]),
      ],
      area.scenarios,
    ),
    ...(gate ? { gate } : {}),
    ...(item.adjudication
      ? {
          adjudication: {
            verdict: item.adjudication.verdict,
            reviewer: item.adjudication.reviewer,
            reviewedAt: item.adjudication.reviewedAt,
            rationale: item.adjudication.rationale,
            revisionHash: item.adjudication.revisionHash,
            original: {
              verdict: item.adjudication.original.verdict,
              confidence: item.adjudication.original.confidence,
              reasoning: item.adjudication.original.reasoning,
              evidenceRefs: item.adjudication.original.evidenceRefs,
              source: item.adjudication.original.source,
              ...(item.adjudication.original.components
                ? { components: item.adjudication.original.components }
                : {}),
            },
          },
        }
      : {}),
    unproven: area.unproven.includes(item.id),
  };
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

function metric(
  baseline: number | null,
  candidate: number | null,
  comparable = true,
): MetricComparison {
  return {
    baseline,
    candidate,
    delta:
      !comparable || baseline === null || candidate === null ? null : round(candidate - baseline),
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
    ...(report.receipt.target.git === undefined ? {} : { git: report.receipt.target.git }),
    ...(report.receipt.target.treeSha256 === undefined
      ? {}
      : { treeSha256: report.receipt.target.treeSha256 }),
  };
}

function unionById<T extends { id: string }>(baseline: T[], candidate: T[]): string[] {
  return [...new Set([...baseline.map(({ id }) => id), ...candidate.map(({ id }) => id)])];
}

function areaComparison(
  baseline: AreaResult | undefined,
  candidate: AreaResult | undefined,
  comparable: boolean,
): AreaComparison {
  const status = !baseline ? "added" : !candidate ? "removed" : "compared";
  return {
    id: (candidate ?? baseline)!.id,
    title: (candidate ?? baseline)!.title,
    status,
    scorePct: metric(baseline?.scorePct ?? null, candidate?.scorePct ?? null, comparable),
    coveragePct: metric(baseline?.coveragePct ?? null, candidate?.coveragePct ?? null, comparable),
  };
}

function tagComparison(
  tag: string,
  baseline: ScoreSlice | undefined,
  candidate: ScoreSlice | undefined,
  comparable: boolean,
): TagComparison {
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

function recordHashes<T extends { sha256: string }>(
  value: Record<string, T> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([name, receipt]) => [name, receipt.sha256]),
  );
}

function compatibility(
  baseline: RunReceipt,
  candidate: RunReceipt,
  overridden: boolean,
): ComparisonCompatibility {
  for (const [label, receipt] of [
    ["Baseline", baseline],
    ["Candidate", candidate],
  ] as const) {
    const methods = receipt.inputs.specMethods;
    if (
      !methods ||
      stableValue(Object.keys(methods).sort()) !==
        stableValue(Object.keys(receipt.inputs.specs).sort()) ||
      Object.values(methods).some((hash) => typeof hash !== "string" || !hash.trim())
    )
      throw new Error(
        `${label} receipt is missing complete spec method hashes. Restore the complete receipt or start a new run; comparison cannot reconstruct evaluator provenance.`,
      );
  }
  if (baseline.evaluationFingerprint === candidate.evaluationFingerprint) {
    return { status: "compatible", differences: [], overridden };
  }
  const differences: string[] = [];
  if (baseline.inputs.methodSha256 !== candidate.inputs.methodSha256) {
    differences.push(
      "Evaluator configuration, provider version, scoring, variables, or instructions changed.",
    );
  }
  if (
    stableValue(recordHashes(baseline.inputs.graderMethods)) !==
    stableValue(recordHashes(candidate.inputs.graderMethods))
  ) {
    differences.push("One or more declared command grader method files changed.");
  }
  if (stableValue(baseline.inputs.selection) !== stableValue(candidate.inputs.selection)) {
    differences.push("Selected areas, scenarios, or text cases changed.");
  }
  if (stableValue(baseline.inputs.specMethods) !== stableValue(candidate.inputs.specMethods)) {
    differences.push("One or more evaluation specs changed.");
  }
  if (
    stableValue(recordHashes(baseline.inputs.textReferences)) !==
    stableValue(recordHashes(candidate.inputs.textReferences))
  ) {
    differences.push("One or more text references or style targets changed.");
  }
  const beforeFixtures = baseline.inputs.fixtures;
  const afterFixtures = candidate.inputs.fixtures;
  if (beforeFixtures?.manifest.sha256 !== afterFixtures?.manifest.sha256) {
    differences.push("The fixture manifest changed.");
  }
  if (
    stableValue(recordHashes(beforeFixtures?.files)) !==
    stableValue(recordHashes(afterFixtures?.files))
  ) {
    differences.push("One or more fixture files changed.");
  }
  if (!differences.length)
    differences.push("The evaluation fingerprint changed for an unknown reason.");
  return { status: "incompatible", differences, overridden };
}

function stableValue(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function compareReports(
  baseline: RunReport,
  candidate: RunReport,
  options: { allowIncompatible?: boolean } = {},
): ComparisonReport {
  const compatible = compatibility(
    baseline.receipt,
    candidate.receipt,
    Boolean(options.allowIncompatible),
  );
  const metricsComparable =
    compatible.status === "compatible" || Boolean(options.allowIncompatible);
  const baselineAreas = new Map(baseline.areas.map((area) => [area.id, area]));
  const candidateAreas = new Map(candidate.areas.map((area) => [area.id, area]));
  const areaIds = unionById(baseline.areas, candidate.areas);
  const areas = areaIds.map((id) =>
    areaComparison(baselineAreas.get(id), candidateAreas.get(id), metricsComparable),
  );
  const tags = [...new Set([...Object.keys(baseline.byTag), ...Object.keys(candidate.byTag)])]
    .sort()
    .map((tag) => tagComparison(tag, baseline.byTag[tag], candidate.byTag[tag], metricsComparable));
  const items: ItemComparison[] = [];
  for (const areaId of areaIds) {
    const baselineArea = baselineAreas.get(areaId);
    const candidateArea = candidateAreas.get(areaId);
    const unavailableIfUnproven = (item: JudgedItem, area: AreaResult | undefined): JudgedItem =>
      area?.unproven.includes(item.id)
        ? omitUndefined({
            ...item,
            verdict: "cannot_judge" as const,
            confidence: "low" as const,
            score:
              item.score && !item.components
                ? { ...item.score, earned: 0, judgeable: 0, scorePct: null, coveragePct: 0 }
                : item.score,
          })
        : item;
    const beforeItems = (baselineArea?.items ?? []).map((item) =>
      unavailableIfUnproven(item, baselineArea),
    );
    const afterItems = (candidateArea?.items ?? []).map((item) =>
      unavailableIfUnproven(item, candidateArea),
    );
    const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
    const afterById = new Map(afterItems.map((item) => [item.id, item]));
    for (const id of unionById(beforeItems, afterItems)) {
      const before = beforeById.get(id);
      const after = afterById.get(id);
      items.push({
        areaId,
        id,
        ...(before?.verdict === undefined ? {} : { baselineVerdict: before?.verdict }),
        ...(after?.verdict === undefined ? {} : { candidateVerdict: after?.verdict }),
        ...(before ? { baseline: comparisonDecision(before, baselineArea!) } : {}),
        ...(after ? { candidate: comparisonDecision(after, candidateArea!) } : {}),
        scorePct: metric(
          before?.score?.scorePct ?? null,
          after?.score?.scorePct ?? null,
          metricsComparable,
        ),
        coveragePct: metric(
          before?.score?.coveragePct ?? null,
          after?.score?.coveragePct ?? null,
          metricsComparable,
        ),
        change: before && after && !metricsComparable ? "unavailable" : itemChange(before, after),
      });
    }
  }

  const changes: ItemChange[] = [
    "improved",
    "regressed",
    "unchanged",
    "changed",
    "unavailable",
    "gained_coverage",
    "lost_coverage",
    "added",
    "removed",
  ];
  const summary = Object.fromEntries(
    changes.map((change) => [change, 0]),
  ) as ComparisonReport["summary"];
  for (const item of items) summary[item.change]++;
  summary.areasAdded = areas.filter(({ status }) => status === "added").length;
  summary.areasRemoved = areas.filter(({ status }) => status === "removed").length;

  const warnings: string[] = [];
  if (baseline.project !== candidate.project) {
    warnings.push(`Project changed from ${baseline.project} to ${candidate.project}.`);
  }
  if (baseline.scoreWithheld || candidate.scoreWithheld) {
    warnings.push(
      "Overall score delta is unavailable because at least one run has a withheld score.",
    );
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
      coveragePct: metric(
        baseline.overallCoveragePct,
        candidate.overallCoveragePct,
        metricsComparable,
      ),
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
    failures.push(
      `evaluation inputs are ${comparison.compatibility.status}: ${comparison.compatibility.differences.join(" ")}`,
    );
  }
  if (thresholds.failOnRegression) {
    const count =
      comparison.summary.regressed + comparison.summary.lost_coverage + comparison.summary.removed;
    if (count > 0 || comparison.summary.areasRemoved > 0) {
      failures.push(
        `${count} item regression(s) or removals and ${comparison.summary.areasRemoved} removed area(s)`,
      );
    }
  }
  if (thresholds.maxScoreDrop !== undefined) {
    const delta = comparison.overall.scorePct.delta;
    if (delta === null) {
      failures.push(
        `score delta is unavailable; cannot enforce maximum drop ${thresholds.maxScoreDrop} points`,
      );
    } else if (delta < -thresholds.maxScoreDrop) {
      failures.push(
        `score dropped ${round(-delta)} points; maximum allowed is ${thresholds.maxScoreDrop}`,
      );
    }
  }
  if (thresholds.maxCoverageDrop !== undefined) {
    const delta = comparison.overall.coveragePct.delta;
    if (delta === null) {
      failures.push(
        `coverage delta is unavailable; cannot enforce maximum drop ${thresholds.maxCoverageDrop} points`,
      );
    } else if (delta < -thresholds.maxCoverageDrop) {
      failures.push(
        `coverage dropped ${round(-delta)} points; maximum allowed is ${thresholds.maxCoverageDrop}`,
      );
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
  return (
    selected.every((id): id is string => typeof id === "string") &&
    new Set(selected).size === selected.length &&
    new Set(reported).size === reported.length &&
    reported.every((id) => selected.includes(id)) &&
    (allowPartial || selected.length === reported.length)
  );
}

function loadReport(input: string, allowPartial: boolean): { file: string; report: RunReport } {
  const file = resolveReportFile(input);
  const report = readJson<RunReport>(file);
  const parsed = runReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(`Invalid Agent Eval Kit report: ${file}: ${parsed.error.message}`);
  }
  assertReportAdjudications(report);
  if (!reportContainsSelectedAreas(report, allowPartial)) {
    throw new Error(
      `Invalid Agent Eval Kit report: ${file}: selected areas do not match reported areas`,
    );
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

const display = (value: number | null, suffix = "%") =>
  value === null ? "—" : `${value}${suffix}`;
const delta = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : ""}${value}`);

function metricRows(
  rows: Array<{
    name: string;
    status: string;
    scorePct: MetricComparison;
    coveragePct: MetricComparison;
  }>,
): string {
  return rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.status)}</td><td>${display(row.scorePct.baseline)}</td><td>${display(row.scorePct.candidate)}</td><td>${delta(row.scorePct.delta)}</td><td>${display(row.coveragePct.baseline)}</td><td>${display(row.coveragePct.candidate)}</td><td>${delta(row.coveragePct.delta)}</td></tr>`,
    )
    .join("");
}

export interface ComparisonPresentation {
  outputDir: string;
  baselineFile: string;
  candidateFile: string;
}

export function comparisonHtml(
  comparison: ComparisonReport,
  context?: ComparisonPresentation,
): string {
  const warnings = comparison.warnings.length
    ? `<div class="warn"><strong>Notes</strong><ul>${comparison.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";
  const decision = (item: ItemComparison, side: "baseline" | "candidate") => {
    const detail = item[side];
    if (!detail)
      return `<div class="decision"><h3>${side === "baseline" ? "Baseline" : "Candidate"}</h3><p>Item absent.</p></div>`;
    const evidenceContext = context && {
      outputDir: context.outputDir,
      runDir: path.dirname(side === "baseline" ? context.baselineFile : context.candidateFile),
      areaId: item.areaId,
    };
    const adjudication = detail.adjudication;
    const explanation = adjudication
      ? `<p><strong>Human adjudication: ${escapeHtml(adjudication.verdict)}</strong> · ${escapeHtml(adjudication.reviewer)} · ${escapeHtml(adjudication.reviewedAt)}</p><p class="reasoning">${escapeHtml(adjudication.rationale)}</p><p>Original automatic decision: <strong>${escapeHtml(adjudication.original.components?.automatic ?? adjudication.original.verdict)}</strong> (${escapeHtml(adjudication.original.confidence)} confidence; ${escapeHtml(adjudication.original.source)})</p><p class="reasoning">${escapeHtml(adjudication.original.reasoning)}</p><p>Adjudication revision: <code>${escapeHtml(adjudication.revisionHash)}</code></p>`
      : `<p class="reasoning">${escapeHtml(detail.reasoning)}</p>`;
    return `<div class="decision"><h3>${side === "baseline" ? "Baseline" : "Candidate"}: ${escapeHtml(detail.verdict)}</h3><p>${escapeHtml(detail.confidence)} confidence${detail.gate ? ` · Critical gate: <strong>${escapeHtml(detail.gate.status)}</strong> — ${escapeHtml(detail.gate.reason)}` : ""}</p>${detail.unproven ? '<p class="warn">Automatic decision is unproven; treated as unavailable coverage.</p>' : ""}${explanation}${evidenceHtml(detail.evidence, evidenceContext)}</div>`;
  };
  const items = comparison.items
    .map((item) => {
      const critical = Boolean(item.baseline?.gate || item.candidate?.gate);
      const bad = ["regressed", "lost_coverage", "removed"].includes(item.change);
      return `<section data-comparison-item data-change="${item.change}" data-critical="${critical}"><h3>${escapeHtml(item.areaId)}/${escapeHtml(item.id)} · <span class="${bad ? "bad" : ""}">${escapeHtml(item.change)}</span>${critical ? " · Critical gate" : ""}</h3><p>Score ${display(item.scorePct.baseline)} → ${display(item.scorePct.candidate)} · Coverage ${display(item.coveragePct.baseline)} → ${display(item.coveragePct.candidate)}</p><div class="decisions">${decision(item, "baseline")}${decision(item, "candidate")}</div></section>`;
    })
    .join("");
  const compatibilityHtml = `<p class="${comparison.compatibility.status === "compatible" ? "good" : "bad"}"><strong>Evaluation inputs:</strong> ${escapeHtml(comparison.compatibility.status)}${comparison.compatibility.overridden ? " (override enabled)" : ""}</p>`;
  const body = `<h1>${escapeHtml(comparison.candidate.project)} evaluation comparison</h1><p><code>${escapeHtml(comparison.baseline.runId)}</code> → <code>${escapeHtml(comparison.candidate.runId)}</code></p>${compatibilityHtml}${warnings}
<p class="headline">Score ${display(comparison.overall.scorePct.candidate)} (${delta(comparison.overall.scorePct.delta)} points) · Coverage ${display(comparison.overall.coveragePct.candidate)} (${delta(comparison.overall.coveragePct.delta)} points)</p>
<p>${comparison.summary.improved} improved · ${comparison.summary.regressed} regressed · ${comparison.summary.gained_coverage} gained coverage · ${comparison.summary.lost_coverage} lost coverage · ${comparison.summary.added} added · ${comparison.summary.removed} removed · ${comparison.summary.unavailable} unavailable</p>
<h2>Areas</h2><div class="table-scroll"><table><thead><tr><th>Area</th><th>Status</th><th>Base score</th><th>Candidate</th><th>Δ score</th><th>Base coverage</th><th>Candidate</th><th>Δ coverage</th></tr></thead><tbody>${metricRows(comparison.areas.map((area) => ({ ...area, name: area.title })))}</tbody></table></div>
<h2>Tags</h2><div class="table-scroll"><table><thead><tr><th>Tag</th><th>Status</th><th>Base score</th><th>Candidate</th><th>Δ score</th><th>Base coverage</th><th>Candidate</th><th>Δ coverage</th></tr></thead><tbody>${metricRows(comparison.tags.map((tag) => ({ ...tag, name: tag.tag })))}</tbody></table></div>
<h2>Rubric decisions and evidence</h2><div class="filters"><label>Show <select id="change-filter"><option value="all">All items</option><option value="changed">Changed items</option><option value="regressed">Regressions</option><option value="lost_coverage">Lost coverage</option></select></label><label><input type="checkbox" id="critical-filter"> Critical gates only</label></div><p id="filter-count" aria-live="polite">${comparison.items.length} items</p>${items || "<p>No rubric items.</p>"}`;
  return reportDocument(
    `${comparison.candidate.project} comparison`,
    body,
    `
const change = document.getElementById('change-filter');
const critical = document.getElementById('critical-filter');
function filterItems() {
  let visible = 0;
  for (const item of document.querySelectorAll('[data-comparison-item]')) {
    const matches = change.value === 'all' || (change.value === 'changed' ? item.dataset.change !== 'unchanged' : item.dataset.change === change.value);
    item.hidden = !matches || (critical.checked && item.dataset.critical !== 'true');
    if (!item.hidden) visible++;
  }
  document.getElementById('filter-count').textContent = visible + ' items';
}
change.addEventListener('change', filterItems);
critical.addEventListener('change', filterItems);
`,
  );
}

export function writeComparisonArtifacts(
  outputDir: string,
  comparison: ComparisonReport,
  sources?: { baselineFile: string; candidateFile: string },
): { json: string; html: string } {
  const resolved = path.resolve(outputDir);
  fs.mkdirSync(resolved, { recursive: true });
  const json = path.join(resolved, "comparison.json");
  const html = path.join(resolved, "comparison.html");
  writeJson(json, comparison);
  fs.writeFileSync(
    html,
    comparisonHtml(comparison, sources && { ...sources, outputDir: resolved }),
  );
  return { json, html };
}

export function defaultComparisonOutput(candidateFile: string, baselineRunId: string): string {
  return path.join(path.dirname(candidateFile), "comparisons", `vs-${safeName(baselineRunId)}`);
}
