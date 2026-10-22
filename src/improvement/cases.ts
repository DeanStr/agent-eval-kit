import type { JudgedCase, Verdict } from "../types.js";

/** Dataset/template cases remain protected even when their parent rubric improves. */
export function caseRegressionFailures(baseline: JudgedCase[], candidate: JudgedCase[]): string[] {
  const key = (item: JudgedCase) => JSON.stringify([item.areaId, item.rubricId, item.caseId]);
  const index = (items: JudgedCase[]) => {
    const result = new Map<string, JudgedCase>();
    for (const item of items) {
      if (item.points === undefined) throw new Error(`Scored case ${key(item)} is missing points`);
      if (result.has(key(item))) throw new Error(`Duplicate scored case ${key(item)}`);
      result.set(key(item), item);
    }
    return result;
  };
  const before = index(baseline),
    after = index(candidate);
  const rank: Partial<Record<Verdict, number>> = { pass: 2, partial: 1, fail: 0, not_found: 0 };
  const failures: string[] = [];
  for (const [id, previous] of before) {
    const current = after.get(id);
    const label = `${previous.areaId}/${previous.rubricId}/${previous.caseId}`;
    if (!current) {
      failures.push(`Protected case ${label} was removed`);
      continue;
    }
    if (previous.points === null) continue;
    if (current.points === null) {
      failures.push(`Protected case ${label} lost evidence coverage`);
      continue;
    }
    const beforeRank = rank[previous.verdict],
      afterRank = rank[current.verdict];
    if (
      current.points! < previous.points! ||
      (beforeRank !== undefined && afterRank !== undefined && afterRank < beforeRank)
    )
      failures.push(`Protected case ${label} regressed (${previous.verdict} → ${current.verdict})`);
  }
  return failures;
}
