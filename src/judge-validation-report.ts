import type {
  ValidationDataset,
  ValidationLabels,
  ValidationObservation,
  validationConfigurationResults,
} from "./judge-validation.js";
import {
  artifactHref,
  escapeHtml,
  evidenceHtml,
  evidencePreviews,
  reportDocument,
  type ReportEvidence,
} from "./report-presentation.js";

export interface ValidationReportEvidence {
  citations: ReportEvidence[];
}

export interface ValidationReviewedEvidence {
  directory: string;
  citations: ReportEvidence[];
}

interface ValidationPresentationReport {
  plannedObservations: number;
  observations: ValidationObservation[];
  results: ReturnType<typeof validationConfigurationResults>;
  limitations: string[];
}

const metricNames = {
  falsePasses: "False passes",
  falseFailures: "False failures",
  abstentions: "Abstentions",
  executionErrors: "Execution errors",
  decisionCoverage: "Decision coverage",
  unsupportedDecisions: "Unsupported decisions",
  correctAbstentions: "Correct abstentions",
  exactMatches: "Exact matches",
} as const;

export function judgeValidationHtml(
  report: ValidationPresentationReport,
  dataset: ValidationDataset,
  labels: ValidationLabels,
  outputDir: string,
  evidenceByRun: ReadonlyMap<string, ValidationReportEvidence>,
  reviewedEvidenceByCase: ReadonlyMap<string, ValidationReviewedEvidence>,
): string {
  const metrics = report.results
    .flatMap((result) => [
      { configuration: result.configuration, split: "All", metrics: result.metrics },
      ...Object.entries(result.splits).map(([split, metrics]) => ({
        configuration: result.configuration,
        split,
        metrics,
      })),
    ])
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.configuration)}</td><td>${escapeHtml(row.split)}</td><td>${row.metrics.attempted}</td>${Object.keys(
          metricNames,
        )
          .map((name) => {
            const metric = row.metrics[name as keyof typeof metricNames];
            return `<td>${metric.count}/${metric.denominator} (${metric.rate === null ? "unavailable" : `${Math.round(metric.rate * 10000) / 100}%`})</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const link = (root: string, ref: string, label: string) => {
    const href = artifactHref(outputDir, root, ref);
    return href
      ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      : `${escapeHtml(label)} (artifact unavailable)`;
  };
  const cases = dataset.cases
    .map((item) => {
      const label = labels.labels.find((label) => label.caseId === item.id)!;
      const reviewed = reviewedEvidenceByCase.get(item.id);
      const decisions = report.results
        .map(({ configuration }) => {
          const observation = report.observations.find(
            (observation) =>
              observation.caseId === item.id && observation.configuration === configuration,
          );
          if (!observation)
            return `<div class="decision"><h3>${escapeHtml(configuration)}</h3><p>Not attempted.</p></div>`;
          if (observation.status === "execution_error")
            return `<div class="decision"><h3>${escapeHtml(configuration)}: execution error</h3><p>No decision. This attempt remains in the decision-coverage denominator.</p>${link(outputDir, `attempts/${configuration}/${item.id}/error.log`, "Attempt diagnostic")}<pre>${escapeHtml(observation.error)}</pre></div>`;
          const runDir = observation.runDir!;
          const evidence = evidenceByRun.get(runDir);
          if (!evidence)
            throw new Error(
              `Missing verified validation evidence for ${configuration}/${item.id}: ${runDir}`,
            );
          return `<div class="decision"><h3>${escapeHtml(configuration)}: ${escapeHtml(observation.actual)}</h3><p>${escapeHtml(observation.status)} · ${observation.actual === label.evidence.verdict ? "Exact match" : "Differs from evidence expectation"}</p><p class="reasoning">${escapeHtml(observation.reasoning!)}</p>${link(runDir, "report.html", "Sealed judging report")} · ${link(runDir, "receipt.json", "Receipt")}<p>Evaluator: <code>${escapeHtml(observation.evaluationFingerprint!)}</code></p>${evidenceHtml(evidence.citations, { outputDir, runDir, areaId: item.area })}</div>`;
        })
        .join("");
      // Reviewer labels refer to the pinned collection, not configuration-specific references.
      return `<section><h2>${escapeHtml(item.id)} · ${escapeHtml(item.area)}/${escapeHtml(item.rubric)}</h2><p>Group ${escapeHtml(item.group)} · ${escapeHtml(item.split)} · Collection <code>${escapeHtml(item.evidence.rootSha256)}</code></p><div class="decision"><h3>Reviewed expectations</h3><p>Reviewer: ${escapeHtml(label.reviewer.name)} (${escapeHtml(label.reviewer.kind)})</p><p><strong>Evidence-supported expectation: ${escapeHtml(label.evidence.verdict)}</strong></p><p class="reasoning">${escapeHtml(label.evidence.rationale)}</p>${evidenceHtml(
        reviewed ? reviewed.citations : evidencePreviews(label.evidence.refs, []),
        reviewed ? { outputDir, runDir: reviewed.directory, areaId: item.area } : undefined,
      )}${!reviewed && label.evidence.refs.length ? "<p>Reviewer evidence previews unavailable: no verified collection snapshot is available.</p>" : ""}<p><strong>Known application outcome: ${escapeHtml(label.application.verdict)}</strong></p><p class="reasoning">${escapeHtml(label.application.rationale)}</p><p>Review sources: ${label.application.sources.map(escapeHtml).join("; ")}</p></div><div class="decisions">${decisions}</div></section>`;
    })
    .join("");
  return reportDocument(
    "Judge validation",
    `<h1>Judge validation</h1><p>${report.observations.length}/${report.plannedObservations} planned attempts completed. ${report.observations.length < report.plannedObservations ? "Comparison incomplete; unattempted cases do not enter metric denominators." : "All planned attempts completed."}</p><p>Metrics compare decisions with evidence-supported reviewer labels. Known application outcomes remain separate. Product comparison compatibility and regression rules do not apply.</p><p><a href="validation-results.json">Results JSON</a> · <a href="review/dataset.json">Dataset snapshot</a> · <a href="review/labels.json">Reviewer labels</a> · <a href="review/configurations.json">Configurations</a></p><h2>Aggregate metrics</h2><p>Each rate shows count/denominator. A zero denominator is unavailable.</p><div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Split</th><th>Attempts</th>${Object.values(
      metricNames,
    )
      .map((name) => `<th>${name}</th>`)
      .join(
        "",
      )}</tr></thead><tbody>${metrics}</tbody></table></div><h2>Cases and decisions</h2>${cases}<h2>Interpretation and limitations</h2><ul>${report.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul>`,
  );
}
