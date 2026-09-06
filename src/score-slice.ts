import type { AreaResult, ScoreSlice } from "./types.js";

const roundPercent = (value: number) => Math.round(value * 1000) / 1000;

/** Ignore only floating-point arithmetic noise, never display rounding.
 * Multiplication/division can represent an exact 29% as 28.999999999999996%.
 * This relative error allowance is about 3.6e-13 percentage points at 100%.
 */
export function belowPercentageThreshold(actual: number, minimum: number): boolean {
  const roundoff = Number.EPSILON * Math.max(Math.abs(actual), Math.abs(minimum)) * 16;
  return minimum - actual > roundoff;
}

/** Area weights define the headline; unavailable areas affect coverage only.
 * Compute from retained weights, never display percentages, for every decision.
 */
export function aggregateAreaMeasurements(
  areas: Pick<AreaResult, "optional" | "weight" | "earned" | "judgeable" | "total">[],
): { scorePct: number | null; coveragePct: number } {
  let weight = 0,
    scoredWeight = 0,
    score = 0,
    coverage = 0;
  for (const area of areas) {
    if (area.optional) continue;
    const ratios = scoreRatios(area);
    weight += area.weight;
    coverage += ratios.coverage * area.weight;
    if (ratios.score !== null) {
      scoredWeight += area.weight;
      score += ratios.score * area.weight;
    }
  }
  return {
    scorePct: scoredWeight > 0 ? (score / scoredWeight) * 100 : null,
    coveragePct: weight > 0 ? (coverage / weight) * 100 : 0,
  };
}

/** Ratios for decisions; reporting precision must not become a CI tolerance. */
export function scoreRatios({
  earned,
  judgeable,
  total,
}: Pick<ScoreSlice, "earned" | "judgeable" | "total">): { score: number | null; coverage: number } {
  return {
    score: judgeable > 0 ? earned / judgeable : null,
    coverage: total > 0 ? judgeable / total : 0,
  };
}

/** Keep weights at full precision so persisted percentages remain verifiable. */
export function calculateScoreSlice({
  earned,
  judgeable,
  total,
}: Pick<ScoreSlice, "earned" | "judgeable" | "total">): ScoreSlice {
  const ratios = scoreRatios({ earned, judgeable, total });
  return {
    earned,
    judgeable,
    total,
    scorePct: ratios.score === null ? null : roundPercent(ratios.score * 100),
    coveragePct: roundPercent(ratios.coverage * 100),
  };
}
