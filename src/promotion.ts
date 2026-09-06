import { omitUndefined } from "./invariants.js";
import fs from "node:fs";
import { evaluateCiThresholds } from "./ci.js";
import { sha256 } from "./io.js";
import { loadSpecs, materializeSpecs } from "./specs.js";
import type { EvalConfig, RunReport } from "./types.js";

export class PromotionPolicyError extends Error {
  constructor(readonly failures: string[]) {
    super(`Baseline release policy rejected promotion:\n  - ${failures.join("\n  - ")}`);
    this.name = "PromotionPolicyError";
  }
}

/** Expected coverage comes from the declared suite, never a run's selected slice. */
export function evaluatePromotion(
  config: EvalConfig,
  report: RunReport,
  mode: "release" | "milestone",
  reason?: string,
) {
  if (!["release", "milestone"].includes(mode))
    throw new Error("Promotion mode must be release or milestone");
  if (mode === "milestone") {
    if (!reason?.trim())
      throw new Error("Milestone promotion requires a non-empty review reason (--reason)");
    return { mode, reason: reason.trim(), failures: [] as string[] };
  }
  if (reason !== undefined)
    throw new Error("A review reason is only supported for milestone promotion");
  const policy = config.promotion ?? {
    minimumCoverage: 100,
    split: "all" as const,
    includeOptional: false,
  };
  // Optional areas may still supply prerequisites to required scored areas.
  const sourceSpecs = loadSpecs(config.paths.specs).map((spec) =>
    policy.includeOptional || !spec.optional ? spec : { ...spec, rubric: [] },
  );
  const plan = materializeSpecs(sourceSpecs, policy.split);
  const expected = plan.filter((spec) => spec.rubric.length);
  if (!expected.length)
    throw new Error(`Promotion policy split ${policy.split} has no required areas`);
  const expectedIds = new Set(expected.map((spec) => spec.id));
  const policyReport = {
    ...report,
    areas: report.areas
      .filter((area) => expectedIds.has(area.id))
      .map((area) => ({ ...area, optional: false })),
  };
  const failures = evaluateCiThresholds(policyReport, {
    minimumCoverage: policy.minimumCoverage,
    ...omitUndefined({ minimumScore: policy.minimumScore }),
  });
  const runSplit = report.receipt.inputs.selection.split ?? "all";
  if (runSplit !== policy.split)
    failures.push(
      `run split ${runSplit} does not match promotion split ${policy.split}; evaluate the required split before promotion`,
    );
  if (report.scoreWithheld) failures.push("headline score is withheld");
  for (const spec of plan) {
    if (report.receipt.inputs.specs[spec.id]?.sha256 !== sha256(fs.readFileSync(spec.sourceFile)))
      failures.push(
        `suite definition changed for ${spec.id}; evaluate the current suite before promotion`,
      );
  }
  for (const spec of expected) {
    const area = report.areas.find((area) => area.id === spec.id);
    if (!area) {
      failures.push(`missing required area ${spec.id}`);
      continue;
    }
    const expectedItems = new Set(spec.rubric.map((item) => item.id));
    const actualItems = new Set(area.items.map((item) => item.id));
    if (
      expectedItems.size !== actualItems.size ||
      [...expectedItems].some((id) => !actualItems.has(id))
    )
      failures.push(
        `rubric selection does not match promotion split ${policy.split} in ${spec.id}`,
      );
    for (const item of spec.rubric.filter((item) => item.gate)) {
      const gate = area.gates.find((gate) => gate.itemId === item.id);
      if (gate?.status !== "passed")
        failures.push(`required gate ${spec.id}/${item.id} is ${gate?.status ?? "missing"}`);
    }
    for (const scenario of spec.scenarios) {
      const result = area.scenarios.find((result) => result.scenarioId === scenario.id);
      if (!result || !["completed", "feature_not_found"].includes(result.outcome))
        failures.push(
          `required scenario ${scenario.id} was not exercised (${result?.outcome ?? "missing"})`,
        );
    }
  }
  return {
    mode,
    policy,
    expectedAreas: expected.map((spec) => spec.id),
    expectedScenarios: plan.flatMap((spec) => spec.scenarios.map((scenario) => scenario.id)),
    failures,
  };
}
