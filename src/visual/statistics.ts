import { omitUndefined } from "../invariants.js";
import { imageMetricNames, type ImageMetric, type ImageRegressionGrader } from "./contracts.js";
import type { ImageStatistics } from "./images.js";

export interface StatisticSample {
  id: string;
  before?: ImageStatistics;
  after?: ImageStatistics;
  unavailable?: string;
}
type Bound = { min?: number; max?: number; equals?: number };
export function withinBounds(actual: number, expected: Bound): boolean {
  return (
    (expected.min === undefined || actual >= expected.min) &&
    (expected.max === undefined || actual <= expected.max) &&
    (expected.equals === undefined || actual === expected.equals)
  );
}

/** Missing members and near-zero denominators never shrink a configured cohort. */
export function evaluateStatistics(
  samples: StatisticSample[],
  policies: ImageRegressionGrader["metrics"] = {},
) {
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length)
    throw new Error("Statistic cohort contains duplicate sample IDs");
  for (const sample of samples)
    for (const stats of [sample.before, sample.after]) {
      if (
        stats &&
        imageMetricNames.some((metric) => !Number.isFinite(stats[metric]) || stats[metric] < 0)
      )
        throw new Error(`Invalid image statistics for ${sample.id}`);
    }
  const checks: Array<{
    metric: ImageMetric;
    scope: string;
    actual: number | null;
    expected: Bound;
    pass: boolean | null;
  }> = [];
  const axes = Object.fromEntries(
    imageMetricNames.map((metric) => {
      const policy = policies[metric];
      const change = policy?.change ?? "relative",
        minimumBaseline = policy?.minimumBaseline ?? 0.000001;
      const scenes = samples.map((sample) => {
        const before = sample.before?.[metric] ?? null,
          after = sample.after?.[metric] ?? null;
        const absolute = before !== null && after !== null ? after - before : null;
        const relative =
          absolute !== null && before! >= minimumBaseline ? absolute / before! : null;
        const value = change === "absolute" ? absolute : relative;
        const unavailable =
          before === null || after === null
            ? (sample.unavailable ?? "Missing image evidence")
            : change === "relative" && value === null
              ? `Baseline ${metric} is below minimumBaseline ${minimumBaseline}; use an absolute bound or a meaningful baseline`
              : undefined;
        if (policy?.perScene)
          checks.push({
            metric,
            scope: sample.id,
            actual: value,
            expected: omitUndefined(policy.perScene),
            pass: value === null ? null : withinBounds(value, omitUndefined(policy.perScene)),
          });
        return { id: sample.id, before, after, absolute, relative, value, unavailable };
      });
      const values = scenes.map((scene) => scene.value).filter((v): v is number => v !== null);
      const complete = samples.length > 0 && values.length === samples.length;
      const mean = complete ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      if (policy?.mean)
        checks.push({
          metric,
          scope: "mean",
          actual: mean,
          expected: omitUndefined(policy.mean),
          pass: mean === null ? null : withinBounds(mean, omitUndefined(policy.mean)),
        });
      return [
        metric,
        {
          change,
          minimumBaseline,
          expectedSamples: samples.length,
          samples: values.length,
          mean,
          minimum: complete ? Math.min(...values) : null,
          maximum: complete ? Math.max(...values) : null,
          scenes,
        },
      ];
    }),
  );
  const verdict =
    !checks.length || checks.some((check) => check.pass === null)
      ? "cannot_judge"
      : checks.every((check) => check.pass)
        ? "pass"
        : "fail";
  return {
    expectedSamples: samples.length,
    availableImages: samples.filter((sample) => sample.before && sample.after).length,
    axes,
    checks,
    verdict,
    note: "Image statistics measure appearance, not quality. Relative changes below minimumBaseline are unavailable; aggregate values require the full cohort.",
  } as const;
}
