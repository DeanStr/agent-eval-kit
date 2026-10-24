import { scoreRatios } from "../score-slice.js";
import type { JudgedCase, RunReport, Verdict } from "../types.js";

interface Observation {
  label: string;
  verdict: Verdict;
  /** Earned fraction; null when the observation has no evidence coverage. */
  value: number | null;
}
type Repetition = Map<string, Observation>;

// Verdict ordering is semantic, independent of configurable partial credit.
const rank: Partial<Record<Verdict, number>> = { pass: 2, partial: 1, fail: 0, not_found: 0 };

function worse(candidate: Observation, baseline: Observation): boolean {
  const before = rank[baseline.verdict],
    after = rank[candidate.verdict];
  return (
    candidate.value! < baseline.value! ||
    (before !== undefined && after !== undefined && after < before)
  );
}

/**
 * A protected regression must be reproduced: every candidate repetition is worse
 * than every baseline repetition. With one run on each side this is the strict
 * single-run rule; with repeated runs, decreases that overlap the baseline's
 * observed outcomes are left to the aggregate acceptance checks.
 */
function regressionFailures(noun: string, baseline: Repetition[], candidate: Repetition[]) {
  const single = baseline.length === 1 && candidate.length === 1;
  const failures: string[] = [];
  for (const key of new Set(baseline.flatMap((run) => [...run.keys()]))) {
    const before = baseline.flatMap((run) => run.get(key) ?? []);
    const after = candidate.map((run) => run.get(key));
    const label = before[0]!.label;
    if (after.some((current) => !current)) {
      failures.push(`Protected ${noun} ${label} was removed`);
      continue;
    }
    const measured = before.filter((previous) => previous.value !== null);
    if (!measured.length) continue;
    const current = after as Observation[];
    if (current.some((item) => item.value === null)) {
      failures.push(`Protected ${noun} ${label} lost evidence coverage`);
      continue;
    }
    if (current.every((item) => measured.every((previous) => worse(item, previous)))) {
      const verdicts = (items: Observation[]) => items.map((item) => item.verdict).join(", ");
      failures.push(
        `Protected ${noun} ${label} regressed${single ? "" : " in every repetition"} (${verdicts(measured)} → ${verdicts(current)})`,
      );
    }
  }
  return failures;
}

function indexCases(items: JudgedCase[]): Repetition {
  const key = (item: JudgedCase) => JSON.stringify([item.areaId, item.rubricId, item.caseId]);
  const result: Repetition = new Map();
  for (const item of items) {
    if (item.points === undefined) throw new Error(`Scored case ${key(item)} is missing points`);
    if (result.has(key(item))) throw new Error(`Duplicate scored case ${key(item)}`);
    result.set(key(item), {
      label: `${item.areaId}/${item.rubricId}/${item.caseId}`,
      verdict: item.verdict,
      value: item.points,
    });
  }
  return result;
}

function indexItems(report: RunReport): Repetition {
  const result: Repetition = new Map();
  for (const area of report.areas)
    for (const item of area.items) {
      const key = JSON.stringify([area.id, item.id]);
      if (!item.score) throw new Error(`Rubric item ${key} is missing scored measurements`);
      if (result.has(key)) throw new Error(`Duplicate rubric item ${key}`);
      result.set(key, {
        label: `${area.id}/${item.id}`,
        verdict: item.verdict,
        value: scoreRatios(item.score).score,
      });
    }
  return result;
}

/** Dataset/template cases remain protected even when their parent rubric improves. */
export function caseRegressionFailures(baseline: JudgedCase[], candidate: JudgedCase[]): string[] {
  return regressionFailures("case", [indexCases(baseline)], [indexCases(candidate)]);
}

/** Rubric items and cases regressed in every repeated run, as one run per side is strict. */
export function reproducedRegressionFailures(
  baseline: RunReport[],
  candidate: RunReport[],
): string[] {
  const cases = (reports: RunReport[]) =>
    reports.map((report) => indexCases(report.areas.flatMap((area) => area.caseResults)));
  return [
    ...regressionFailures("item", baseline.map(indexItems), candidate.map(indexItems)),
    ...regressionFailures("case", cases(baseline), cases(candidate)),
  ];
}

/** Each critical gate must preserve its own pass rate, even when other gates already fail. */
export function gatePassRateFailures(baseline: RunReport[], candidate: RunReport[]): string[] {
  if (!baseline.length || !candidate.length)
    throw new Error("Critical-gate comparison requires baseline and candidate repetitions");
  const count = (reports: RunReport[]) => {
    const gates = new Map<string, { label: string; observed: number; passed: number }>();
    for (const report of reports) {
      const seen = new Set<string>();
      for (const area of report.areas)
        for (const gate of area.gates) {
          const key = JSON.stringify([area.id, gate.itemId]);
          if (seen.has(key)) throw new Error(`Duplicate critical gate ${area.id}/${gate.itemId}`);
          seen.add(key);
          const current = gates.get(key) ?? {
            label: `${area.id}/${gate.itemId}`,
            observed: 0,
            passed: 0,
          };
          current.observed++;
          if (gate.status === "passed") current.passed++;
          gates.set(key, current);
        }
    }
    return gates;
  };
  const before = count(baseline),
    after = count(candidate);
  return [...before].flatMap(([key, previous]) => {
    if (previous.observed !== baseline.length)
      throw new Error(`Critical gate ${previous.label} is missing from a baseline repetition`);
    const current = after.get(key);
    if (!current || current.observed !== candidate.length)
      return [`Critical gate ${previous.label} is missing from a candidate repetition`];
    return current.passed * baseline.length < previous.passed * candidate.length
      ? [
          `Critical gate ${previous.label} pass rate dropped (${previous.passed}/${baseline.length} → ${current.passed}/${candidate.length})`,
        ]
      : [];
  });
}
