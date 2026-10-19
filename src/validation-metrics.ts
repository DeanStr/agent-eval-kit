import type { Verdict } from "./types.js";

export type ValidationOutcome =
  | { status: "judged"; actual: Exclude<Verdict, "cannot_judge"> }
  | { status: "abstained"; actual: "cannot_judge" }
  | { status: "execution_error"; error: string };

export function verdictOutcome(verdict: Verdict): ValidationOutcome {
  if (!["pass", "partial", "fail", "not_found", "cannot_judge"].includes(verdict))
    throw new Error(`Invalid validation verdict: ${String(verdict)}`);
  return verdict === "cannot_judge"
    ? { status: "abstained", actual: verdict }
    : { status: "judged", actual: verdict };
}

export function rate(count: number, denominator: number) {
  return { count, denominator, rate: denominator ? count / denominator : null };
}

/** Error rates include every attempted case; abstentions/errors never count as decisions. */
export function validationMetrics(observations: Array<ValidationOutcome & { expected: Verdict }>) {
  const positives = observations.filter((item) => item.expected === "pass");
  const negatives = observations.filter(
    (item) => item.expected !== "pass" && item.expected !== "cannot_judge",
  );
  const insufficient = observations.filter((item) => item.expected === "cannot_judge");
  const judged = observations.filter((item) => item.status === "judged");
  const errors = observations.filter((item) => item.status === "execution_error");
  const abstentions = observations.filter((item) => item.status === "abstained");
  return {
    attempted: observations.length,
    falsePasses: rate(
      negatives.filter((item) => item.status === "judged" && item.actual === "pass").length,
      negatives.length,
    ),
    falseFailures: rate(
      positives.filter((item) => item.status === "judged" && item.actual !== "pass").length,
      positives.length,
    ),
    abstentions: rate(abstentions.length, observations.length),
    executionErrors: rate(errors.length, observations.length),
    decisionCoverage: rate(judged.length, observations.length),
    unsupportedDecisions: rate(
      insufficient.filter((item) => item.status === "judged").length,
      insufficient.length,
    ),
    correctAbstentions: rate(
      insufficient.filter((item) => item.status === "abstained").length,
      insufficient.length,
    ),
    exactMatches: rate(
      observations.filter(
        (item) => item.status !== "execution_error" && item.actual === item.expected,
      ).length,
      observations.length,
    ),
  };
}
