import type { RunReport } from "./types.js";
import { aggregateAreaMeasurements, belowPercentageThreshold } from "./score-slice.js";

export interface CiThresholds {
  minimumScore?: number;
  minimumCoverage?: number;
}

export function evaluateCiThresholds(report: RunReport, thresholds: CiThresholds): string[] {
  const failures: string[] = [];
  const measurements = aggregateAreaMeasurements(report.areas);
  if (report.gates && !report.gates.passed) {
    failures.push(
      `critical gates not satisfied: ${report.gates.blocking.map((gate) => `${gate.areaId}/${gate.itemId} (${gate.status}${gate.verdict ? `: ${gate.verdict}` : ""})`).join(", ")}`,
    );
  }
  if (
    thresholds.minimumCoverage !== undefined &&
    belowPercentageThreshold(measurements.coveragePct, thresholds.minimumCoverage)
  ) {
    failures.push(
      `coverage ${measurements.coveragePct}% is below required ${thresholds.minimumCoverage}%`,
    );
  }
  if (thresholds.minimumScore !== undefined) {
    if (report.scoreWithheld) {
      failures.push(
        `score is withheld at ${measurements.coveragePct}% coverage; cannot satisfy required ${thresholds.minimumScore}%`,
      );
    } else if (measurements.scorePct === null) {
      failures.push(`score is unavailable; cannot satisfy required ${thresholds.minimumScore}%`);
    } else if (belowPercentageThreshold(measurements.scorePct, thresholds.minimumScore)) {
      failures.push(
        `score ${measurements.scorePct}% is below required ${thresholds.minimumScore}%`,
      );
    }
  }
  return failures;
}
