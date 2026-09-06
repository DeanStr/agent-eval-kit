import { omitUndefined } from "../invariants.js";
import type { RubricItem, ScenarioEvidence } from "../types.js";

export interface CaseJudgeRequest {
  rubricId: string;
  caseId: string;
  scenarioIds: string[];
  strata: string[];
  split?: "development" | "evaluation";
}

export function caseJudgeRequests(
  items: RubricItem[],
  evidence: ScenarioEvidence[],
): CaseJudgeRequest[] {
  return items.flatMap((item) => {
    if (!item.scenarios.length) return [];
    const relevant = evidence.filter((scenario) => item.scenarios.includes(scenario.scenarioId));
    const shared = relevant.filter((scenario) => !scenario.caseId);
    const byCase = new Map<string, ScenarioEvidence[]>();
    for (const scenario of relevant) {
      if (!scenario.caseId) continue;
      const members = byCase.get(scenario.caseId) ?? [];
      members.push(scenario);
      byCase.set(scenario.caseId, members);
    }
    if (!byCase.size) {
      return [
        omitUndefined({
          rubricId: item.id,
          caseId: "default",
          scenarioIds: relevant.map((scenario) => scenario.scenarioId),
          strata: [...new Set(relevant.flatMap((scenario) => scenario.strata ?? []))].sort(),
          split: relevant.map((scenario) => scenario.split).find(Boolean),
        }),
      ];
    }

    return [...byCase.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([caseId, members]) => {
        const byIdentity = new Map<string, ScenarioEvidence[]>();
        for (const scenario of members) {
          const identity = JSON.stringify(
            omitUndefined({
              strata: [...new Set(scenario.strata ?? [])].sort(),
              split: scenario.split,
            }),
          );
          const matching = byIdentity.get(identity) ?? [];
          matching.push(scenario);
          byIdentity.set(identity, matching);
        }
        const disambiguate = byIdentity.size > 1;
        return [...byIdentity.values()]
          .map((caseMembers) => {
            const sources = [
              ...new Set(
                caseMembers.map((scenario) => scenario.sourceScenarioId ?? scenario.scenarioId),
              ),
            ].sort();
            const allMembers = [...shared, ...caseMembers];
            return omitUndefined({
              rubricId: item.id,
              caseId: disambiguate ? `${sources.join("+")}/${caseId}` : caseId,
              scenarioIds: allMembers.map((scenario) => scenario.scenarioId),
              strata: [...new Set(caseMembers.flatMap((scenario) => scenario.strata ?? []))].sort(),
              split: caseMembers.map((scenario) => scenario.split).find(Boolean),
            });
          })
          .sort((left, right) => left.caseId.localeCompare(right.caseId));
      });
  });
}

export function canonicalEvidenceRefs(evidence: ScenarioEvidence[]): Set<string> {
  return new Set(
    evidence.flatMap((scenario) => [
      `${scenario.scenarioId}/evidence.json`,
      ...scenario.observations.map(
        (_text, index) => `${scenario.scenarioId}/evidence.json#observation-${index + 1}`,
      ),
      ...scenario.screenshots.map((shot) => `${scenario.scenarioId}/${shot.path}`),
      ...scenario.transcript.map(
        (entry) => `${scenario.scenarioId}/${scenario.kind}-transcript.ndjson#step-${entry.step}`,
      ),
    ]),
  );
}
