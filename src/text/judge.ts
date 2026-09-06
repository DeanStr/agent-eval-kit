import fs from "node:fs";
import path from "node:path";
import { textCaseKey } from "./selection.js";
import { requireDefined } from "../invariants.js";
import type { RunReceipt, JudgedCase, JudgedItem } from "../types.js";
import { aggregateCaseVerdicts } from "../judging/contracts.js";
import { textInstances } from "./datasets.js";
import { judgeTextPairwise } from "./pairwise.js";
import { judgeTextRubric } from "./rubric.js";

/** Execute bound graders, then retain case measurements and aggregate each criterion. */
export async function judgeDirectText(options: Parameters<typeof judgeTextPairwise>[0]) {
  const declarations = options.spec.rubric.filter((item) =>
    ["text-pairwise", "text-rubric"].includes(item.grader.type),
  );
  if (!declarations.length) return { items: [], cases: [] };
  const groups = declarations.map((item) => ({
    item,
    instances: textInstances(options.spec, item).map((instance) => ({
      ...instance,
      rubricId: item.id,
      caseKey: instance.case
        ? textCaseKey(
            options.spec.id,
            requireDefined(item.dataset, `${item.id} dataset`),
            instance.case.id,
          )
        : undefined,
    })),
  }));
  const expanded = groups.flatMap((group) => group.instances);
  const receipt = JSON.parse(
    fs.readFileSync(path.join(options.runDir, "receipt.json"), "utf8"),
  ) as RunReceipt;
  const selection =
    receipt.inputs.selection.textCases === undefined
      ? undefined
      : new Set(receipt.inputs.selection.textCases);
  const selected: typeof expanded = [],
    skipped: typeof expanded = [];
  for (const instance of expanded) {
    const included =
      selection === undefined || instance.caseKey === undefined || selection.has(instance.caseKey);
    (included ? selected : skipped).push(instance);
  }
  const spec = { ...options.spec, rubric: selected.map((instance) => instance.item) };
  const results = [
    ...(await judgeTextPairwise({ ...options, spec })),
    ...(await judgeTextRubric({ ...options, spec })),
  ];
  for (const instance of skipped)
    results.push({
      id: instance.item.id,
      source: instance.item.grader.type as "text-pairwise" | "text-rubric",
      verdict: "cannot_judge",
      confidence: "low",
      reasoning: "Not evaluated: excluded by text case selection. No previous judgment was reused.",
      evidenceRefs: [],
    });
  const byId = new Map(results.map((result) => [result.id, result]));
  const resultFor = (id: string) => requireDefined(byId.get(id), `text judgment ${id}`);
  const cases: JudgedCase[] = expanded.flatMap((instance) => {
    if (!instance.case) return [];
    const result = resultFor(instance.item.id);
    if (result.source !== "text-pairwise" && result.source !== "text-rubric")
      throw new Error(`Missing text case judgment ${instance.item.id}`);
    return [
      {
        areaId: spec.id,
        rubricId: instance.rubricId,
        caseId: instance.case.id,
        scenarioIds: [],
        strata: instance.case.strata,
        ...(instance.case.split ? { split: instance.case.split } : {}),
        verdict: result.verdict,
        confidence: result.confidence,
        reasoning: result.reasoning,
        evidenceRefs: [...result.evidenceRefs, ...(result.comparisons ?? [])],
        source: result.source,
      },
    ];
  });
  const items: JudgedItem[] = groups.map(({ item, instances }) => {
    if (!item.dataset) return resultFor(item.id);
    const group = instances.map((instance) => resultFor(instance.item.id));
    const first = requireDefined(group[0], `text cases for ${item.id}`);
    const verdict = aggregateCaseVerdicts(group.map((result) => result.verdict));
    return {
      id: item.id,
      source: first.source,
      verdict,
      confidence: verdict === "cannot_judge" ? "low" : "high",
      reasoning: `${group.length} cases: ${group.map((result) => `${result.id}=${result.verdict}`).join(", ")}. Every case must pass.`,
      evidenceRefs: group.flatMap((result) => result.evidenceRefs),
      comparisons: group.flatMap((result) => result.comparisons ?? []),
    };
  });
  return { items, cases };
}
