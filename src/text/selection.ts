import fs from "node:fs";
import path from "node:path";
import { assertArtifactIntegrity } from "../integrity.js";
import { sha256, stableJson } from "../io.js";
import { loadRunState } from "../run/state.js";
import { materializeSpecs } from "../specs.js";
import type { EvalSpec, EvalSplit, RunReceipt } from "../types.js";
import { textInstances } from "./datasets.js";

export const textCaseKey = (area: string, dataset: string, caseId: string) =>
  `${area}/${dataset}/${caseId}`;

export function textCaseFingerprints(
  specs: EvalSpec[],
  split: EvalSplit | "all" | undefined,
  methodSha256: string,
  candidates: RunReceipt["inputs"]["textCandidates"],
  references: RunReceipt["inputs"]["textReferences"],
) {
  const groups: Record<string, unknown[]> = {};
  for (const spec of materializeSpecs(specs, split))
    for (const rubric of spec.rubric) {
      if (!rubric.dataset) continue;
      for (const instance of textInstances(spec, rubric)) {
        const c = instance.case!;
        const key = textCaseKey(spec.id, rubric.dataset, c.id);
        const prefix = instance.item.id;
        const inputs = (values: typeof candidates) =>
          Object.fromEntries(
            Object.entries(values ?? {}).filter(
              ([id]) => id === prefix || id.startsWith(`${prefix}/`),
            ),
          );
        (groups[key] ??= []).push({
          methodSha256,
          area: { id: spec.id, weight: spec.weight, optional: spec.optional },
          item: instance.item,
          case: { id: c.id, name: c.name, strata: c.strata, split: c.split },
          candidates: inputs(candidates),
          references: inputs(references),
        });
      }
    }
  return Object.fromEntries(
    Object.entries(groups).map(([key, definitions]) => [key, sha256(stableJson(definitions))]),
  );
}

export function changedTextCases(priorRun: string, current: RunReceipt): string[] {
  const directory = path.resolve(priorRun);
  assertArtifactIntegrity(directory, { require: true });
  if (loadRunState(directory).status !== "complete")
    throw new Error("Changed-case selection requires a complete prior run");
  const previous = JSON.parse(
    fs.readFileSync(path.join(directory, "receipt.json"), "utf8"),
  ) as RunReceipt;
  if (
    !previous.inputs.textCases ||
    !current.inputs.textCases ||
    !Object.keys(current.inputs.textCases).length
  )
    throw new Error("Changed-case selection requires text dataset case fingerprints in both runs");
  if (
    previous.inputs.selection.split !== current.inputs.selection.split ||
    stableJson(previous.inputs.selection.areas) !== stableJson(current.inputs.selection.areas)
  )
    throw new Error("Changed-case selection requires the same areas and split");
  // A previous subset is not a cache of unobserved measurements.
  const attempted = previous.inputs.selection.textCases;
  return Object.entries(current.inputs.textCases)
    .filter(
      ([key, hash]) =>
        previous.inputs.textCases![key] !== hash ||
        (attempted !== undefined && !attempted.includes(key)),
    )
    .map(([key]) => key)
    .sort();
}
