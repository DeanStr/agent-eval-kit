import { evidenceHtml, evidencePreviews, reportDocument } from "./report-presentation.js";
import { omitUndefined, requireDefined } from "./invariants.js";
import { scoringConfigPath, scoringDefinitionFiles } from "./run/inputs.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertArtifactIntegrity, verifyArtifactIndex, writeArtifactIndex } from "./integrity.js";
import { isWithin, readJson, sha256, stableJson, writeJson } from "./io.js";
import { buildReport, hybridAggregateVerdict, scoreArea } from "./scoring.js";
import { automaticAbstained, prepareAdjudications } from "./adjudication.js";
import { shellQuote } from "./cli-recovery.js";
import { formatDuration, formatNumber, formatPct, formatTimestamp, plural } from "./format.js";
import { DEFAULT_RUBRIC_TAG } from "./specs.js";
import type {
  AreaResult,
  EvalConfig,
  EvalSpec,
  JudgedItem,
  JudgedVotes,
  RubricItem,
  RunReport,
  Verdict,
} from "./types.js";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const verdictColor: Record<Verdict, string> = {
  pass: "#1a7f37",
  partial: "#9a6700",
  fail: "#cf222e",
  not_found: "#cf222e",
  cannot_judge: "#6e7781",
};

interface ManualResultEntry {
  verdict: string;
  notes?: string;
  reviewer?: string;
  reviewedAt?: string;
  previousHash?: string;
  revisionHash?: string;
}

interface ManualRevision {
  schemaVersion: 1;
  itemId: string;
  verdict: Exclude<Verdict, "cannot_judge">;
  notes: string;
  reviewer: string;
  reviewedAt: string;
  previousHash?: string;
  revisionHash: string;
}

interface ReportUpdateTransaction {
  schemaVersion: 1;
  originalIndexRootSha256?: string;
  files: Array<{ path: string; sha256: string }>;
  /** Conditional report files the updated report no longer needs. */
  removed: string[];
}

const REPORT_UPDATE_TRANSACTION_DIRECTORY = ".aek-report-update.tmp-active";
const ADJUDICATION_CHECKLIST = "adjudication-checklist.md";
/** Report files that exist only when relevant; a report update removes them when not staged. */
const CONDITIONAL_REPORT_FILES = [ADJUDICATION_CHECKLIST];
const REPORT_UPDATE_FILES = new Set([
  "manual-checklist.md",
  "manual-results.json",
  "manual-revisions.ndjson",
  ADJUDICATION_CHECKLIST,
  "adjudications.ndjson",
  "receipt.json",
  "report.html",
  "report.json",
]);
const reportUpdatePath = (file: string) =>
  REPORT_UPDATE_FILES.has(file) ||
  /^adjudication-evidence\/[a-f0-9]{64}$/.test(file) ||
  file === scoringConfigPath ||
  /^scoring-definitions\/specs\/[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/.test(file);
export const MANUAL_PLACEHOLDER = "pass | partial | fail | not_found";

export function writeManualFiles(
  runDir: string,
  report: RunReport,
  specs: EvalSpec[],
  displayedRunDir = runDir,
): void {
  const existingFile = path.join(runDir, "manual-results.json");
  const existing = fs.existsSync(existingFile)
    ? readJson<Record<string, ManualResultEntry>>(existingFile)
    : {};
  const template: Record<string, ManualResultEntry> = Object.create(null);
  const runDirectory = path.resolve(displayedRunDir);
  const lines = [
    "# Manual verification checklist",
    "",
    `Project: ${report.project}`,
    `Run: ${runDirectory}`,
    "",
    "Answer a prompt for each item:",
    "",
    "```sh",
    `aek finalize --run ${shellQuote(runDirectory)} --interactive`,
    "```",
    "",
    "Or record each result in `manual-results.json`, then run:",
    "",
    "```sh",
    `aek finalize --run ${shellQuote(runDirectory)}`,
    "```",
    "",
    "Add `--reviewer <name>` to record a reviewer other than your login name.",
    "Allowed verdicts: `pass`, `partial`, `fail`, `not_found`.",
    "",
  ];
  for (const area of report.areas) {
    if (!area.pendingManual.length) continue;
    const spec = specs.find((candidate) => candidate.id === area.id);
    if (!spec)
      throw new Error(`Cannot write manual checklist: no spec exists for report area ${area.id}`);
    lines.push(`## ${area.title}`, "");
    for (const id of area.pendingManual) {
      const rubric = spec.rubric.find((candidate) => candidate.id === id);
      if (!rubric)
        throw new Error(`Cannot write manual checklist: no rubric ${id} exists in area ${area.id}`);
      const automatic = area.items.find((item) => item.id === id);
      lines.push(
        `### ${rubric.id} (weight ${rubric.weight}) — ${rubric.criterion}`,
        "",
        `- Pass when: ${rubric.passCriteria}`,
        `- Verify: ${rubric.manualInstructions ?? rubric.evidence ?? rubric.passCriteria}`,
        automatic
          ? `- Automatic evidence: ${automatic.components?.automatic ?? "cannot_judge"} — ${automatic.reasoning}`
          : "",
        "",
      );
      const prior = Object.hasOwn(existing, id) ? existing[id] : undefined;
      template[id] = prior
        ? { ...prior, notes: prior.notes ?? "" }
        : { verdict: MANUAL_PLACEHOLDER, notes: "" };
    }
  }
  fs.writeFileSync(path.join(runDir, "manual-checklist.md"), `${lines.join("\n")}\n`);
  const results: Record<string, ManualResultEntry> = Object.assign(
    Object.create(null),
    template,
    existing,
  );
  writeJson(existingFile, results);
}

/** Automatic abstentions eligible for human adjudication, including already adjudicated ones. */
function adjudicationCandidates(
  report: RunReport,
  specs: EvalSpec[],
): Array<{ area: AreaResult; item: JudgedItem; rubric: RubricItem }> {
  return report.areas.flatMap((area) => {
    const spec = specs.find((candidate) => candidate.id === area.id);
    if (!spec) throw new Error(`Cannot list adjudication candidates: no spec for ${area.id}`);
    return area.items.flatMap((item) => {
      const rubric = spec.rubric.find((candidate) => candidate.id === item.id);
      if (!rubric)
        throw new Error(`Cannot list adjudication candidates: no rubric for ${area.id}/${item.id}`);
      return automaticAbstained(item, rubric) || item.adjudication ? [{ area, item, rubric }] : [];
    });
  });
}

/** Written only when something is eligible; a stale checklist from an earlier state is removed. */
function writeAdjudicationChecklist(
  runDir: string,
  report: RunReport,
  specs: EvalSpec[],
  displayedRunDir = runDir,
): void {
  const file = path.join(runDir, ADJUDICATION_CHECKLIST);
  const candidates = adjudicationCandidates(report, specs);
  if (!candidates.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  const lines = [
    "# Human adjudication of automatic abstentions",
    "",
    "Review the entire automatic criterion. Hybrid manual shares still use `aek finalize`.",
    "Create a decision JSON outside the run directory, then run:",
    "",
    "```sh",
    `aek adjudicate --run ${shellQuote(path.resolve(displayedRunDir))} --input <decisions.json> --reviewer <name>`,
    "```",
    "",
    "Each decision requires areaId, itemId, previousRevision, verdict, rationale, and evidence.",
    "Use previousRevision: null for a first decision, or the current revision hash for a correction.",
    "See docs/adjudication.md for the input format and evidence requirements.",
    "",
  ];
  for (const { area, item, rubric } of candidates) {
    lines.push(
      `## ${area.id}/${item.id}`,
      "",
      rubric.criterion,
      `Pass criteria: ${rubric.passCriteria}`,
      `Original automatic result: cannot_judge — ${(item.adjudication?.original ?? item).reasoning}`,
      `Current human decision: ${item.adjudication?.verdict ?? "none"}`,
      `previousRevision: ${item.adjudication?.revisionHash ?? "null"}`,
      "",
    );
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function adjudicationHtml(item: JudgedItem): string {
  const record = item.adjudication;
  if (!record) return "";
  return `<details open><summary><strong>Human adjudication: ${escapeHtml(record.verdict)}</strong></summary><p>${escapeHtml(record.reviewer)} · ${escapeHtml(record.reviewedAt)}</p><p>${escapeHtml(record.rationale)}</p><p>Original automatic result: <strong>cannot_judge</strong> (${escapeHtml(record.original.confidence)} confidence) — ${escapeHtml(record.original.reasoning)}</p><ul>${record.evidence.map((entry) => `<li>${entry.kind === "human" ? "New human evidence" : "Original collected artifact"}: <a download="${escapeHtml(entry.filename ?? path.posix.basename(entry.path))}" href="${entry.path.split("/").map(encodeURIComponent).join("/")}">${escapeHtml(entry.description)}</a>${entry.observedAt ? ` · observed ${escapeHtml(entry.observedAt)}` : ""}<br><code>${entry.sha256}</code></li>`).join("")}</ul><small>Revision: <code>${record.revisionHash}</code> · <a href="adjudications.ndjson" download>Full audit history</a></small><p>Adjudication changes rubric scoring. Scenario outcomes, defects, and automatic case/stratum results retain their original observations.</p></details>`;
}

const weight = (value: number) => formatNumber(value, 2);
const weightBreakdown = (value: { earned: number; judgeable: number; total: number }) =>
  `${weight(value.earned)} / ${weight(value.judgeable)} / ${weight(value.total)}`;
const gateClass = { passed: "good", failed: "bad", unavailable: "muted" } as const;

/** Per-vote details stay collapsed; the tally is visible without expanding. */
function votesHtml(votes: JudgedVotes | undefined): string {
  if (!votes) return "";
  const tally = Object.entries(votes.counts)
    .map(([outcome, count]) => `${escapeHtml(outcome)} ${count}`)
    .join(" · ");
  const summary = `${plural(votes.attempted, "vote")}: ${tally} (${votes.judgeable} judgeable)`;
  if (!votes.ballots) return `<p>${summary}</p>`;
  return `<details class="votes"><summary>${summary}</summary><ol class="ballots">${votes.ballots.map((ballot) => `<li><strong style="color:${verdictColor[ballot.verdict]}">${escapeHtml(ballot.verdict)}</strong> · ${escapeHtml(ballot.confidence)} confidence${ballot.outcome === "abstain" ? " · counted as abstain" : ""}<br>${escapeHtml(ballot.reasoning)}</li>`).join("")}</ol></details>`;
}

function tableRows(report: RunReport): string {
  return report.areas
    .map(
      (area) => `<tr>
        <td><a href="#area-${escapeHtml(area.id)}">${escapeHtml(area.title)}</a>${area.optional ? " <em>(optional)</em>" : ""}</td>
        <td>${area.optional ? "—" : area.weight}</td><td>${formatPct(area.scorePct)}</td>
        <td class="${area.total > 0 && area.coveragePct < 60 ? "low" : ""}">${area.total === 0 && area.exclusions?.length ? "not applicable" : formatPct(area.coveragePct)}</td>
        <td>${weightBreakdown(area)}</td><td>${area.pendingManual.length}</td>
      </tr>`,
    )
    .join("");
}

/** Tags are diagnostic only when some rubric item declared one beyond the implicit default. */
function tagRows(report: RunReport): string {
  if (Object.keys(report.byTag).every((tag) => tag === DEFAULT_RUBRIC_TAG)) return "";
  return Object.entries(report.byTag)
    .sort((a, b) => (a[1].scorePct ?? -1) - (b[1].scorePct ?? -1))
    .map(
      ([tag, value]) =>
        `<tr><td><code>${escapeHtml(tag)}</code></td><td>${formatPct(value.scorePct)}</td><td>${formatPct(value.coveragePct)}</td><td>${weightBreakdown(value)}</td></tr>`,
    )
    .join("");
}

function stratumRows(report: RunReport): string {
  return Object.entries(report.byStratum)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(
      ([stratum, value]) =>
        `<tr><td><code>${escapeHtml(stratum)}</code></td><td>${formatPct(value.scorePct)}</td><td>${formatPct(value.coveragePct)}</td><td>${value.cases}</td></tr>`,
    )
    .join("");
}

function areaSections(report: RunReport, specs: EvalSpec[], runDir: string): string {
  return report.areas
    .map((area) => {
      const spec = requireDefined(
        specs.find((entry) => entry.id === area.id),
        `Report spec ${area.id}`,
      );
      const evidence = (refs: string[]) => {
        const manual = refs.filter((ref) => /^manual-revision:[a-f0-9]{64}$/.test(ref));
        const artifacts = refs.filter((ref) => !manual.includes(ref));
        return (
          (artifacts.length || !manual.length
            ? evidenceHtml(evidencePreviews(artifacts, area.scenarios), {
                outputDir: runDir,
                runDir,
                areaId: area.id,
              })
            : "") +
          manual
            .map(
              (ref) =>
                `<p>Manual review revision <code>${escapeHtml(ref.slice("manual-revision:".length))}</code> · <a href="manual-revisions.ndjson" download>Review history</a></p>`,
            )
            .join("")
        );
      };
      const itemRows =
        area.items
          .map((item) => {
            const rubric = requireDefined(
              spec.rubric.find((entry) => entry.id === item.id),
              `Report criterion ${area.id}/${item.id}`,
            );
            const pending = area.pendingManual.includes(item.id);
            const unproven = area.unproven.includes(item.id);
            const verdict = unproven ? "cannot_judge" : item.verdict;
            return `<tr data-result="${verdict}" data-pending="${pending}"><td class="criterion"><strong>${escapeHtml(rubric.criterion)}</strong><br><code>${escapeHtml(item.id)}</code>${rubric.gate ? " · Critical gate" : ""}<details><summary>Pass criteria</summary>${escapeHtml(rubric.passCriteria)}</details></td><td style="color:${verdictColor[verdict]};font-weight:650">${escapeHtml(verdict)}${pending ? "<br>Pending manual share" : ""}</td><td>${escapeHtml(unproven ? "—" : item.confidence)}</td><td>${unproven ? `<p class="warn">Automatic verdict discarded (${escapeHtml(item.components?.automatic ?? item.verdict)}): no backing scenario was reached. This reduces coverage.${item.components?.manual ? ` Manual verdict retained: ${escapeHtml(item.components.manual)}.` : ""}</p>` : ""}<p>${escapeHtml(item.reasoning)}</p>${votesHtml(item.votes)}${(
              item.comparisons ?? []
            )
              .filter(
                (ref) =>
                  /^areas\/[A-Za-z0-9._/-]+\/comparison\.html$/.test(ref) &&
                  !ref.split("/").includes(".."),
              )
              .map(
                (ref, index) =>
                  `<a href="${ref.split("/").map(encodeURIComponent).join("/")}">Comparison ${index + 1}</a>`,
              )
              .join(" · ")}
          <details${verdict !== "pass" ? " open" : ""}><summary>Cited evidence (${item.evidenceRefs.length})</summary>${evidence(item.evidenceRefs)}</details>${adjudicationHtml(item)}</td></tr>`;
          })
          .join("") +
        area.pendingManual
          .filter((id) => !area.items.some((item) => item.id === id))
          .map((id) => {
            const rubric = requireDefined(
              spec.rubric.find((item) => item.id === id),
              `Pending criterion ${id}`,
            );
            return `<tr data-result="pending" data-pending="true"><td class="criterion"><strong>${escapeHtml(rubric.criterion)}</strong><br><code>${escapeHtml(id)}</code><details><summary>Pass criteria</summary>${escapeHtml(rubric.passCriteria)}</details></td><td>Pending manual review</td><td>—</td><td>${escapeHtml(rubric.manualInstructions ?? rubric.passCriteria)}<p><a href="manual-checklist.md">Review checklist</a> · <a href="manual-results.json">Decision file</a></p></td></tr>`;
          })
          .join("");
      const scenarios = area.scenarios
        .map((scenario) => {
          const shots = scenario.screenshots
            .map((shot) => {
              const href = `${encodeURIComponent(scenario.scenarioId)}/${shot.path.split("/").map(encodeURIComponent).join("/")}`;
              return `<figure><a href="${href}"><img loading="lazy" src="${href}" width="320" alt="${escapeHtml(shot.label)}"></a><figcaption>${escapeHtml(shot.label)} (step ${shot.step}${shot.persona ? ` · ${escapeHtml(shot.persona)}` : ""})</figcaption></figure>`;
            })
            .join("");
          return `<details><summary><strong>${escapeHtml(scenario.scenarioId)}</strong> — ${escapeHtml(scenario.outcome)} · ${(scenario.durationMs / 1000).toFixed(1)}s</summary><p>${escapeHtml(scenario.summary)}</p>${Object.keys(scenario.inputs ?? {}).length || Object.keys(scenario.outputs ?? {}).length ? `<details><summary>Workflow inputs and outputs</summary><pre>${escapeHtml(JSON.stringify({ inputs: scenario.inputs, outputs: scenario.outputs }, null, 2))}</pre></details>` : ""}${scenario.captureChecks?.length ? `<ul>${scenario.captureChecks.map((check) => `<li>${escapeHtml(check.name)}: ${check.pass ? "pass" : "fail"}${check.actual === undefined ? "" : ` (${check.actual})`}</li>`).join("")}</ul>` : ""}${scenario.error ? `<p class="low">${escapeHtml(scenario.error)}</p>` : ""}<ul>${scenario.observations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${scenario.files?.length ? `<h4>Files</h4><ul>${scenario.files.map((file) => `<li><a download="${escapeHtml(file.filename)}" href="${encodeURIComponent(scenario.scenarioId)}/${file.path.split("/").map(encodeURIComponent).join("/")}">${escapeHtml(file.filename)}</a> · ${escapeHtml(file.mediaType)} · ${file.bytes} bytes · step ${file.step}${file.persona ? ` · ${escapeHtml(file.persona)}` : ""}<br><code>${file.sha256}</code></li>`).join("")}</ul>` : ""}${Object.keys(scenario.checkpoints ?? {}).length ? `<h4>Exercised checkpoints</h4><pre>${escapeHtml(JSON.stringify(scenario.checkpoints, null, 2))}</pre>` : ""}<div class="shots">${shots}</div></details>`;
        })
        .join("");
      const caseRows = area.caseResults
        .map(
          (item) =>
            `<tr><td>${escapeHtml(item.rubricId)}</td><td>${escapeHtml(item.caseId)}</td><td>${escapeHtml(item.split ?? "all")}</td><td>${escapeHtml(item.strata.join(", ") || "—")}</td><td style="color:${verdictColor[item.verdict]};font-weight:650">${escapeHtml(item.verdict)}</td><td>${escapeHtml(item.reasoning)}${votesHtml(item.votes)}</td></tr>`,
        )
        .join("");
      const casesHtml = caseRows
        ? `<h3>Case results</h3><table><thead><tr><th>Rubric</th><th>Case</th><th>Split</th><th>Strata</th><th>Verdict</th><th>Reasoning</th></tr></thead><tbody>${caseRows}</tbody></table>`
        : "";
      const defects = area.defects.length
        ? `<h3>Defects</h3><ul>${area.defects.map((defect) => `<li><strong>${escapeHtml(defect.severity)}</strong>: ${escapeHtml(defect.description)} ${evidence(defect.evidenceRefs)}</li>`).join("")}</ul>`
        : "";
      const incomplete = area.scenarios.filter((scenario) => scenario.outcome !== "completed");
      const incompleteHtml = incomplete.length
        ? `<p class="warn"><strong>${incomplete.length} of ${area.scenarios.length} scenarios did not complete.</strong><br>${incomplete.map((scenario) => `<code>${escapeHtml(scenario.scenarioId)}</code> — ${escapeHtml(scenario.outcome)}: ${escapeHtml(scenario.summary.slice(0, 240))}`).join("<br>")}</p>`
        : "";
      const pendingHtml = area.pendingManual.length
        ? `<p><strong>Pending manual verification:</strong> ${area.pendingManual.map(escapeHtml).join(", ")}</p>`
        : "";
      const gatesHtml = area.gates.length
        ? `<p><strong>Critical gates:</strong> ${area.gates.map((gate) => `<span class="${gateClass[gate.status]}" title="${escapeHtml(gate.reason)}">${escapeHtml(gate.itemId)} — ${escapeHtml(gate.status)}</span>`).join(", ")}</p>`
        : "";
      return `<section id="area-${escapeHtml(area.id)}"><h2>${escapeHtml(area.title)} — ${formatPct(area.scorePct)} <small>(${area.total === 0 && area.exclusions?.length ? "excluded from this suite" : `${formatPct(area.coveragePct)} coverage`})</small></h2><p>${escapeHtml(area.notes)}</p>${area.exclusions?.length ? `<h3>Declared exclusions (${weight(area.exclusions.reduce((sum, item) => sum + item.weight, 0))} item weight)</h3><ul>${area.exclusions.map((item) => `<li>${escapeHtml(item.id)} · weight ${item.weight}: ${escapeHtml(item.reason)}</li>`).join("")}</ul><p>Excluded weight is outside score and coverage; it is not missing evidence.</p>` : ""}${gatesHtml}${incompleteHtml}${area.unproven.length ? `<p class="warn">Automatic verdicts discarded because no backing scenario was reached: ${area.unproven.map(escapeHtml).join(", ")}</p>` : ""}${pendingHtml}<table><thead><tr><th>Item</th><th>Verdict</th><th>Confidence</th><th>Reasoning and evidence</th></tr></thead><tbody>${itemRows}</tbody></table>${casesHtml}${defects}<h3>Scenario evidence</h3>${scenarios}</section>`;
    })
    .join("");
}

function providerTable(report: RunReport): string {
  const rows = (["agent", "judge"] as const).map((role) => {
    const provider = report.receipt.providers[role];
    return `<tr><td>${role}</td><td>${escapeHtml(provider.provider)}</td><td>${escapeHtml(provider.model ?? "Provider default (unrecorded)")}</td><td>${escapeHtml(provider.effort ?? "Provider default (unrecorded)")}</td><td>${escapeHtml(provider.cliVersion)}</td></tr>`;
  });
  return `<table><thead><tr><th>Role</th><th>Provider</th><th>Requested model</th><th>Requested reasoning effort</th><th>CLI version</th></tr></thead><tbody>${rows.join("")}</tbody></table><p><small>Model and effort are requested settings, not confirmation of the provider's resolved model snapshot. Provider invocation commands are retained in the run artifacts. <a href="receipt.json">View receipt</a>.</small></p>`;
}

const reportStyles =
  ".headline{font-size:2rem}.headline span{font-size:1rem;color:#57606a;margin-left:.8rem;display:inline-block}.error .headline,.warn .headline{font-size:1.4rem;margin:.2rem 0}th{white-space:nowrap}.criterion{min-width:14rem}.low{color:#cf222e;font-weight:650}.shots{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}figcaption,small{color:#57606a;font-size:12px}section{border-top:1px solid #d0d7de;margin-top:2rem;padding-top:1rem}.evidence pre{max-height:20rem}select{font:inherit;padding:.3rem}";

function runTiming(report: RunReport): string {
  const elapsed = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  return `Started <time datetime="${escapeHtml(report.startedAt)}" title="${escapeHtml(report.startedAt)}">${escapeHtml(formatTimestamp(report.startedAt))}</time>${Number.isFinite(elapsed) && elapsed >= 0 ? ` · took ${formatDuration(elapsed)}` : ""}`;
}

function gateFailureHtml(report: RunReport, specs: EvalSpec[]): string {
  const blocking = report.gates.blocking;
  if (!blocking.length) return "";
  const failed = blocking.some((gate) => gate.status === "failed");
  return `<div class="${failed ? "error" : "warn"}"><p class="headline">${failed ? "Critical gate failure" : "Critical gates unavailable"}</p><ul>${blocking
    .map((gate) => {
      const criterion = specs
        .find((spec) => spec.id === gate.areaId)
        ?.rubric.find((rubric) => rubric.id === gate.itemId)?.criterion;
      return `<li><a href="#area-${escapeHtml(gate.areaId)}"><code>${escapeHtml(gate.areaId)}/${escapeHtml(gate.itemId)}</code></a>${criterion ? ` ${escapeHtml(criterion)}` : ""} — <strong>${escapeHtml(gate.status)}</strong>: ${escapeHtml(gate.reason)}</li>`;
    })
    .join("")}</ul></div>`;
}

export function writeHtml(
  runDir: string,
  report: RunReport,
  specs: EvalSpec[],
  artifactRunDir = runDir,
): void {
  const headline = report.scoreWithheld
    ? `<p class="headline low">Score withheld — ${formatPct(report.overallCoveragePct)} coverage</p><p class="warn">The provisional score over judged evidence is ${formatPct(report.overallScorePct)}. It is not comparable until coverage reaches the configured threshold.</p>`
    : `<p class="headline">Score ${formatPct(report.overallScorePct)} <span>${formatPct(report.overallCoveragePct)} coverage</span></p>`;
  const gates =
    gateFailureHtml(report, specs) ||
    `<p><strong>Critical gates:</strong> ${report.areas.some((area) => area.gates.length) ? "passed" : "none configured"}.</p>`;
  const manual = report.manualPending
    ? `<p>${plural(report.manualPending, "item awaits", "items await")} manual verification. <a href="manual-checklist.md">Open checklist</a> · <a href="manual-results.json">Record decisions</a></p>`
    : "";
  const insufficient = report.areas.some(
    (area) => area.unproven.length || area.items.some((item) => item.verdict === "cannot_judge"),
  )
    ? `<p class="warn">Some criteria lack sufficient evidence. Inspect their reasoning and scenario outcomes below.${adjudicationCandidates(report, specs).length ? ` <a href="${ADJUDICATION_CHECKLIST}">Review eligible automatic abstentions</a>.` : ""}</p>`
    : "";
  const tags = tagRows(report);
  const strata = stratumRows(report);
  const diagnostics =
    tags || strata
      ? `<details><summary>Diagnostic breakdown: ${tags && strata ? "tags and strata" : tags ? "tags" : "strata"}</summary>${tags ? `<h2>Tags</h2><p>Rubric items may carry multiple tags; each row is an independent diagnostic slice.</p><table><thead><tr><th>Tag</th><th>Score</th><th>Coverage</th><th>Earned / judged / total weight</th></tr></thead><tbody>${tags}</tbody></table>` : ""}${strata ? `<h2>Strata</h2><p>Case-level automatic diagnostic slices; they do not replace the weighted headline score.</p><table><thead><tr><th>Stratum</th><th>Score</th><th>Coverage</th><th>Cases</th></tr></thead><tbody>${strata}</tbody></table>` : ""}</details>`
      : "";
  const body = `<h1>${escapeHtml(report.project)}</h1><p class="subtitle">Evaluation report</p><p class="meta">Run <code>${escapeHtml(report.runId)}</code> · ${runTiming(report)}</p>${report.receipt.collection ? `<p>Evidence from collection ${escapeHtml(report.receipt.collection.runId)}. <a href="receipt.json">View provenance</a>.</p>` : ""}${headline}${gates}<p>Score measures judged evidence; coverage measures how much of the rubric was judged.</p>${manual}
${insufficient}
<h2>Areas</h2><table><thead><tr><th>Area</th><th>Weight</th><th>Score</th><th>Coverage</th><th>Earned / judged / total weight</th><th>Pending manual</th></tr></thead><tbody>${tableRows(report)}</tbody></table>
<h2>Review criteria</h2><label>Show <select id="review-filter"><option value="all">All criteria</option><option value="action">Needs attention</option><option value="failed">Failed criteria</option><option value="missing">Missing evidence</option><option value="pending">Pending manual review</option></select></label><p id="review-count" aria-live="polite"></p>${areaSections(report, specs, artifactRunDir)}
${diagnostics}<details><summary>Providers and provenance</summary>${providerTable(report)}</details>`;
  const html = reportDocument(
    `${report.project} · Evaluation report`,
    body,
    `
const filter = document.getElementById('review-filter');
function filterCriteria() {
  let visible = 0;
  const rows = document.querySelectorAll('[data-result]');
  for (const row of rows) {
    const verdict = row.dataset.result;
    const pending = row.dataset.pending === 'true';
    const choice = filter.value;
    const show = choice === 'all' || (choice === 'action' && (verdict !== 'pass' || pending)) || (choice === 'failed' && ['fail', 'not_found'].includes(verdict)) || (choice === 'missing' && verdict === 'cannot_judge') || (choice === 'pending' && pending);
    row.hidden = !show;
    if (show) visible++;
  }
  document.getElementById('review-count').textContent = visible + ' of ' + rows.length + ' criteria shown';
}
filter.addEventListener('change', filterCriteria);
filterCriteria();
`,
    reportStyles,
  )
    .replaceAll("<table>", '<div class="table-scroll"><table>')
    .replaceAll("</table>", "</table></div>");
  fs.writeFileSync(path.join(runDir, "report.html"), html);
}

export function writeReportArtifacts(runDir: string, report: RunReport, specs: EvalSpec[]): void {
  writeJson(path.join(runDir, "report.json"), report);
  writeJson(path.join(runDir, "receipt.json"), report.receipt);
  writeHtml(runDir, report, specs);
  writeManualFiles(runDir, report, specs);
  writeAdjudicationChecklist(runDir, report, specs);
  writeArtifactIndex(runDir);
}

const validManual = new Set<Verdict>(["pass", "partial", "fail", "not_found"]);

function revisionPayload(revision: Omit<ManualRevision, "revisionHash">): string {
  return stableJson(revision);
}

function validateManualRevisions(revisions: ManualRevision[]): Map<string, ManualRevision> {
  const latest = new Map<string, ManualRevision>();
  for (const [index, revision] of revisions.entries()) {
    const { revisionHash, ...payload } = revision;
    if (
      revision.schemaVersion !== 1 ||
      !revision.itemId ||
      !validManual.has(revision.verdict) ||
      !revision.reviewer ||
      !revision.reviewedAt ||
      revisionHash !== sha256(revisionPayload(payload))
    ) {
      throw new Error(`Invalid manual revision at line ${index + 1}`);
    }
    const expectedPrevious = latest.get(revision.itemId)?.revisionHash;
    if (revision.previousHash !== expectedPrevious) {
      throw new Error(`Broken manual revision chain for ${revision.itemId} at line ${index + 1}`);
    }
    latest.set(revision.itemId, revision);
  }
  return latest;
}

function prepareManualRevisions(options: {
  runDir: string;
  manual: Record<string, ManualResultEntry>;
  specs: EvalSpec[];
  reviewer?: string;
}): { manual: Record<string, ManualResultEntry>; revisionText?: string } {
  const revisionFile = path.join(options.runDir, "manual-revisions.ndjson");
  const revisions = fs.existsSync(revisionFile)
    ? fs
        .readFileSync(revisionFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line) as ManualRevision;
          } catch {
            throw new Error(`Invalid manual revision JSON at line ${index + 1}`);
          }
        })
    : [];
  const latest = validateManualRevisions(revisions);
  const eligible = new Set(
    options.specs.flatMap((spec) =>
      spec.rubric
        .filter((item) => item.grader.type === "manual" || item.grader.type === "hybrid")
        .map((item) => item.id),
    ),
  );
  const normalized = { ...options.manual };
  for (const [itemId, entry] of Object.entries(options.manual)) {
    if (!entry || typeof entry !== "object" || typeof entry.verdict !== "string") {
      throw new Error(
        `Invalid manual result for ${itemId}: expected an object with a verdict string`,
      );
    }
    if (!eligible.has(itemId))
      throw new Error(`Unknown or non-manual rubric in manual-results.json: ${itemId}`);
    if (entry.notes !== undefined && typeof entry.notes !== "string") {
      throw new Error(`Invalid manual result for ${itemId}: notes must be a string`);
    }
    if (entry.reviewer !== undefined && typeof entry.reviewer !== "string") {
      throw new Error(`Invalid manual result for ${itemId}: reviewer must be a string`);
    }
    const rawVerdict = entry.verdict.trim().toLowerCase();
    if (rawVerdict === MANUAL_PLACEHOLDER) continue;
    const verdict = rawVerdict as Verdict;
    if (!validManual.has(verdict)) {
      throw new Error(
        `Invalid manual verdict for ${itemId}: expected pass, partial, fail, or not_found`,
      );
    }
    const prior = latest.get(itemId);
    const reviewer =
      options.reviewer?.trim() ||
      entry.reviewer?.trim() ||
      process.env.USER?.trim() ||
      process.env.USERNAME?.trim();
    if (!reviewer) {
      throw new Error(
        `Manual result ${itemId} requires --reviewer because no reviewer is recorded or available from the environment`,
      );
    }
    const notes = entry.notes ?? "";
    if (
      prior &&
      prior.verdict === verdict &&
      prior.notes === notes &&
      prior.reviewer === reviewer
    ) {
      normalized[itemId] = {
        verdict,
        notes,
        reviewer: prior.reviewer,
        reviewedAt: prior.reviewedAt,
        ...(prior.previousHash === undefined ? {} : { previousHash: prior.previousHash }),
        revisionHash: prior.revisionHash,
      };
      continue;
    }
    const payload: Omit<ManualRevision, "revisionHash"> = {
      schemaVersion: 1,
      itemId,
      verdict: verdict as Exclude<Verdict, "cannot_judge">,
      notes,
      reviewer,
      reviewedAt: new Date().toISOString(),
      ...(prior?.revisionHash === undefined ? {} : { previousHash: prior?.revisionHash }),
    };
    const revision: ManualRevision = { ...payload, revisionHash: sha256(revisionPayload(payload)) };
    revisions.push(revision);
    latest.set(itemId, revision);
    normalized[itemId] = {
      verdict,
      notes,
      ...(reviewer === undefined ? {} : { reviewer: reviewer }),
      reviewedAt: revision.reviewedAt,
      ...(revision.previousHash === undefined ? {} : { previousHash: revision.previousHash }),
      revisionHash: revision.revisionHash,
    };
  }
  return omitUndefined({
    manual: normalized,
    revisionText: revisions.length
      ? `${revisions.map((revision) => JSON.stringify(revision)).join("\n")}\n`
      : undefined,
  });
}

function reportUpdateTransactionDirectory(runDir: string): string {
  return path.join(path.resolve(runDir), REPORT_UPDATE_TRANSACTION_DIRECTORY);
}

function replaceFromTransaction(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Finish a fully staged report update left behind by an interrupted process. */
export function recoverInterruptedReportUpdate(runDir: string): boolean {
  const resolved = path.resolve(runDir);
  const transactionDir = reportUpdateTransactionDirectory(resolved);
  if (!fs.existsSync(transactionDir)) return false;
  const manifestFile = path.join(transactionDir, "transaction.json");
  let manifest: ReportUpdateTransaction;
  try {
    manifest = readJson<ReportUpdateTransaction>(manifestFile);
  } catch (error) {
    throw new Error(
      `Interrupted report update transaction is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.removed) ||
    manifest.removed.some(
      (file) =>
        !CONDITIONAL_REPORT_FILES.includes(file) ||
        manifest.files.some((entry) => entry?.path === file),
    )
  ) {
    throw new Error("Interrupted report update transaction has an invalid manifest");
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !reportUpdatePath(entry.path) ||
      seen.has(entry.path)
    ) {
      throw new Error("Interrupted report update transaction contains an invalid file entry");
    }
    seen.add(entry.path);
    const source = path.join(transactionDir, entry.path);
    if (!fs.existsSync(source))
      throw new Error(`Interrupted report update is missing staged ${entry.path}`);
    const stat = fs.lstatSync(source);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      sha256(fs.readFileSync(source)) !== entry.sha256
    ) {
      throw new Error(`Interrupted report update has an invalid staged ${entry.path}`);
    }
  }
  for (const required of [
    "manual-checklist.md",
    "manual-results.json",
    "receipt.json",
    "report.html",
    "report.json",
  ]) {
    if (!seen.has(required))
      throw new Error(`Interrupted report update is missing required ${required}`);
  }
  const indexFile = path.join(resolved, "artifact-index.json");
  if (manifest.originalIndexRootSha256) {
    if (!fs.existsSync(indexFile)) {
      throw new Error(
        "Interrupted report update cannot be recovered because its original artifact index is missing",
      );
    }
    const currentIndex = readJson<{ rootSha256?: string }>(indexFile);
    if (currentIndex.rootSha256 !== manifest.originalIndexRootSha256) {
      const installed =
        manifest.files.every((entry) => {
          const destination = path.join(resolved, entry.path);
          return (
            fs.existsSync(destination) &&
            fs.lstatSync(destination).isFile() &&
            sha256(fs.readFileSync(destination)) === entry.sha256
          );
        }) && manifest.removed.every((file) => !fs.existsSync(path.join(resolved, file)));
      const completed = verifyArtifactIndex(resolved, { require: true });
      if (installed && completed.ok) {
        fs.rmSync(transactionDir, { recursive: true, force: true });
        return true;
      }
      throw new Error(
        "Interrupted report update cannot be recovered because its original artifact index changed",
      );
    }
    const changedPaths = [...manifest.files.map((entry) => entry.path), ...manifest.removed];
    const verification = verifyArtifactIndex(resolved, {
      require: true,
      allowChangedPaths: changedPaths,
      allowUnindexed: (relative) => changedPaths.includes(relative),
    });
    if (!verification.ok) {
      throw new Error(
        `Interrupted report update cannot be recovered because other artifacts changed:\n  - ${verification.errors.join("\n  - ")}`,
      );
    }
  } else if (fs.existsSync(indexFile)) {
    throw new Error("Interrupted report update is not anchored to the existing artifact index");
  }
  for (const entry of manifest.files) {
    replaceFromTransaction(path.join(transactionDir, entry.path), path.join(resolved, entry.path));
  }
  for (const file of manifest.removed) fs.rmSync(path.join(resolved, file), { force: true });
  writeArtifactIndex(resolved);
  fs.rmSync(transactionDir, { recursive: true, force: true });
  return true;
}

function publishReportUpdateTransaction(options: {
  runDir: string;
  report: RunReport;
  specs: EvalSpec[];
  manual: Record<string, ManualResultEntry>;
  revisionText?: string;
  effectiveFiles?: Record<string, Buffer>;
}): void {
  const runDir = path.resolve(options.runDir);
  const transactionDir = reportUpdateTransactionDirectory(runDir);
  if (fs.existsSync(transactionDir)) {
    throw new Error(
      "An interrupted report update transaction must be recovered before starting another report update",
    );
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(runDir), ".aek-report-update-stage-"));
  try {
    writeJson(path.join(staging, "manual-results.json"), options.manual);
    writeJson(path.join(staging, "report.json"), options.report);
    writeJson(path.join(staging, "receipt.json"), options.report.receipt);
    writeHtml(staging, options.report, options.specs, runDir);
    writeManualFiles(staging, options.report, options.specs, runDir);
    writeAdjudicationChecklist(staging, options.report, options.specs, runDir);
    if (options.revisionText !== undefined) {
      fs.writeFileSync(path.join(staging, "manual-revisions.ndjson"), options.revisionText);
    }
    for (const [relative, bytes] of Object.entries(options.effectiveFiles ?? {})) {
      if (!reportUpdatePath(relative)) throw new Error(`Invalid report update path: ${relative}`);
      const file = path.join(staging, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const files = [
      ...fs
        .readdirSync(staging)
        .filter(
          (name) =>
            REPORT_UPDATE_FILES.has(name) && !Object.hasOwn(options.effectiveFiles ?? {}, name),
        ),
      ...Object.keys(options.effectiveFiles ?? {}),
    ]
      .sort()
      .map((name) => ({ path: name, sha256: sha256(fs.readFileSync(path.join(staging, name))) }));
    const indexFile = path.join(runDir, "artifact-index.json");
    const originalIndexRootSha256 = fs.existsSync(indexFile)
      ? readJson<{ rootSha256?: string }>(indexFile).rootSha256
      : undefined;
    if (fs.existsSync(indexFile) && !originalIndexRootSha256) {
      throw new Error("Cannot stage report update from an invalid artifact index");
    }
    writeJson(path.join(staging, "transaction.json"), {
      schemaVersion: 1,
      ...(originalIndexRootSha256 === undefined
        ? {}
        : { originalIndexRootSha256: originalIndexRootSha256 }),
      files,
      removed: CONDITIONAL_REPORT_FILES.filter((name) => !fs.existsSync(path.join(staging, name))),
    } satisfies ReportUpdateTransaction);
    fs.renameSync(staging, transactionDir);
    recoverInterruptedReportUpdate(runDir);
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Publish a rescore as one recoverable replacement of all report artifacts. */
export function writeReportArtifactsRecoverably(
  runDir: string,
  report: RunReport,
  specs: EvalSpec[],
  effectiveDefinitions?: { config: EvalConfig; specs: EvalSpec[] },
  adjudicationFiles?: Record<string, Buffer>,
): void {
  const effectiveFiles = effectiveDefinitions
    ? scoringDefinitionFiles(
        effectiveDefinitions.config,
        effectiveDefinitions.specs,
        report.receipt,
      )
    : undefined;
  if (effectiveFiles) {
    const bytes = requireDefined(effectiveFiles[scoringConfigPath], "effective scoring config");
    report.receipt.inputs.scoringConfig = { sha256: sha256(bytes), bytes: bytes.length };
  }
  const manualFile = path.join(runDir, "manual-results.json");
  const revisionFile = path.join(runDir, "manual-revisions.ndjson");
  publishReportUpdateTransaction(
    omitUndefined({
      runDir,
      report,
      specs,
      effectiveFiles: { ...effectiveFiles, ...adjudicationFiles },
      manual: fs.existsSync(manualFile)
        ? readJson<Record<string, ManualResultEntry>>(manualFile)
        : {},
      revisionText: fs.existsSync(revisionFile) ? fs.readFileSync(revisionFile, "utf8") : undefined,
    }),
  );
}

export function adjudicateReport(options: {
  runDir: string;
  report: RunReport;
  specs: EvalSpec[];
  config: EvalConfig;
  inputFile: string;
  reviewer: string;
}): RunReport {
  if (isWithin(fs.realpathSync(options.runDir), fs.realpathSync(options.inputFile)))
    throw new Error(
      "Adjudication input must be outside the run directory; move the decision file and retry",
    );
  const index = assertArtifactIntegrity(options.runDir, { require: true })!;
  if (stableJson(readJson(path.join(options.runDir, "report.json"))) !== stableJson(options.report))
    throw new Error("Adjudication requires the current indexed report");
  const prepared = prepareAdjudications({ ...options, index });
  const areas = options.report.areas.map((area) => {
    const spec = options.specs.find((candidate) => candidate.id === area.id);
    if (!spec) throw new Error(`Cannot adjudicate report: no spec for ${area.id}`);
    return scoreArea({
      spec,
      judgements: requireDefined(prepared.items.get(area.id), `adjudicated items for ${area.id}`),
      evidence: area.scenarios,
      config: options.config,
      defects: area.defects,
      notes: area.notes,
      caseResults: area.caseResults,
    });
  });
  const report: RunReport = {
    ...buildReport({
      runId: options.report.runId,
      startedAt: options.report.startedAt,
      config: options.config,
      areas,
      receipt: options.report.receipt,
    }),
    project: options.report.project,
    target: options.report.target,
    kitVersion: options.report.kitVersion,
    providers: options.report.providers,
  };
  if (assertArtifactIntegrity(options.runDir, { require: true })!.rootSha256 !== index.rootSha256)
    throw new Error("Run artifacts changed during adjudication; review the current report again");
  writeReportArtifactsRecoverably(options.runDir, report, options.specs, undefined, prepared.files);
  return report;
}

export function finalizeReport(options: {
  runDir: string;
  report: RunReport;
  specs: EvalSpec[];
  config: EvalConfig;
  reviewer?: string;
}): RunReport {
  // Validate persisted automatic evidence before recording any manual revision.
  // A zero automatic share legitimately has no automatic judgement.
  for (const area of options.report.areas) {
    const spec = options.specs.find((candidate) => candidate.id === area.id);
    if (!spec) throw new Error(`Cannot finalize report: no spec exists for report area ${area.id}`);
    for (const rubric of spec.rubric) {
      if (rubric.grader.type !== "hybrid") continue;
      const automatic = area.items.find((item) => item.id === rubric.id)?.components?.automatic;
      if (
        (rubric.grader.autoShare > 0 && automatic === undefined) ||
        (automatic !== undefined &&
          (typeof automatic !== "string" || !Object.hasOwn(verdictColor, automatic)))
      ) {
        throw new Error(
          `Cannot finalize report: hybrid ${area.id}/${rubric.id} is missing a valid automatic component; regenerate the report`,
        );
      }
    }
  }
  const manualInput = readJson<Record<string, ManualResultEntry>>(
    path.join(options.runDir, "manual-results.json"),
  );
  const prepared = prepareManualRevisions({
    runDir: options.runDir,
    manual: manualInput,
    specs: options.specs,
    ...(options.reviewer === undefined ? {} : { reviewer: options.reviewer }),
  });
  const manual = prepared.manual;
  const areas = options.report.areas.map((area) => {
    const spec = options.specs.find((candidate) => candidate.id === area.id);
    if (!spec) throw new Error(`Cannot finalize report: no spec exists for report area ${area.id}`);
    const byId = new Map(area.items.map((item) => [item.id, item]));
    for (const rubric of spec.rubric) {
      if (rubric.grader.type !== "manual" && rubric.grader.type !== "hybrid") continue;
      const entry = manual[rubric.id];
      if (entry === undefined) continue;
      const manualVerdict = entry?.verdict?.trim().toLowerCase() as Verdict | undefined;
      if (!manualVerdict || !validManual.has(manualVerdict)) continue;
      if (!entry.revisionHash || !entry.reviewer || !entry.reviewedAt) {
        throw new Error(`Manual result ${rubric.id} was not recorded in the revision chain`);
      }
      const prior = byId.get(rubric.id);
      if (rubric.grader.type === "hybrid") {
        const automatic = prior?.components?.automatic;
        const components = { ...prior?.components, manual: manualVerdict };
        const verdict = hybridAggregateVerdict(components, rubric.grader.autoShare);
        byId.set(rubric.id, {
          ...prior,
          id: rubric.id,
          verdict,
          confidence: prior?.confidence ?? "low",
          reasoning: `Automatic: ${automatic ?? "not collected"} — ${prior?.reasoning ?? "no judgeable automatic evidence"} Manual by ${entry.reviewer} at ${entry.reviewedAt}: ${manualVerdict} — ${entry.notes ?? "no notes"}`,
          evidenceRefs: [...(prior?.evidenceRefs ?? []), `manual-revision:${entry.revisionHash}`],
          source: "manual",
          components,
        });
      } else {
        byId.set(rubric.id, {
          id: rubric.id,
          verdict: manualVerdict,
          confidence: "high",
          reasoning: `Manual verification by ${entry.reviewer} at ${entry.reviewedAt}: ${entry.notes ?? "no notes"}`,
          evidenceRefs: [`manual-revision:${entry.revisionHash}`],
          source: "manual",
        });
      }
    }
    return scoreArea({
      spec,
      judgements: [...byId.values()],
      evidence: area.scenarios,
      config: options.config,
      defects: area.defects,
      notes: area.notes,
      caseResults: area.caseResults,
    });
  });
  const rebuilt = buildReport({
    runId: options.report.runId,
    startedAt: options.report.startedAt,
    config: options.config,
    areas,
    receipt: options.report.receipt,
  });
  const report: RunReport = {
    ...rebuilt,
    project: options.report.project,
    target: options.report.target,
    kitVersion: options.report.kitVersion,
    providers: options.report.providers,
  };
  publishReportUpdateTransaction({
    runDir: options.runDir,
    report,
    specs: options.specs,
    manual,
    ...(prepared.revisionText === undefined
      ? {}
      : omitUndefined({ revisionText: prepared.revisionText })),
  });
  return report;
}
