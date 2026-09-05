import type { Verdict } from "../types.js";

interface CaseIdentity { rubricId: string; caseId: string }
interface JudgementIdentities { items: Array<{ id: string }>; cases: CaseIdentity[] }
export const caseIdentity = (item: CaseIdentity): string => `${item.rubricId}\0${item.caseId}`;

/** Output identities are an execution contract, including when replaying saved votes. */
export function assertJudgementIdentities(
  actual: JudgementIdentities, expected: JudgementIdentities, context: string,
): void {
  const problems: string[] = [];
  for (const [label, returned, requested] of [
    ["rubric item IDs", actual.items.map(item => item.id), expected.items.map(item => item.id)],
    ["case identities", actual.cases.map(caseIdentity), expected.cases.map(caseIdentity)],
  ] as const) {
    const seen = new Set<string>(), duplicates = new Set<string>();
    for (const id of returned) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    const wanted = new Set(requested);
    for (const [kind, ids] of [
      ["missing", [...wanted].filter(id => !seen.has(id))],
      ["unexpected", [...seen].filter(id => !wanted.has(id))],
      ["duplicate", [...duplicates]],
    ] as const) {
      if (ids.length) problems.push(`${kind} ${label} (${[...ids].sort().map(id => id.replace("\0", "/")).join(", ")})`);
    }
  }
  if (problems.length) throw new Error(`Judge returned invalid structured output: ${problems.join(" and ")}. See ${context} for retained judge diagnostics.`);
}

/** A derived aggregate requires every member to be observed. Abstention is never a failure. */
export function aggregateCaseVerdicts(values: Verdict[]): Verdict {
  if (!values.length || values.includes("cannot_judge")) return "cannot_judge";
  if (values.every(value => value === "pass")) return "pass";
  if (values.every(value => value === "fail" || value === "not_found")) return "fail";
  return "partial";
}

/** Rubric judges own non-pass verdicts; cases only constrain a proposed full pass.
 * Pairwise judges instead derive their verdict directly with aggregateCaseVerdicts.
 */
export function constrainFullPass(proposed: Verdict, cases: Verdict[]): Verdict {
  return proposed === "pass" && cases.length ? aggregateCaseVerdicts(cases) : proposed;
}

/** Missing intermediate results violate execution invariants, not evidence coverage. */
export function requiredJudgeResult<T>(result: T | undefined, context: string): T {
  if (result === undefined) throw new Error(`Judge execution contract violation: missing ${context}. Every requested result must exist before aggregation.`);
  return result;
}
