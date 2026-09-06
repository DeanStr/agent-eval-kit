import { assertSavedWorkflowEvidence, bindInputs, validateWorkflowSelection } from "./workflow.js";
import { withRunLock, loadRunState, processIsAlive, type RunState } from "./run/state.js";
import { recoverRunArtifacts } from "./run/recovery.js";
import {
  evaluatorInputPaths,
  snapshotEvaluationInputs,
  validateEvaluationInputs,
} from "./run/inputs.js";
import fs from "node:fs";
import path from "node:path";
import { loadResumableRunReport } from "./compare.js";
import type { ConfigOverrides } from "./config.js";
import { sealCollection } from "./collection.js";
import { judgeArea, runCommandGrader } from "./graders.js";
import { writeArtifactIndex } from "./integrity.js";
import { createTimestampedDirectory, sha256, stableJson, writeJson } from "./io.js";
import { startLifecycle, readSetupRecord } from "./lifecycle.js";
import { RunLogger } from "./log.js";
import { writeReportArtifacts } from "./report.js";
import { RunReceipts } from "./run/receipt.js";
import { executeScenario } from "./scenario.js";
import { throwIfCancelled } from "./cancellation.js";
import { assertEvaluationPlatform } from "./platform.js";
import { buildReport, scoreArea } from "./scoring.js";
import {
  assertScenarioSelectors,
  assertScenarioTargetCompatibility,
  assertEmailConfiguration,
  materializeSpecs,
} from "./specs.js";
import type {
  AreaResult,
  EvalConfig,
  EvalSpec,
  EvalSplit,
  RunReport,
  ScenarioEvidence,
  JudgedItem,
} from "./types.js";

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
  dryRunJson?: boolean;
  collectOnly?: boolean;
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
    ...(scenario.persona === undefined ? {} : { persona: scenario.persona }),
    ...(scenario.sourceScenarioId === undefined
      ? {}
      : { sourceScenarioId: scenario.sourceScenarioId }),
    ...(scenario.caseId === undefined ? {} : { caseId: scenario.caseId }),
    ...(scenario.strata === undefined ? {} : { strata: scenario.strata }),
    ...(scenario.split === undefined ? {} : { split: scenario.split }),
    outcome: "blocked",
    summary: "NOT RUN — excluded by scenario filter. No evidence was gathered.",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: config.agent.provider,
    ...(config.agent.model === undefined ? {} : { model: config.agent.model }),
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
    ...(scenario.persona === undefined ? {} : { persona: scenario.persona }),
    ...(scenario.sourceScenarioId === undefined
      ? {}
      : { sourceScenarioId: scenario.sourceScenarioId }),
    ...(scenario.caseId === undefined ? {} : { caseId: scenario.caseId }),
    ...(scenario.strata === undefined ? {} : { strata: scenario.strata }),
    ...(scenario.split === undefined ? {} : { split: scenario.split }),
    outcome: "blocked",
    summary: `Dependency not completed: ${unmet.map((item) => `${item.id} (${item.evidence?.outcome ?? "missing"})`).join(", ")}.`,
    observations: unmet.map(
      (item) =>
        `${item.id}: ${item.evidence?.summary ?? "No dependency result was available in this execution."}`,
    ),
    evidenceRefs: unmet.flatMap((item) => item.evidence?.evidenceRefs ?? []),
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: config.agent.provider,
    ...(config.agent.model === undefined ? {} : { model: config.agent.model }),
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
}

export async function runEvaluation(
  options: RunOptions,
): Promise<{ runDir: string; report?: RunReport }> {
  assertEvaluationPlatform();
  throwIfCancelled();
  if (options.resumeDir) {
    if (!fs.existsSync(path.join(path.resolve(options.resumeDir), "run-state.json")))
      throw new Error(
        `Cannot resume ${path.resolve(options.resumeDir)}: run-state.json does not exist`,
      );
    const saved = loadRunState(path.resolve(options.resumeDir));
    if (saved.mode === "collect" && saved.status === "complete")
      throw new Error("Collection is sealed; use aek judge --evidence or start a new collection");
    if (saved.mode !== (options.collectOnly ? "collect" : undefined))
      throw new Error("Run mode differs; resume using the original collect/run command");
  }
  const { config, fixtures } = options;
  assertScenarioTargetCompatibility(options.specs, config.target);
  assertEmailConfiguration(options.specs, config);
  const selectedSplit = options.split ?? "development";
  const specs = materializeSpecs(options.specs, selectedSplit);
  if (!specs.some((spec) => spec.rubric.length) && !options.resumeDir) {
    throw new Error(`Split ${selectedSplit} selects no rubric items in the selected areas`);
  }
  validateWorkflowSelection(specs);
  const sourceSpecs = options.specs;
  assertScenarioSelectors(specs, options.scenarioIds, selectedSplit);
  await validateEvaluationInputs(config, sourceSpecs, selectedSplit, options.scenarioIds);
  if (options.dryRun) {
    const isSelected = (scenario: EvalSpec["scenarios"][number]) =>
      !options.scenarioIds?.length ||
      options.scenarioIds.includes(scenario.id) ||
      Boolean(scenario.sourceScenarioId && options.scenarioIds.includes(scenario.sourceScenarioId));
    if (options.dryRunJson) {
      console.log(
        JSON.stringify({
          version: 1,
          areas: specs.map((spec) => ({
            id: spec.id,
            scenarios: spec.scenarios.filter(isSelected).map((scenario) => ({ id: scenario.id })),
          })),
        }),
      );
      return { runDir: "(dry-run)" };
    }
    for (const spec of specs) {
      console.log(
        `${spec.id} (${spec.weight}${spec.optional ? ", optional" : ""}) — ${spec.title}`,
      );
      for (const scenario of spec.scenarios) {
        const selected = isSelected(scenario);
        console.log(
          `  ${selected ? ">" : "~"} ${scenario.id} [${scenario.kind ?? (config.target.kind === "web" ? "browser" : "workspace")}] ${scenario.name}`,
        );
      }
      for (const item of spec.exclusions ?? [])
        console.log(`    ${item.id} w${item.weight} EXCLUDED: ${item.reason}`);
      for (const rubric of spec.rubric) {
        console.log(
          `    ${rubric.id} w${rubric.weight} ${rubric.grader.type}${rubric.gate ? " GATE" : ""} [${rubric.tags.join(", ")}]`,
        );
      }
    }
    return { runDir: "(dry-run)" };
  }

  const runDir = options.resumeDir
    ? path.resolve(options.resumeDir)
    : createRunDir(config.paths.runs);
  const stateFile = path.join(runDir, "run-state.json");
  if (options.resumeDir && !fs.existsSync(stateFile)) {
    throw new Error(`Cannot resume ${runDir}: run-state.json does not exist`);
  }
  return withRunLock(runDir, async () => {
    const existingState = fs.existsSync(stateFile) ? loadRunState(runDir) : undefined;
    if (
      options.resumeDir &&
      existingState?.mode === "collect" &&
      existingState.status === "complete"
    )
      throw new Error("Collection is sealed; use aek judge --evidence or start a new collection");
    if (options.resumeDir && existingState?.mode !== (options.collectOnly ? "collect" : undefined))
      throw new Error("Run mode differs; resume using the original collect/run command");
    if (
      options.resumeDir &&
      existingState?.status === "running" &&
      processIsAlive(existingState.pid)
    ) {
      throw new Error(
        `Cannot resume ${runDir}: run-state.json belongs to active process ${existingState.pid}`,
      );
    }
    if (!specs.length) {
      throw new Error(`Split ${selectedSplit} selects no rubric items in the selected areas`);
    }
    const { priorIndex, sealedPaths, prefixIsFullySealed, reportIsSealed } = recoverRunArtifacts(
      runDir,
      specs,
      existingState,
    );
    const reportFile = path.join(runDir, "report.json");
    const hashes = specHashes(sourceSpecs);
    const receipts = new RunReceipts(
      {
        config,
        specs: sourceSpecs,
        fixtures,
        ...(options.scenarioIds === undefined ? {} : { scenarioIds: options.scenarioIds }),
        split: selectedSplit,
        ...(options.ignoredTargetPaths === undefined
          ? {}
          : { ignoredTargetPaths: options.ignoredTargetPaths }),
        ...(options.collectOnly === undefined ? {} : { collectionOnly: options.collectOnly }),
      },
      runDir,
    );
    if (existingState) {
      if (existingState.inputFingerprint !== receipts.current.inputFingerprint) {
        throw new Error(
          "Configuration, fixtures, provider method, selected inputs, or target revision changed since this run began. Start a new run instead.",
        );
      }
      for (const [id, hash] of Object.entries(existingState.specHashes)) {
        if (hashes[id] && hashes[id] !== hash) {
          throw new Error(
            `Spec ${id} changed since this run began. Start a new run, or use rescore intentionally.`,
          );
        }
      }
    } else {
      snapshotEvaluationInputs(
        config,
        sourceSpecs,
        runDir,
        selectedSplit,
        receipts.current,
        options.scenarioIds,
      );
    }
    const state: RunState = existingState ?? {
      schemaVersion: 1,
      ...(options.collectOnly ? { mode: "collect" as const } : {}),
      status: "running",
      runId: path.basename(runDir),
      pid: process.pid,
      configFile: path.resolve(options.configFile),
      startedAt: new Date().toISOString(),
      selectedAreas: sourceSpecs.map((spec) => spec.id),
      ...(options.scenarioIds === undefined ? {} : { selectedScenarios: options.scenarioIds }),
      selectedSplit,
      specHashes: hashes,
      inputFingerprint: receipts.current.inputFingerprint,
      ...(options.configOverrides === undefined
        ? {}
        : { configOverrides: options.configOverrides }),
    };
    state.schemaVersion = 1;
    state.inputFingerprint = receipts.current.inputFingerprint;
    if (options.configOverrides !== undefined) state.configOverrides = options.configOverrides;
    state.status = "running";
    state.pid = process.pid;
    delete state.lastError;
    writeJson(stateFile, state);
    writeJson(path.join(runDir, "receipt.json"), receipts.current);

    const logger = new RunLogger(path.join(runDir, "run.log"));
    const priorReport = reportIsSealed ? loadResumableRunReport(reportFile).report : undefined;
    const reusePriorEvidence =
      !priorReport ||
      stableJson(priorReport.receipt.target) === stableJson(receipts.current.target);
    const hasReusableScenarioEvidence = specs.some((spec) =>
      spec.scenarios.some((scenario) => {
        const relative = `${scenario.id}/evidence.json`;
        if (!sealedPaths.has(relative) || !prefixIsFullySealed(`${scenario.id}/`)) return false;
        const evidence = JSON.parse(
          fs.readFileSync(path.join(runDir, relative), "utf8"),
        ) as ScenarioEvidence;
        return evidence.outcome === "completed" || evidence.outcome === "feature_not_found";
      }),
    );
    const priorAreas = new Map(
      (reusePriorEvidence ? (priorReport?.areas ?? []) : []).map((area) => [area.id, area]),
    );
    const areaResults: AreaResult[] = [];
    let lifecycle: Awaited<ReturnType<typeof startLifecycle>> | undefined;

    const persist = () => {
      const report = buildReport({
        runId: state.runId,
        startedAt: state.startedAt,
        config,
        areas: areaResults,
        receipt: receipts.current,
      });
      writeReportArtifacts(runDir, report, specs);
      return report;
    };

    try {
      logger.line(
        `${options.resumeDir ? "Resuming" : "Starting"} ${config.project.name} in ${runDir}`,
      );
      logger.line(
        `Agent ${config.agent.provider}${config.agent.model ? `/${config.agent.model}` : ""}; judge ${config.judge.provider}${config.judge.model ? `/${config.judge.model}` : ""}`,
      );
      if (priorReport && !reusePriorEvidence) {
        logger.line(
          "Prior evidence targets an earlier canonical target revision; rerunning it on the recovered revision",
        );
      }
      const refreshTargetReceipt = (phase: string) =>
        receipts.refresh(
          phase,
          state,
          Boolean(reusePriorEvidence && (priorReport?.areas.length || hasReusableScenarioEvidence)),
        );
      lifecycle = await startLifecycle(config, runDir, {
        skipSetup: Boolean(
          priorIndex &&
            sealedPaths.has("lifecycle/setup.json") &&
            readSetupRecord(path.join(runDir, "lifecycle", "setup.json")).status === "complete",
        ),
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
      const allEvidence = new Map<string, ScenarioEvidence>();
      const reusedScenarios = new Set<string>();
      const scenarioOwners = new Map(
        specs.flatMap((spec) =>
          spec.scenarios.map((scenario) => [scenario.id, { spec, scenario }] as const),
        ),
      );
      const scenarioDeclarations = new Map(
        [...scenarioOwners].map(([id, owner]) => [id, owner.scenario]),
      );
      async function collectScenario(id: string): Promise<ScenarioEvidence> {
        const cached = allEvidence.get(id);
        if (cached) return cached;
        const { spec, scenario } = scenarioOwners.get(id)!;
        const selectedScenarioIds = spec.scenarios
          .filter(
            (candidate) =>
              !options.scenarioIds?.length ||
              options.scenarioIds.includes(candidate.id) ||
              Boolean(
                candidate.sourceScenarioId &&
                  options.scenarioIds.includes(candidate.sourceScenarioId),
              ),
          )
          .map((candidate) => candidate.id);
        lifecycle!.assertRunning();
        const scenarioDir = path.join(runDir, scenario.id);
        const evidenceFile = path.join(scenarioDir, "evidence.json");
        const evidenceRelative = `${scenario.id}/evidence.json`;
        const evidenceIsSealed =
          reusePriorEvidence &&
          sealedPaths.has(evidenceRelative) &&
          prefixIsFullySealed(`${scenario.id}/`) &&
          fs.existsSync(evidenceFile);
        if (!evidenceIsSealed && fs.existsSync(scenarioDir)) {
          // An interrupted provider may have left a plausible-looking but
          // unsealed evidence file and partial transcripts. Never reuse or
          // preserve those as completed evidence.
          fs.rmSync(scenarioDir, { recursive: true, force: true });
        }
        if (!selectedScenarioIds.includes(scenario.id)) {
          const skipped = evidenceIsSealed
            ? (JSON.parse(fs.readFileSync(evidenceFile, "utf8")) as ScenarioEvidence)
            : skippedEvidence(spec, scenario.id, config);
          if (evidenceIsSealed) reusedScenarios.add(scenario.id);
          else {
            fs.mkdirSync(scenarioDir, { recursive: true });
            writeJson(evidenceFile, skipped);
          }
          allEvidence.set(scenario.id, skipped);
          return skipped;
        }
        for (const dependency of scenario.dependsOn) await collectScenario(dependency);
        const unmet = scenario.dependsOn
          .map((id) => {
            const evidence = allEvidence.get(id);
            return { id, ...(evidence === undefined ? {} : { evidence }) };
          })
          .filter((item) => item.evidence?.outcome !== "completed");
        const dependencyEvidence = Object.fromEntries(
          scenario.dependsOn.map((id) => [id, sha256(stableJson(allEvidence.get(id)!))]),
        );
        const inputs = unmet.length ? {} : bindInputs(scenario, allEvidence, scenarioDeclarations);
        if (evidenceIsSealed && scenario.dependsOn.every((id) => reusedScenarios.has(id))) {
          const priorEvidence = JSON.parse(
            fs.readFileSync(evidenceFile, "utf8"),
          ) as ScenarioEvidence;
          if (priorEvidence.outcome !== "agent_error")
            assertSavedWorkflowEvidence(scenario, priorEvidence);
          if (
            priorEvidence.outcome !== "agent_error" &&
            stableJson(priorEvidence.dependencyEvidence ?? {}) === stableJson(dependencyEvidence) &&
            stableJson(priorEvidence.inputs ?? {}) === stableJson(inputs)
          ) {
            logger.line(`  = ${scenario.id}: reusing ${priorEvidence.outcome}`);
            reusedScenarios.add(scenario.id);
            allEvidence.set(scenario.id, priorEvidence);
            return priorEvidence;
          }
        }
        if (unmet.length) {
          fs.rmSync(scenarioDir, { recursive: true, force: true });
          const blocked = dependencyBlockedEvidence(spec, scenario.id, unmet, config);
          blocked.dependencyEvidence = dependencyEvidence;
          fs.mkdirSync(scenarioDir, { recursive: true });
          writeJson(evidenceFile, blocked);
          logger.line(`  ~ ${scenario.id}: blocked by ${unmet.map((item) => item.id).join(", ")}`);
          allEvidence.set(scenario.id, blocked);
          return blocked;
        }
        if (fs.existsSync(scenarioDir)) fs.rmSync(scenarioDir, { recursive: true, force: true });
        logger.line(`  > ${scenario.id}: ${scenario.name}`);
        const result = await executeScenario({
          config,
          spec,
          scenario,
          fixtures,
          inputs,
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
        lifecycle!.assertRunning();
        logger.line(
          `    ${result.outcome} in ${(result.durationMs / 1000).toFixed(1)}s; ${result.screenshots.length} screenshots`,
        );
        result.dependencyEvidence = dependencyEvidence;
        writeJson(evidenceFile, result);
        allEvidence.set(scenario.id, result);
        writeArtifactIndex(runDir);
        return result;
      }
      for (const spec of specs) {
        // Prerequisite-only areas are collected recursively by scored scenarios.
        if (!spec.rubric.length) {
          if (spec.exclusions?.length && !options.collectOnly)
            areaResults.push(scoreArea({ spec, config, evidence: [], judgements: [] }));
          continue;
        }
        logger.line(`Area ${spec.id}: ${spec.title}`);
        throwIfCancelled();
        const selectedScenarioIds = spec.scenarios
          .filter(
            (scenario) =>
              !options.scenarioIds?.length ||
              options.scenarioIds.includes(scenario.id) ||
              Boolean(
                scenario.sourceScenarioId &&
                  options.scenarioIds.includes(scenario.sourceScenarioId),
              ),
          )
          .map((scenario) => scenario.id);
        const prior = priorAreas.get(spec.id);
        const evidence: ScenarioEvidence[] = [];
        for (const scenario of spec.scenarios) evidence.push(await collectScenario(scenario.id));
        const reusableArea =
          prior &&
          prefixIsFullySealed(`areas/${spec.id}/`) &&
          selectedScenarioIds.every((id) => reusedScenarios.has(id)) &&
          stableJson(prior.scenarios) === stableJson(evidence);
        if (reusableArea) {
          logger.line(
            `  = reusing completed area (${prior.scorePct ?? "n/a"}% / ${prior.coveragePct}% coverage)`,
          );
          areaResults.push(prior);
          continue;
        }

        lifecycle!.assertRunning();
        // Text inputs are collected directly, without scenario evidence. Seal
        // them and completed setup before the first vote so a failed judge call
        // can resume with intact inputs without repeating successful setup.
        if (evidence.length || spec.rubric.some((item) => item.grader.type === "text-pairwise"))
          writeArtifactIndex(runDir);
        if (options.collectOnly) {
          const commands: JudgedItem[] = [];
          const commandFile = path.join(runDir, "areas", spec.id, "collected-commands.json");
          const commandRelative = `areas/${spec.id}/collected-commands.json`;
          if (
            spec.scenarios.every((scenario) => reusedScenarios.has(scenario.id)) &&
            reusePriorEvidence &&
            sealedPaths.has(commandRelative) &&
            prefixIsFullySealed(`areas/${spec.id}/`)
          ) {
            // Completed checks belong to this collected target revision.
            continue;
          }
          for (const item of spec.rubric.filter((item) => item.grader.type === "command")) {
            try {
              commands.push(
                await runCommandGrader({
                  item,
                  config,
                  runDir,
                  directory: path.join(runDir, "areas", spec.id, "graders"),
                }),
              );
            } finally {
              refreshTargetReceipt(`command grader ${item.id}`);
            }
          }
          writeJson(commandFile, commands);
          writeArtifactIndex(runDir);
          continue;
        }
        const judged = await judgeArea({
          commands: { mode: "execute" },
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
        lifecycle!.assertRunning();
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
        logger.line(
          `  score ${area.scorePct ?? "n/a"}% / ${area.coveragePct}% coverage; ${area.pendingManual.length} manual`,
        );
        persist();
      }

      for (const prior of priorAreas.values()) {
        if (!areaResults.some((area) => area.id === prior.id)) areaResults.push(prior);
      }
      areaResults.sort((left, right) => left.id.localeCompare(right.id));
      // Lifecycle logs are retained evidence. Stop the target before the final
      // report writes its artifact index so shutdown output cannot invalidate a
      // run immediately after it completes.
      lifecycle!.assertRunning();
      await lifecycle.stop();
      lifecycle = undefined;
      throwIfCancelled();
      if (options.collectOnly) {
        for (const spec of specs.filter((spec) => !spec.rubric.length)) {
          for (const scenario of spec.scenarios) {
            if (allEvidence.has(scenario.id)) continue;
            const evidence = skippedEvidence(spec, scenario.id, config);
            evidence.summary =
              "NOT RUN — no selected scoring scenario required this prerequisite. No evidence was gathered.";
            writeJson(path.join(runDir, scenario.id, "evidence.json"), evidence);
          }
          writeJson(path.join(runDir, "areas", spec.id, "collected-commands.json"), []);
        }
        sealCollection(runDir, config, sourceSpecs, selectedSplit, options.scenarioIds);
        state.status = "complete";
        writeJson(stateFile, state);
        logger.line(`Sealed evidence: ${runDir}; judge with aek judge --evidence ${runDir}`);
        return { runDir };
      }
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
      logger.line(`Resume with: aek ${options.collectOnly ? "collect" : "run"} --resume ${runDir}`);
      throw error;
    } finally {
      await lifecycle?.stop();
      await logger.close();
    }
  });
}
