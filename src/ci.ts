import type { RunReport } from "./types.js";

export interface CiThresholds {
  minimumScore?: number;
  minimumCoverage?: number;
}

export function evaluateCiThresholds(report: RunReport, thresholds: CiThresholds): string[] {
  const failures: string[] = [];
  if (report.gates && !report.gates.passed) {
    failures.push(
      `critical gates not satisfied: ${report.gates.blocking.map((gate) => `${gate.areaId}/${gate.itemId} (${gate.status}${gate.verdict ? `: ${gate.verdict}` : ""})`).join(", ")}`,
    );
  }
  if (
    thresholds.minimumCoverage !== undefined &&
    report.overallCoveragePct < thresholds.minimumCoverage
  ) {
    failures.push(
      `coverage ${report.overallCoveragePct}% is below required ${thresholds.minimumCoverage}%`,
    );
  }
  if (thresholds.minimumScore !== undefined) {
    if (report.scoreWithheld) {
      failures.push(
        `score is withheld at ${report.overallCoveragePct}% coverage; cannot satisfy required ${thresholds.minimumScore}%`,
      );
    } else if (report.overallScorePct === null) {
      failures.push(`score is unavailable; cannot satisfy required ${thresholds.minimumScore}%`);
    } else if (report.overallScorePct < thresholds.minimumScore) {
      failures.push(
        `score ${report.overallScorePct}% is below required ${thresholds.minimumScore}%`,
      );
    }
  }
  return failures;
}
