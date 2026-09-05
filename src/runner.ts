import { withRunLock, loadRunState, processIsAlive, type RunState } from "./run/state.js";
import { recoverRunArtifacts } from "./run/recovery.js";
import { evaluatorInputPaths, snapshotEvaluationInputs, validateEvaluationInputs } from "./run/inputs.js";
import fs from "node:fs";
import path from "node:path";
import { loadResumableRunReport } from "./compare.js";
import type { ConfigOverrides } from "./config.js";
import { judgeArea } from "./graders.js";
import { writeArtifactIndex } from "./integrity.js";
import { createTimestampedDirectory, sha256, stableJson, writeJson } from "./io.js";
import { startLifecycle } from "./lifecycle.js";
import { RunLogger } from "./log.js";
import { writeReportArtifacts } from "./report.js";
import { RunReceipts } from "./run/receipt.js";
import { executeScenario } from "./scenario.js";
import { throwIfCancelled } from "./cancellation.js";
import { assertEvaluationPlatform } from "./platform.js";
import { buildReport, scoreArea } from "./scoring.js";
import { assertScenarioSelectors, assertScenarioTargetCompatibility, materializeSpecs } from "./specs.js";
import type { AreaResult, EvalConfig, EvalSpec, EvalSplit, RunReport, ScenarioEvidence } from "./types.js";

export interface RunOptions {
  config: EvalConfig;
  configFile: string;
  specs: EvalSpec[];
  fixtures: unknown;
  scenarioIds?: string[];
  split?: EvalSplit | "all";
  configOverrides?: ConfigOverrides;
  ignoredTargetPaths?: string[];
  resumeDir?: string;
  dryRun?: boolean;
}

function createRunDir(root: string): string {
  return createTimestampedDirectory(root);
}

function specHashes(specs: EvalSpec[]): Record<string, string> {
  return Object.fromEntries(
    specs.map((spec) => [spec.id, sha256(fs.readFileSync(spec.sourceFile))]),
  );
}

function skippedEvidence(spec: EvalSpec, scenarioId: string, config: EvalConfig): ScenarioEvidence {
  const scenario = spec.scenarios.find((candidate) => candidate.id === scenarioId)!;
  const now = new Date().toISOString();
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    kind: scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace"),
    persona: scenario.persona,
    sourceScenarioId: scenario.sourceScenarioId,
    caseId: scenario.caseId,
    strata: scenario.strata,
    split: scenario.split,
    outcome: "blocked",
    summary: "NOT RUN — excluded by scenario filter. No evidence was gathered.",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: config.agent.provider,
    model: config.agent.model,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
}

function dependencyBlockedEvidence(
  spec: EvalSpec,
  scenarioId: string,
  unmet: Array<{ id: string; evidence?: ScenarioEvidence }>,
  config: EvalConfig,
): ScenarioEvidence {
  const scenario = spec.scenarios.find((candidate) => candidate.id === scenarioId)!;
  const now = new Date().toISOString();
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    kind: scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace"),
    persona: scenario.persona,
    sourceScenarioId: scenario.sourceScenarioId,
    caseId: scenario.caseId,
    strata: scenario.strata,
    split: scenario.split,
    outcome: "blocked",
    summary: `Dependency not completed: ${unmet.map((item) => `${item.id} (${item.evidence?.outcome ?? "missing"})`).join(", ")}.`,
    observations: unmet.map((item) => `${item.id}: ${item.evidence?.summary ?? "No dependency result was available in this execution."}`),
    evidenceRefs: unmet.flatMap((item) => item.evidence?.evidenceRefs ?? []),
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: config.agent.provider,
    model: config.agent.model,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
}

export async function runEvaluation(options: RunOptions): Promise<{ runDir: string; report?: RunReport }> {
  assertEvaluationPlatform();
  throwIfCancelled();
  const { config, fixtures } = options;
  assertScenarioTargetCompatibility(options.specs, config.target);
  const selectedSplit = options.split ?? "development";
  const specs = materializeSpecs(options.specs, selectedSplit);
  if (!specs.length && !options.resumeDir) {
    throw new Error(`Split ${selectedSplit} selects no rubric items in the selected areas`);
  }
  const activeAreaIds = new Set(specs.map((spec) => spec.id));
  const sourceSpecs = options.specs.filter((spec) => activeAreaIds.has(spec.id));
  assertScenarioSelectors(specs, options.scenarioIds, selectedSplit);
  await validateEvaluationInputs(config, sourceSpecs, selectedSplit, options.scenarioIds);
  if (options.dryRun) {
    for (const spec of specs) {
      console.log(`${spec.id} (${spec.weight}${spec.optional ? ", optional" : ""}) — ${spec.title}`);
      for (const scenario of spec.scenarios) {
        const selected = !options.scenarioIds?.length || options.scenarioIds.includes(scenario.id) || Boolean(scenario.sourceScenarioId && options.scenarioIds.includes(scenario.sourceScenarioId));
        console.log(`  ${selected ? ">" : "~"} ${scenario.id} [${scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")}] ${scenario.name}`);
      }
      for (const rubric of spec.rubric) {
        console.log(`    ${rubric.id} w${rubric.weight} ${rubric.grader.type}${rubric.gate ? " GATE" : ""} [${rubric.tags.join(", ")}]`);
      }
    }
    return { runDir: "(dry-run)" };
  }

  const runDir = options.resumeDir ? path.resolve(options.resumeDir) : createRunDir(config.paths.runs);
  const stateFile = path.join(runDir, "run-state.json");
  if (options.resumeDir && !fs.existsSync(stateFile)) {
    throw new Error(`Cannot resume ${runDir}: run-state.json does not exist`);
  }
  return withRunLock(runDir, async () => {
    const existingState = fs.existsSync(stateFile) ? loadRunState(runDir) : undefined;
    if (options.resumeDir && existingState?.status === "running" && processIsAlive(existingState.pid)) {
      throw new Error(`Cannot resume ${runDir}: run-state.json belongs to active process ${existingState.pid}`);
    }
    if (!specs.length) {
      throw new Error(`Split ${selectedSplit} selects no rubric items in the selected areas`);
    }
    const { priorIndex, sealedPaths, prefixIsFullySealed, reportIsSealed } = recoverRunArtifacts(runDir, specs, existingState);
    const reportFile = path.join(runDir, "report.json");
    const hashes = specHashes(sourceSpecs);
    const receipts = new RunReceipts({
      config,
      specs: sourceSpecs,
      fixtures,
      scenarioIds: options.scenarioIds,
      split: selectedSplit,
      ignoredTargetPaths: options.ignoredTargetPaths,
    }, runDir);
    if (existingState) {
      if (existingState.inputFingerprint !== receipts.current.inputFingerprint) {
        throw new Error("Configuration, fixtures, provider method, selected inputs, or target revision changed since this run began. Start a new run instead.");
      }
      for (const [id, hash] of Object.entries(existingState.specHashes)) {
        if (hashes[id] && hashes[id] !== hash) {
          throw new Error(`Spec ${id} changed since this run began. Start a new run, or use rescore intentionally.`);
        }
      }
    } else {
      snapshotEvaluationInputs(config, sourceSpecs, runDir, selectedSplit, receipts.current, options.scenarioIds);
    }
    const state: RunState = existingState ?? {
      schemaVersion: 1,
      status: "running",
      runId: path.basename(runDir),
      pid: process.pid,
      configFile: path.resolve(options.configFile),
      startedAt: new Date().toISOString(),
      selectedAreas: specs.map((spec) => spec.id),
      selectedScenarios: options.scenarioIds,
      selectedSplit,
      specHashes: hashes,
      inputFingerprint: receipts.current.inputFingerprint,
      configOverrides: options.configOverrides,
    };
    state.schemaVersion = 1;
    state.inputFingerprint = receipts.current.inputFingerprint;
    state.configOverrides = options.configOverrides ?? state.configOverrides;
    state.status = "running";
    state.pid = process.pid;
    delete state.lastError;
    writeJson(stateFile, state);
    writeJson(path.join(runDir, "receipt.json"), receipts.current);

    const logger = new RunLogger(path.join(runDir, "run.log"));
    const priorReport = reportIsSealed
      ? loadResumableRunReport(reportFile).report
      : undefined;
    const reusePriorEvidence = !priorReport || stableJson(priorReport.receipt.target) === stableJson(receipts.current.target);
    const hasReusableScenarioEvidence = specs.some(spec => spec.scenarios.some(scenario => {
      const relative = `${scenario.id}/evidence.json`;
      if (!sealedPaths.has(relative) || !prefixIsFullySealed(`${scenario.id}/`)) return false;
      const evidence = JSON.parse(fs.readFileSync(path.join(runDir, relative), "utf8")) as ScenarioEvidence;
      return evidence.outcome === "completed" || evidence.outcome === "feature_not_found";
    }));
    const priorAreas = new Map((reusePriorEvidence ? priorReport?.areas ?? [] : []).map((area) => [area.id, area]));
    const areaResults: AreaResult[] = [];
    let lifecycle;

    const persist = () => {
      const report = buildReport({ runId: state.runId, startedAt: state.startedAt, config, areas: areaResults, receipt: receipts.current });
      writeReportArtifacts(runDir, report, specs);
      return report;
    };

    try {
      logger.line(`${options.resumeDir ? "Resuming" : "Starting"} ${config.project.name} in ${runDir}`);
      logger.line(`Agent ${config.agent.provider}${config.agent.model ? `/${config.agent.model}` : ""}; judge ${config.judge.provider}${config.judge.model ? `/${config.judge.model}` : ""}`);
      if (priorReport && !reusePriorEvidence) {
        logger.line("Prior evidence targets an earlier canonical target revision; rerunning it on the recovered revision");
      }
      const refreshTargetReceipt = (phase: string) => receipts.refresh(
        phase, state, Boolean(reusePriorEvidence && (priorReport?.areas.length || hasReusableScenarioEvidence)),
      );
      lifecycle = await startLifecycle(config, runDir, {
        skipSetup: Boolean(priorIndex),
        onSetupComplete: () => {
          // Seal target mutations immediately after every successful setup,
          // including a setup rerun during recovery. Doing this before target
          // start/readiness also keeps a later lifecycle failure resumable.
          refreshTargetReceipt("setup");
        },
        // Managed dev servers commonly create build output while becoming ready.
        // Record that exact target state before collecting any evidence,
        // including when a resumed dev server rebuilds generated output.
        onReady: () => refreshTargetReceipt("startup"),
      });
      for (const spec of specs) {
        logger.line(`Area ${spec.id}: ${spec.title}`);
        throwIfCancelled();
        const selectedScenarioIds = spec.scenarios
          .filter((scenario) => !options.scenarioIds?.length || options.scenarioIds.includes(scenario.id) || Boolean(scenario.sourceScenarioId && options.scenarioIds.includes(scenario.sourceScenarioId)))
          .map((scenario) => scenario.id);
        const prior = priorAreas.get(spec.id);
        const reusableArea =
          prior &&
          prefixIsFullySealed(`areas/${spec.id}/`) &&
          spec.scenarios.every((scenario) => {
            if (!selectedScenarioIds.includes(scenario.id)) return true;
            const file = path.join(runDir, scenario.id, "evidence.json");
            const relative = `${scenario.id}/evidence.json`;
            if (!sealedPaths.has(relative) || !fs.existsSync(file)) return false;
            const evidence = JSON.parse(fs.readFileSync(file, "utf8")) as ScenarioEvidence;
            return evidence.outcome !== "agent_error";
          });
        if (reusableArea) {
          logger.line(`  = reusing completed area (${prior.scorePct ?? "n/a"}% / ${prior.coveragePct}% coverage)`);
          areaResults.push(prior);
          continue;
        }

        const evidence: ScenarioEvidence[] = [];
        for (const scenario of spec.scenarios) {
          lifecycle.assertRunning();
          if (!selectedScenarioIds.includes(scenario.id)) {
            const skipped = skippedEvidence(spec, scenario.id, config);
            const scenarioDir = path.join(runDir, scenario.id);
            fs.mkdirSync(scenarioDir, { recursive: true });
            writeJson(path.join(scenarioDir, "evidence.json"), skipped);
            evidence.push(skipped);
            continue;
          }
          const scenarioDir = path.join(runDir, scenario.id);
          const evidenceFile = path.join(scenarioDir, "evidence.json");
          const evidenceRelative = `${scenario.id}/evidence.json`;
          const evidenceIsSealed = reusePriorEvidence && sealedPaths.has(evidenceRelative) && prefixIsFullySealed(`${scenario.id}/`) && fs.existsSync(evidenceFile);
          if (!evidenceIsSealed && fs.existsSync(scenarioDir)) {
            // An interrupted provider may have left a plausible-looking but
            // unsealed evidence file and partial transcripts. Never reuse or
            // preserve those as completed evidence.
            fs.rmSync(scenarioDir, { recursive: true, force: true });
          }
          const unmet = scenario.dependsOn
            .map((id) => ({ id, evidence: evidence.find((item) => item.scenarioId === id) }))
            .filter((item) => item.evidence?.outcome !== "completed");
          if (unmet.length) {
            const blocked = dependencyBlockedEvidence(spec, scenario.id, unmet, config);
            fs.mkdirSync(scenarioDir, { recursive: true });
            writeJson(evidenceFile, blocked);
            logger.line(`  ~ ${scenario.id}: blocked by ${unmet.map((item) => item.id).join(", ")}`);
            evidence.push(blocked);
            continue;
          }
          if (evidenceIsSealed) {
            const priorEvidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8")) as ScenarioEvidence;
            if (priorEvidence.outcome !== "agent_error") {
              logger.line(`  = ${scenario.id}: reusing ${priorEvidence.outcome}`);
              evidence.push(priorEvidence);
              continue;
            }
          }
          if (fs.existsSync(scenarioDir)) fs.rmSync(scenarioDir, { recursive: true, force: true });
          logger.line(`  > ${scenario.id}: ${scenario.name}`);
          const result = await executeScenario({
            config,
            spec,
            scenario,
            fixtures,
            directory: scenarioDir,
            evaluatorOnlyPaths: [
              ...evaluatorInputPaths(config, sourceSpecs, selectedSplit),
              options.configFile,
              path.join(path.dirname(path.resolve(options.configFile)), ".env"),
              config.paths.specs,
              config.paths.fixtures,
              config.paths.runs,
              config.paths.auth,
              config.paths.baselines,
              runDir,
              ...(options.ignoredTargetPaths ?? []),
            ].filter((value): value is string => Boolean(value)),
            onProgress: (message) => logger.line(`    ${message}`),
          });
          if (scenario.collect) refreshTargetReceipt(`collector ${scenario.id}`);
          lifecycle.assertRunning();
          logger.line(`    ${result.outcome} in ${(result.durationMs / 1000).toFixed(1)}s; ${result.screenshots.length} screenshots`);
          evidence.push(result);
          writeArtifactIndex(runDir);
        }

        lifecycle.assertRunning();
        // Text inputs are collected directly, without scenario evidence. Seal
        // them and completed setup before the first vote so a failed judge call
        // can resume with intact inputs without repeating successful setup.
        if (evidence.length || spec.rubric.some(item => item.grader.type === "text-pairwise")) writeArtifactIndex(runDir);
        const judged = await judgeArea({
          config,
          spec,
          evidence,
          runDir,
          areaDirectory: path.join(runDir, "areas", spec.id),
          onProgress: (message) => logger.line(`  ${message}`),
          // A grader is allowed to build or otherwise exercise the project. Seal
          // each resulting target revision before another grader or judge runs,
          // so both failed and completed runs remain accurately resumable.
          onVoteComplete: () => writeArtifactIndex(runDir),
          onCommandGraderComplete: (item) => refreshTargetReceipt(`command grader ${item.id}`),
        });
        lifecycle.assertRunning();
        const area = scoreArea({
          spec,
          judgements: judged.items,
          evidence,
          config,
          defects: judged.defects,
          notes: judged.notes,
          caseResults: judged.cases,
        });
        areaResults.push(area);
        logger.line(`  score ${area.scorePct ?? "n/a"}% / ${area.coveragePct}% coverage; ${area.pendingManual.length} manual`);
        persist();
      }

      for (const prior of priorAreas.values()) {
        if (!areaResults.some((area) => area.id === prior.id)) areaResults.push(prior);
      }
      areaResults.sort((left, right) => left.id.localeCompare(right.id));
      // Lifecycle logs are retained evidence. Stop the target before the final
      // report writes its artifact index so shutdown output cannot invalidate a
      // run immediately after it completes.
      lifecycle.assertRunning();
      await lifecycle.stop();
      lifecycle = undefined;
      throwIfCancelled();
      const report = persist();
      state.status = "complete";
      writeJson(stateFile, state);
      logger.line(
        report.scoreWithheld
          ? `Score withheld: ${report.overallCoveragePct}% coverage; provisional ${report.overallScorePct ?? "n/a"}%`
          : `Overall ${report.overallScorePct ?? "n/a"}% / ${report.overallCoveragePct}% coverage`,
      );
      logger.line(`Report ${path.join(runDir, "report.html")}`);
      return { runDir, report };
    } catch (error) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      writeJson(stateFile, state);
      logger.line(`FATAL ${state.lastError}`);
      logger.line(`Resume with: aek run --resume ${runDir}`);
      throw error;
    } finally {
      await lifecycle?.stop();
      await logger.close();
    }
  });
}
