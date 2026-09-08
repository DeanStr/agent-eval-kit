import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import {
  loadSpecs,
  loadFixtures,
  assertScenarioTargetCompatibility,
  assertEmailConfiguration,
} from "../specs.js";
import { validateEvaluationInputs } from "../run/inputs.js";
import { assertArtifactIntegrity } from "../integrity.js";
import { loadComparisonInput } from "../compare.js";
import { loadRunState } from "../run/state.js";
import { buildRunReceipt, configCompatibility } from "../receipts.js";
import { stableJson } from "../io.js";
import { belowPercentageThreshold, scoreRatios } from "../score-slice.js";
import type { EvalConfig, EvalSpec, JudgedItem, RunReport } from "../types.js";
import {
  authoringConfigPath,
  isClarified,
  loadAuthoringPlan,
  type AuthoringCheck,
} from "./plan.js";

export type AuthoringStage =
  | "discovered"
  | "clarified"
  | "configured"
  | "exercised"
  | "calibrated"
  | "excluded";
interface SuiteInputs {
  config: EvalConfig;
  specs: EvalSpec[];
  fixtures: unknown;
}

export async function authoringStatus(projectRoot: string) {
  const root = fs.realpathSync(projectRoot);
  const plan = loadAuthoringPlan(root);
  const suites = new Map<string, SuiteInputs>();
  const reports = new Map<string, RunReport>();
  const checkedMethods = new Set<string>();
  const configFile = plan.config ? authoringConfigPath(root, plan.config) : undefined;
  const suiteKey = (check: AuthoringCheck) => check.suite ?? "";
  const inputsFor = async (binding: AuthoringCheck): Promise<SuiteInputs> => {
    const key = suiteKey(binding);
    const cached = suites.get(key);
    if (cached) return cached;
    if (!configFile) throw new Error("Set config before binding checks");
    const config = loadConfig(configFile, binding.suite ? { suite: binding.suite } : {});
    const specs = loadSpecs(config.paths.specs);
    assertScenarioTargetCompatibility(specs, config.target);
    assertEmailConfiguration(specs, config);
    await validateEvaluationInputs(config, specs);
    const fixtures = loadFixtures(config.paths.fixtures);
    const inputs = { config, specs, fixtures };
    suites.set(key, inputs);
    return inputs;
  };
  const reportFor = (configured: string): RunReport => {
    const directory = fs.realpathSync(path.resolve(root, configured));
    const cached = reports.get(directory);
    if (cached) return cached;
    assertArtifactIntegrity(directory, { require: true });
    const state = loadRunState(directory);
    if (state.status !== "complete" || state.mode === "collect")
      throw new Error(`Authoring trials require completed scored runs: ${directory}`);
    const report = loadComparisonInput(path.join(directory, "report.json")).report;
    reports.set(directory, report);
    return report;
  };
  const checkMethod = (report: RunReport, inputs: SuiteInputs): void => {
    const key = `${inputs.config.suite ?? ""}/${report.runId}/${report.receipt.inputFingerprint}`;
    if (checkedMethods.has(key)) return;
    const selection = report.receipt.inputs.selection;
    const specs = inputs.specs.filter((spec) =>
      Object.hasOwn(report.receipt.inputs.specs, spec.id),
    );
    const current = buildRunReceipt({
      config: inputs.config,
      specs,
      fixtures: inputs.fixtures,
      split: selection.split ?? "all",
      ...(selection.scenarios === undefined ? {} : { scenarioIds: selection.scenarios }),
      ...(selection.textCases === undefined ? {} : { textCaseIds: selection.textCases }),
    });
    if (current.evaluationFingerprint !== report.receipt.evaluationFingerprint)
      throw new Error(
        `Trial ${report.runId} uses a different evaluation method from the current definitions. Restore the original method or replace the trial with a fresh run; CLI provider overrides must be pinned in the config.`,
      );
    checkedMethods.add(key);
  };
  const fullyObserved = (item: JudgedItem, report: RunReport): boolean =>
    Boolean(
      !(
        report.providers.judge.provider === "mock" &&
        ["llm", "pairwise", "text-pairwise", "text-rubric"].includes(item.source)
      ) &&
        item.score &&
        item.score.total > 0 &&
        !belowPercentageThreshold(scoreRatios(item.score).coverage * 100, 100) &&
        ["pass", "partial", "fail", "not_found"].includes(item.verdict),
    );
  const results: Array<{
    id: string;
    area: string;
    statement: string;
    stage: AuthoringStage;
    blockers: string[];
  }> = [];
  const linked = new Set<string>();
  for (const requirement of plan.requirements) {
    let stage: AuthoringStage = requirement.exclusion
      ? "excluded"
      : isClarified(requirement, plan)
        ? "clarified"
        : "discovered";
    const blockers: string[] = [];
    if (!requirement.exclusion) {
      for (const key of requirement.decisionIds)
        if (!plan.decisions.find((decision) => decision.id === key)?.resolution)
          blockers.push(`Open decision: ${key}`);
      for (const key of requirement.dependsOn) {
        const prerequisite = plan.requirements.find((entry) => entry.id === key)!;
        if (prerequisite.exclusion || !prerequisite.checks.length)
          blockers.push(`Prerequisite has no active checks: ${key}`);
      }
    }
    const exercised: boolean[] = [];
    const calibrated: boolean[] = [];
    const usedTrials = new Set<string>();
    for (const binding of requirement.checks) {
      const inputs = await inputsFor(binding);
      const area = inputs.specs.find((spec) => spec.id === binding.area);
      const rubric = area?.rubric.find((item) => item.id === binding.rubric);
      if (!rubric)
        throw new Error(
          `${requirement.id}: unknown check ${binding.suite ?? "default"}/${binding.area}/${binding.rubric}`,
        );
      if (rubric.applicability?.applicable === false)
        throw new Error(`${requirement.id}: an inapplicable rubric cannot cover a requirement`);
      linked.add(`${suiteKey(binding)}/${binding.area}/${binding.rubric}`);
      stage = "configured";
      const observations: Array<{ kind: "good" | "defect"; report: RunReport; item: JudgedItem }> =
        [];
      for (const trial of requirement.trials) {
        const report = reportFor(trial.run);
        if (
          report.receipt.inputs.configCompatibility?.["config.suite"] !==
          configCompatibility(inputs.config)["config.suite"]
        )
          continue;
        const item = report.areas
          .find((entry) => entry.id === binding.area)
          ?.items.find((entry) => entry.id === binding.rubric);
        if (!item) continue;
        usedTrials.add(trial.run);
        checkMethod(report, inputs);
        observations.push({ kind: trial.kind, report, item });
      }
      exercised.push(observations.some(({ item, report }) => fullyObserved(item, report)));
      const goods = observations.filter(
        ({ kind, item, report }) =>
          kind === "good" && fullyObserved(item, report) && item.verdict === "pass",
      );
      const defects = observations.filter(
        ({ kind, item, report }) =>
          kind === "defect" &&
          fullyObserved(item, report) &&
          (item.verdict === "fail" || item.verdict === "not_found"),
      );
      calibrated.push(
        goods.some((good) =>
          defects.some(
            (defect) =>
              good.report.receipt.evaluationFingerprint ===
                defect.report.receipt.evaluationFingerprint &&
              stableJson(good.report.receipt.target) !== stableJson(defect.report.receipt.target),
          ),
        ),
      );
    }
    for (const trial of requirement.trials)
      if (!usedTrials.has(trial.run))
        throw new Error(
          `${requirement.id}: trial ${trial.run} contains none of its linked checks in the matching suite`,
        );
    if (exercised.length && exercised.every(Boolean)) stage = "exercised";
    if (calibrated.length && calibrated.every(Boolean)) stage = "calibrated";
    results.push({
      id: requirement.id,
      area: requirement.area,
      statement: requirement.statement,
      stage,
      blockers,
    });
  }
  const openDecisions = plan.decisions
    .filter((decision) => !decision.resolution)
    .map((decision) => ({
      id: decision.id,
      question: decision.question,
      readyToAsk: decision.dependsOn.every((key) =>
        plan.decisions.some((entry) => entry.id === key && entry.resolution),
      ),
    }));
  const emptyAreas = plan.areas
    .filter((area) => !plan.requirements.some((requirement) => requirement.area === area.id))
    .map((area) => area.id);
  const unlinkedChecks = [...suites.entries()].flatMap(([suite, inputs]) =>
    inputs.specs.flatMap((area) =>
      area.rubric
        .filter((rubric) => !linked.has(`${suite}/${area.id}/${rubric.id}`))
        .map((rubric) => ({ suite: suite || null, area: area.id, rubric: rubric.id })),
    ),
  );
  const counts = Object.fromEntries(
    (["discovered", "clarified", "configured", "exercised", "calibrated", "excluded"] as const).map(
      (stage) => [stage, results.filter((entry) => entry.stage === stage).length],
    ),
  );
  const ready = Boolean(
    plan.scope.reviewedBy &&
      !plan.discovery.remaining.length &&
      !openDecisions.length &&
      !emptyAreas.length &&
      results.some((entry) => entry.stage !== "excluded") &&
      results.every(
        (entry) =>
          ["configured", "exercised", "calibrated", "excluded"].includes(entry.stage) &&
          !entry.blockers.length,
      ),
  );
  return {
    version: 1,
    scope: plan.scope,
    ready,
    counts,
    discoveryRemaining: plan.discovery.remaining,
    emptyAreas,
    openDecisions,
    requirements: results,
    unlinkedChecks,
    interpretation:
      "Authoring readiness covers only the reviewed inventory. It is not a product score or evidence coverage. Calibrated means each linked check passed a recorded good run and failed a compatible run with a different target; it does not establish judge accuracy or every case's behavior.",
  };
}
