import type { ScoreSlice } from "./types.js";

const roundPercent = (value: number) => Math.round(value * 1000) / 1000;

/** Ratios for decisions; reporting precision must not become a CI tolerance. */
export function scoreRatios({ earned, judgeable, total }: Pick<ScoreSlice, "earned" | "judgeable" | "total">): { score: number | null; coverage: number } {
  return {
    score: judgeable > 0 ? earned / judgeable : null,
    coverage: total > 0 ? judgeable / total : 0,
  };
}

/** Keep weights at full precision so persisted percentages remain verifiable. */
export function calculateScoreSlice({ earned, judgeable, total }: Pick<ScoreSlice, "earned" | "judgeable" | "total">): ScoreSlice {
  const ratios = scoreRatios({ earned, judgeable, total });
  return {
    earned,
    judgeable,
    total,
    scorePct: ratios.score === null ? null : roundPercent(ratios.score * 100),
    coveragePct: roundPercent(ratios.coverage * 100),
  };
}
