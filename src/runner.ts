import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadResumableRunReport } from "./compare.js";
import { redactConfig } from "./config.js";
import type { ConfigOverrides } from "./config.js";
import { judgeArea } from "./graders.js";
import { assertArtifactIntegrity } from "./integrity.js";
import { createTimestampedDirectory, safeName, sha256, stableJson, writeJson } from "./io.js";
import { startLifecycle } from "./lifecycle.js";
import { RunLogger } from "./log.js";
import { writeReportArtifacts } from "./report.js";
import { buildRunReceipt } from "./receipts.js";
import { executeScenario } from "./scenario.js";
import { throwIfCancelled } from "./cancellation.js";
import { assertEvaluationPlatform } from "./platform.js";
import { buildReport, scoreArea } from "./scoring.js";
import { assertScenarioSelectors, assertScenarioTargetCompatibility, materializeSpecs } from "./specs.js";
import type { AreaResult, EvalConfig, EvalSpec, EvalSplit, RunReport, ScenarioEvidence } from "./types.js";

export interface RunState {
  schemaVersion: 1;
  status: "running" | "complete" | "failed";
  runId: string;
  pid: number;
  configFile: string;
  startedAt: string;
  selectedAreas: string[];
  selectedScenarios?: string[];
  selectedSplit?: EvalSplit | "all";
  specHashes: Record<string, string>;
  inputFingerprint: string;
  configOverrides?: ConfigOverrides;
  lastError?: string;
}

const runStateSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["running", "complete", "failed"]),
  runId: z.string().min(1),
  pid: z.number().int().nonnegative(),
  configFile: z.string().min(1),
  startedAt: z.string().min(1),
  selectedAreas: z.array(z.string().min(1)),
  selectedScenarios: z.array(z.string().min(1)).optional(),
  selectedSplit: z.enum(["development", "evaluation", "all"]).optional(),
  specHashes: z.record(z.string(), z.string()),
  inputFingerprint: z.string().min(1),
  configOverrides: z.object({
    targetUrl: z.string().optional(),
    agentProvider: z.enum(["codex", "claude", "grok", "mock"]).optional(),
    judgeProvider: z.enum(["codex", "claude", "grok", "mock"]).optional(),
    agentModel: z.string().optional(),
    judgeModel: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    headed: z.boolean().optional(),
  }).strict().optional(),
  lastError: z.string().optional(),
}).strict();

export function loadRunState(runDir: string): RunState {
  const file = path.join(path.resolve(runDir), "run-state.json");
  if (!fs.existsSync(file)) throw new Error(`Run state does not exist: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid run state ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = runStateSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid run state ${file}: ${z.prettifyError(result.error)}`);
  if (result.data.runId !== path.basename(path.resolve(runDir))) {
    throw new Error(`Invalid run state ${file}: runId does not match its directory`);
  }
  return result.data;
}

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

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireRunLock(runDir: string): () => void {
  const file = path.join(runDir, ".run.lock");
  const token = crypto.randomUUID();
  for (;;) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown };
      try {
        owner = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
      } catch {
        throw new Error(`Run lock is unreadable: ${file}. Refusing to modify a possibly active run.`);
      }
      if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
        throw new Error(`Run lock has no valid owner PID: ${file}. Refusing to modify a possibly active run.`);
      }
      if (processIsAlive(owner.pid)) {
        throw new Error(`Run is locked by active process ${owner.pid}: ${runDir}`);
      }
      try {
        fs.unlinkSync(file);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`);
    } catch (error) {
      fs.closeSync(descriptor);
      fs.unlinkSync(file);
      throw error;
    }
    fs.closeSync(descriptor);
    return () => {
      let active: { token?: unknown };
      try {
        active = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
      } catch {
        throw new Error(`Run lock disappeared or became unreadable while evaluating: ${file}`);
      }
      if (active.token !== token) {
        throw new Error(`Run lock ownership changed while evaluating: ${file}`);
      }
      fs.unlinkSync(file);
    };
  }
}

export async function withRunLock<T>(runDir: string, action: () => T | Promise<T>): Promise<T> {
  const release = acquireRunLock(path.resolve(runDir));
  try {
    return await action();
  } finally {
    release();
  }
}

function specHashes(specs: EvalSpec[]): Record<string, string> {
  return Object.fromEntries(
    specs.map((spec) => [spec.id, sha256(fs.readFileSync(spec.sourceFile))]),
  );
}

function indexedFileMatches(runDir: string, entry: { path: string; bytes: number; sha256: string }): boolean {
  const file = path.join(runDir, ...entry.path.split("/"));
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const bytes = fs.readFileSync(file);
  return bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
}

function removeUnsealedFiles(runDir: string, relativeRoot: string, sealedPaths: Set<string>): void {
  const absoluteRoot = path.join(runDir, ...relativeRoot.replace(/\/$/, "").split("/"));
  if (!fs.existsSync(absoluteRoot)) return;
  if (fs.lstatSync(absoluteRoot).isSymbolicLink()) {
    fs.rmSync(absoluteRoot, { force: true });
    return;
  }
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runDir, absolute).split(path.sep).join("/");
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
        if (fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
      } else if (!sealedPaths.has(relative)) {
        fs.rmSync(absolute, { recursive: true, force: true });
      }
    }
  };
  visit(absoluteRoot);
}

function snapshotInputs(runDir: string, config: EvalConfig, specs: EvalSpec[], fixturesFile?: string): void {
  const inputDir = path.join(runDir, "inputs");
  fs.mkdirSync(path.join(inputDir, "specs"), { recursive: true });
  const safeConfig = redactConfig(config);
  fs.writeFileSync(path.join(inputDir, "config.resolved.yaml"), YAML.stringify(safeConfig));
  for (const spec of specs) {
    fs.copyFileSync(spec.sourceFile, path.join(inputDir, "specs", path.basename(spec.sourceFile)));
  }
  if (fixturesFile && fs.existsSync(fixturesFile)) {
    fs.copyFileSync(fixturesFile, path.join(inputDir, `fixtures${path.extname(fixturesFile) || ".json"}`));
  }
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
  const releaseRunLock = acquireRunLock(runDir);
  try {
  const existingState = fs.existsSync(stateFile) ? loadRunState(runDir) : undefined;
  if (options.resumeDir && existingState?.status === "running" && processIsAlive(existingState.pid)) {
    throw new Error(`Cannot resume ${runDir}: run-state.json belongs to active process ${existingState.pid}`);
  }
  if (!specs.length) {
    throw new Error(`Split ${selectedSplit} selects no rubric items in the selected areas`);
  }
  // A process may have stopped midway through a scenario after writing new,
  // not-yet-indexed diagnostics. Verify every previously sealed artifact while
  // allowing those crash-recovery files to be replaced or sealed on resume.
  const recoverablePrefixes = [
    "lifecycle/",
    ...specs.flatMap((spec) => [
      `areas/${spec.id}/`,
      `.state/${safeName(spec.id)}/`,
      ...spec.scenarios.map((scenario) => `${scenario.id}/`),
    ]),
  ];
  const priorIndex = existingState
      ? assertArtifactIntegrity(runDir, {
        allowUnindexed: (relative) => recoverablePrefixes.some((prefix) => relative.startsWith(prefix)),
        // A target mutation is sealed into run-state.json and receipt.json
        // before the next report/index transaction. If execution stops in
        // that window, the canonical receipt is expected to differ from the
        // last index and will be recomputed below before it is trusted.
        allowChangedRoles: existingState.status === "complete" ? [] : ["evidence", "judgement", "report", "receipt"],
      })
    : undefined;
  const sealedPaths = new Set(priorIndex?.entries.filter((entry) => indexedFileMatches(runDir, entry)).map((entry) => entry.path) ?? []);
  for (const prefix of recoverablePrefixes) removeUnsealedFiles(runDir, prefix, sealedPaths);
  const prefixIsFullySealed = (prefix: string) => {
    if (!priorIndex) return false;
    const entries = priorIndex.entries.filter((entry) => entry.path.startsWith(prefix));
    return entries.every((entry) => sealedPaths.has(entry.path));
  };
  const reportEntry = priorIndex?.entries.find((entry) => entry.path === "report.json");
  const reportFile = path.join(runDir, "report.json");
  const reportIsSealed = Boolean(reportEntry && fs.existsSync(reportFile) && (() => {
    const bytes = fs.readFileSync(reportFile);
    return bytes.length === reportEntry.bytes && sha256(bytes) === reportEntry.sha256;
  })());
  const hashes = specHashes(sourceSpecs);
  const currentReceipt = () => buildRunReceipt({
    config,
    specs: sourceSpecs,
    fixtures,
    scenarioIds: options.scenarioIds,
    split: selectedSplit,
    ignoredTargetPaths: options.ignoredTargetPaths,
  });
  let receipt = currentReceipt();
  if (existingState) {
    if (existingState.inputFingerprint !== receipt.inputFingerprint) {
      throw new Error("Configuration, fixtures, provider method, selected inputs, or target revision changed since this run began. Start a new run instead.");
    }
    for (const [id, hash] of Object.entries(existingState.specHashes)) {
      if (hashes[id] && hashes[id] !== hash) {
        throw new Error(`Spec ${id} changed since this run began. Start a new run, or use rescore intentionally.`);
      }
    }
  } else {
    snapshotInputs(runDir, config, sourceSpecs, config.paths.fixtures);
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
    inputFingerprint: receipt.inputFingerprint,
    configOverrides: options.configOverrides,
  };
  state.schemaVersion = 1;
  state.inputFingerprint = receipt.inputFingerprint;
  state.configOverrides = options.configOverrides ?? state.configOverrides;
  state.status = "running";
  state.pid = process.pid;
  delete state.lastError;
  writeJson(stateFile, state);
  writeJson(path.join(runDir, "receipt.json"), receipt);

  const logger = new RunLogger(path.join(runDir, "run.log"));
  const priorReport = reportIsSealed
    ? loadResumableRunReport(reportFile).report
    : undefined;
  let reusePriorEvidence = !priorReport || stableJson(priorReport.receipt.target) === stableJson(receipt.target);
  const priorAreas = new Map((reusePriorEvidence ? priorReport?.areas ?? [] : []).map((area) => [area.id, area]));
  const areaResults: AreaResult[] = [];
  let lifecycle;

  const persist = () => {
    const report = buildReport({ runId: state.runId, startedAt: state.startedAt, config, areas: areaResults, receipt });
    writeReportArtifacts(runDir, report, specs);
    return report;
  };

  try {
    logger.line(`${options.resumeDir ? "Resuming" : "Starting"} ${config.project.name} in ${runDir}`);
    logger.line(`Agent ${config.agent.provider}${config.agent.model ? `/${config.agent.model}` : ""}; judge ${config.judge.provider}${config.judge.model ? `/${config.judge.model}` : ""}`);
    if (priorReport && !reusePriorEvidence) {
      logger.line("Prior evidence targets an earlier canonical target revision; rerunning it on the recovered revision");
    }
    const refreshTargetReceipt = (phase: string) => {
      const refreshed = currentReceipt();
      if (refreshed.evaluationFingerprint !== receipt.evaluationFingerprint) {
        throw new Error(`Target ${phase} changed evaluator specs or fixtures; target commands may modify target files only`);
      }
      if (
        reusePriorEvidence &&
        priorReport?.areas.length &&
        stableJson(refreshed.target) !== stableJson(receipt.target)
      ) {
        throw new Error(
          `Target ${phase} changed the target revision while prior evidence was eligible for reuse. Start a new run instead of binding that evidence to a different target.`,
        );
      }
      receipt = refreshed;
      state.inputFingerprint = receipt.inputFingerprint;
      writeJson(stateFile, state);
      writeJson(path.join(runDir, "receipt.json"), receipt);
    };
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
        lifecycle.assertRunning();
        logger.line(`    ${result.outcome} in ${(result.durationMs / 1000).toFixed(1)}s; ${result.screenshots.length} screenshots`);
        evidence.push(result);
      }

      lifecycle.assertRunning();
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
  } finally {
    releaseRunLock();
  }
}
