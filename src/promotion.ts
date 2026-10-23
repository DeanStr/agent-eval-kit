import { specSourceBytes } from "./specs.js";
import { omitUndefined } from "./invariants.js";
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
  const selection = evaluateSuiteCompleteness(config, report, policy);
  const expected = selection.expected;
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
  failures.push(...selection.failures);
  if (report.scoreWithheld) failures.push("headline score is withheld");
  for (const spec of expected) {
    const area = report.areas.find((area) => area.id === spec.id);
    if (!area) continue;
    for (const item of spec.rubric.filter((item) => item.gate)) {
      const gate = area.gates.find((gate) => gate.itemId === item.id);
      if (gate?.status !== "passed")
        failures.push(`required gate ${spec.id}/${item.id} is ${gate?.status ?? "missing"}`);
    }
  }
  return {
    mode,
    policy,
    expectedAreas: expected.map((spec) => spec.id),
    expectedScenarios: selection.plan.flatMap((spec) =>
      spec.scenarios.map((scenario) => scenario.id),
    ),
    failures,
  };
}

/** Full suite validation shared by release promotion and incremental improvement. */
export function evaluateSuiteCompleteness(
  config: EvalConfig,
  report: RunReport,
  policy: Pick<NonNullable<EvalConfig["promotion"]>, "includeOptional" | "split">,
) {
  // Optional areas may still supply prerequisites to required scored areas.
  const sourceSpecs = loadSpecs(config.paths.specs).map((spec) =>
    policy.includeOptional || !spec.optional ? spec : { ...spec, rubric: [] },
  );
  const plan = materializeSpecs(sourceSpecs, policy.split);
  const expected = plan.filter((spec) => spec.rubric.length);
  if (!expected.length)
    throw new Error(`Promotion policy split ${policy.split} has no required areas`);
  const failures: string[] = [];
  const runSplit = report.receipt.inputs.selection.split ?? "all";
  if (runSplit !== policy.split)
    failures.push(
      `run split ${runSplit} does not match promotion split ${policy.split}; evaluate the required split before promotion`,
    );
  const selectedTextCases = report.receipt.inputs.selection.textCases;
  if (selectedTextCases !== undefined) {
    const fingerprints = report.receipt.inputs.textCases;
    // Only unchanged definitions can establish which fingerprints the retained
    // run must contain. A different release split or edited suite is a policy
    // mismatch, not proof that the run lost provenance.
    const expectedCases = sourceSpecs
      .filter(
        (spec) =>
          report.receipt.inputs.selection.areas.includes(spec.id) &&
          report.receipt.inputs.specs[spec.id]?.sha256 === sha256(specSourceBytes(spec)),
      )
      .flatMap((spec) =>
        spec.rubric.flatMap((item) =>
          item.dataset && item.applicability?.applicable !== false
            ? spec
                .datasets![item.dataset]!.filter(
                  (entry) => !entry.split || runSplit === "all" || entry.split === runSplit,
                )
                .map((entry) => `${spec.id}/${item.dataset}/${entry.id}`)
            : [],
        ),
      );
    if (
      !fingerprints ||
      [...expectedCases, ...selectedTextCases].some(
        (key) => !Object.hasOwn(fingerprints, key) || !/^[a-f0-9]{64}$/.test(fingerprints[key]!),
      )
    )
      throw new Error(
        "Text case selection requires complete case fingerprints in the receipt. Restore the complete receipt or start a new run before release promotion.",
      );
    if (Object.keys(fingerprints).some((key) => !selectedTextCases.includes(key)))
      failures.push(
        "text dataset selection is incomplete; evaluate all required cases before release promotion",
      );
  }
  for (const spec of plan) {
    if (report.receipt.inputs.specs[spec.id]?.sha256 !== sha256(specSourceBytes(spec)))
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
    for (const scenario of spec.scenarios) {
      const result = area.scenarios.find((result) => result.scenarioId === scenario.id);
      if (!result || !["completed", "feature_not_found"].includes(result.outcome))
        failures.push(
          `required scenario ${scenario.id} was not exercised (${result?.outcome ?? "missing"})`,
        );
    }
  }
  return { plan, expected, failures };
}
