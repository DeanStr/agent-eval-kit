import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  compareCampaigns,
  campaignComparisonFailures,
  loadCampaign,
  writeCampaignComparisonArtifacts,
} from "../campaign-compare.js";
import { loadCampaignState, runCampaign } from "../campaign-run.js";
import { campaignRunRecord, type CampaignReport } from "../campaign.js";
import { cancellationSignal, CliInterruptionError, withCancellation } from "../cancellation.js";
import { shellQuote } from "../cli-recovery.js";
import { collectorInputs } from "../collectors/inputs.js";
import {
  compareReports,
  comparisonFailures,
  loadComparisonInput,
  writeComparisonArtifacts,
} from "../compare.js";
import { loadConfig } from "../config.js";
import { assertArtifactIntegrity } from "../integrity.js";
import { isWithin, prospectiveRealPath, sha256, stableJson, writeJson } from "../io.js";
import { evaluateSuiteCompleteness } from "../promotion.js";
import {
  withProcessRegistry,
  drainProcessRegistry,
  runningProcessGroups,
} from "../process-registry.js";
import { runEvaluation } from "../runner.js";
import { assertEvaluationPlatform } from "../platform.js";
import { evaluatorInputPaths } from "../run/inputs.js";
import { loadRunState, withRunLock } from "../run/state.js";
import { loadFixtures, loadSpecs } from "../specs.js";
import {
  aggregateAreaMeasurements,
  belowPercentageThreshold,
  scoreRatios,
} from "../score-slice.js";
import type { RunReport } from "../types.js";
import {
  sessionSchema,
  startSchema,
  type Attempt,
  type Session,
  type StartOptions,
  type StopReason,
  type ImprovementSessionContext,
} from "./contracts.js";
import { assertClean, assertNoSubmodules, checkpoint, git, restore, workingTree } from "./git.js";
import {
  caseRegressionFailures,
  gatePassRateFailures,
  reproducedRegressionFailures,
} from "./cases.js";

/** Only failures raised while executing a candidate, after invariant validation. */
class CandidateExecutionError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "CandidateExecutionError";
  }
}

class EvaluationCleanupError extends Error {}

/** The session deadline is a valid stop, distinct from candidate or evaluator failures. */
class BudgetExhaustedError extends Error {
  constructor() {
    super("Improvement time budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

/** Carries the final persisted state without another workspace or artifact read. */
export class ImprovementSessionError extends Error {
  readonly session: ImprovementSessionContext;

  constructor(error: unknown, state: Session) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "ImprovementSessionError";
    this.session = {
      status: state.status,
      stopReason: state.stopReason ?? null,
      attemptStatus: state.attempts.at(-1)?.status ?? null,
    };
  }
}

const stateFile = (directory: string) => path.join(directory, "session.json");
const workspace = (directory: string) => path.join(directory, "workspace");
const ref = (state: Session, name: string) => `refs/aek/improvements/${state.id}/${name}`;
const save = (directory: string, state: Session) =>
  writeJson(stateFile(directory), sessionSchema.parse(state));

function ownedWorkspace(directory: string, state: Session): string {
  const root = workspace(directory);
  if (!fs.existsSync(root))
    throw new Error(
      `Improvement workspace is missing: ${root}. A removed workspace cannot be inspected or restored; its run evidence remains in the session directory.`,
    );
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root)
    throw new Error("Improvement workspace moved or became a symlink; refusing to modify it");
  if (
    git(root, ["rev-parse", "--show-toplevel"]) !== root ||
    git(root, ["rev-parse", "--absolute-git-dir"]) !== state.workspaceGitDir ||
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== state.gitCommonDir ||
    git(root, ["rev-parse", ref(state, "initial")]) !== state.initial
  )
    throw new Error("Improvement workspace ownership changed; refusing to modify it");
  return root;
}

function assertDetached(root: string): void {
  if (git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "HEAD")
    throw new Error(
      "Improvement workspace must remain detached; do not switch branches or commit inside it",
    );
}

function restoreBest(directory: string, state: Session, commit: string): void {
  const root = ownedWorkspace(directory, state);
  assertDetached(root);
  restore(root, commit);
}

function load(directory: string): Session {
  return sessionSchema.parse(JSON.parse(fs.readFileSync(stateFile(directory), "utf8")));
}

function sessionDirectory(input: string): string {
  const directory = path.resolve(input);
  if (!fs.existsSync(stateFile(directory)))
    throw new Error(
      `Not an improvement session: ${directory} has no session.json. Pass the --output directory created by aek improve start.`,
    );
  return fs.realpathSync(directory);
}

function configuration(directory: string, state: Pick<Session, "config" | "suite">) {
  const root = workspace(directory);
  const file = path.join(root, state.config);
  const config = loadConfig(file, state.suite ? { suite: state.suite } : {});
  if (config.project.root !== root)
    throw new Error(
      "Improvement requires project.root to be the Git root, using portable relative configuration paths",
    );
  for (const location of [
    config.paths.specs,
    config.paths.auth,
    config.paths.references,
    config.paths.fixtures,
    config.paths.baselines,
    config.target.setup?.cwd,
    config.target.start?.cwd,
  ]) {
    if (location && !isWithin(root, prospectiveRealPath(location)))
      throw new Error(`Improvement configuration path escapes its workspace: ${location}`);
  }
  if (config.target.kind === "web" && (!config.target.start || config.target.allowExternalServer))
    throw new Error(
      "Improvement web evaluations require target.start and must not allow an external server; evaluations must exercise this candidate",
    );
  config.paths.runs = path.join(directory, "runs");
  const specs = loadSpecs(config.paths.specs);
  for (const spec of specs) {
    for (const item of spec.rubric) {
      if (["manual", "hybrid"].includes(item.grader.type))
        throw new Error(
          "Improvement acceptance requires automatic graders; finalize human requirements before starting or use a separate workflow",
        );
      if (item.grader.type === "command" && !item.grader.methodFiles.length)
        throw new Error(
          `Declare methodFiles for command grader ${item.id} so the acceptance method can be frozen`,
        );
      if (
        item.grader.type === "command" &&
        item.grader.cwd &&
        item.grader.cwd !== "run" &&
        !isWithin(
          root,
          prospectiveRealPath(
            path.resolve(root, item.grader.cwd === "project" ? "." : item.grader.cwd),
          ),
        )
      )
        throw new Error(`Command grader ${item.id} cwd escapes the candidate workspace`);
    }
    for (const scenario of spec.scenarios)
      if (scenario.collect && !scenario.collect.methodFiles.length)
        throw new Error(
          `Declare methodFiles for collector ${scenario.id} so the acceptance method can be frozen`,
        );
  }
  return {
    configFile: file,
    config,
    specs,
    fixtures: loadFixtures(config.paths.fixtures),
    split: "all" as const,
  };
}

function pinnedInputs(
  directory: string,
  state: Pick<Session, "config" | "suite">,
): Record<string, string> {
  const root = workspace(directory);
  const options = configuration(directory, state);
  const fixtureFiles = (options.fixtures as { files?: Record<string, string> }).files ?? {};
  const files = new Set([
    options.configFile,
    ...options.specs.map((spec) => spec.sourceFile),
    ...evaluatorInputPaths(options.config, options.specs, "all"),
    ...Object.values(
      collectorInputs(options.config, options.specs, "all", undefined, "methods"),
    ).map((v) => v.file),
    ...(options.config.paths.fixtures
      ? [
          options.config.paths.fixtures,
          ...Object.values(fixtureFiles).map((v) =>
            path.resolve(path.dirname(options.config.paths.fixtures!), v),
          ),
        ]
      : []),
    ...git(root, ["ls-files", "-z"])
      .split("\0")
      .filter((file) => [".gitignore", ".gitattributes"].includes(path.basename(file)))
      .map((file) => path.join(root, file)),
  ]);
  const result: Record<string, string> = {};
  for (const file of files) {
    if (
      !isWithin(root, fs.realpathSync(file)) ||
      fs.lstatSync(file).isSymbolicLink() ||
      !fs.statSync(file).isFile()
    )
      throw new Error(`Evaluation inputs must be regular files inside the worktree: ${file}`);
    const relative = path.relative(root, file);
    git(root, ["ls-files", "--error-unmatch", "--", relative]);
    result[relative] = sha256(fs.readFileSync(file));
  }
  return result;
}

function assertPinned(directory: string, state: Session): void {
  for (const [file, hash] of Object.entries(state.pinnedFiles)) {
    const absolute = path.join(workspace(directory), file);
    if (
      !fs.existsSync(absolute) ||
      fs.lstatSync(absolute).isSymbolicLink() ||
      !fs.statSync(absolute).isFile() ||
      sha256(fs.readFileSync(absolute)) !== hash
    )
      throw new Error(
        `Frozen evaluation input changed: ${file}. Start a new session to change the evaluator.`,
      );
  }
  if (stableJson(pinnedInputs(directory, state)) !== stableJson(state.pinnedFiles))
    throw new Error(
      "The evaluation input inventory changed. Start a new session to change the evaluator.",
    );
}

function readRun(directory: string, run: Reference): RunReport {
  const location = path.join(directory, run.directory);
  if (!isWithin(path.join(directory, "runs"), fs.realpathSync(location)))
    throw new Error("Improvement run escapes its retained run directory");
  if (loadRunState(location).status !== "complete")
    throw new Error("Improvement requires a complete evaluation run");
  assertArtifactIntegrity(location, { require: true });
  if (sha256(fs.readFileSync(path.join(location, "report.json"))) !== run.reportHash)
    throw new Error("Improvement report changed after the decision");
  return loadComparisonInput(location).report;
}

type Reference = NonNullable<Attempt["run"]>;
type CampaignReference = NonNullable<Attempt["campaign"]>;
/** One sealed run, or an n-repetition campaign with each repetition's sealed report. */
type Measurement =
  | { run: Reference; report: RunReport }
  | { campaign: CampaignReference; report: CampaignReport; reports: RunReport[] };

const reference = (measurement: Measurement) =>
  "campaign" in measurement ? { campaign: measurement.campaign } : { run: measurement.run };
const runReports = (measurement: Measurement) =>
  "campaign" in measurement ? measurement.reports : [measurement.report];

function readCampaign(directory: string, campaign: CampaignReference): Measurement {
  const location = path.join(directory, campaign.directory);
  const real = fs.realpathSync(location);
  if (!isWithin(directory, real) || isWithin(workspace(directory), real))
    throw new Error("Improvement campaign escapes its session directory");
  if (sha256(fs.readFileSync(path.join(location, "campaign.json"))) !== campaign.reportHash)
    throw new Error("Improvement campaign changed after the decision");
  const { report } = loadCampaign(location);
  if (
    report.status !== "complete" ||
    report.compatibility.status !== "compatible" ||
    report.coverage.completedRuns !== report.plannedRepetitions
  )
    throw new Error(
      `Improvement requires every repetition to complete with identical evaluation inputs; ${campaign.directory} has ${report.coverage.completedRuns}/${report.plannedRepetitions} complete runs and ${report.compatibility.status} inputs`,
    );
  if (
    campaign.runs.length !== report.plannedRepetitions ||
    campaign.runs.length !== report.runs.length
  )
    throw new Error(
      "Improvement campaign repetition inventory does not match its retained campaign",
    );
  const reports = report.runs.map((record, index) => {
    if (record.status !== "complete") throw new Error("Improvement requires complete repetitions");
    const run = campaign.runs[index]!;
    if (path.resolve(directory, run.directory) !== path.resolve(record.runDir))
      throw new Error(
        `Campaign repetition ${record.ordinal} does not match its retained report reference`,
      );
    const result = readRun(directory, run);
    if (stableJson(campaignRunRecord(record.ordinal, record.runDir, result)) !== stableJson(record))
      throw new Error(`Campaign repetition ${record.ordinal} does not match its retained report`);
    return result;
  });
  return { campaign, report, reports };
}

function readBest(directory: string, best: NonNullable<Session["best"]>): Measurement {
  return "campaign" in best
    ? readCampaign(directory, best.campaign)
    : { run: best.run, report: readRun(directory, best.run) };
}

function stop(state: Session, reason: StopReason): void {
  state.status = "stopped";
  state.stopReason = reason;
}

function insufficientEvidence(report: RunReport): boolean {
  return (
    report.scoreWithheld ||
    report.overallScorePct === null ||
    report.areas.some(
      (area) =>
        area.caseResults.some((item) => item.points === null || item.verdict === "cannot_judge") ||
        (!(area.total === 0 && area.exclusions?.length) &&
          belowPercentageThreshold(scoreRatios(area).coverage * 100, 100)) ||
        area.scenarios.some(
          (scenario) => !["completed", "feature_not_found"].includes(scenario.outcome),
        ),
    )
  );
}

function budgetReason(state: Session): StopReason | undefined {
  if (Date.now() >= Date.parse(state.deadline)) return "budget_exhausted";
  if (state.attempts.length >= state.maxAttempts) return "attempt_limit";
  let stalls = 0;
  for (const attempt of [...state.attempts].reverse()) {
    if (!["rejected", "inconclusive", "execution_error"].includes(attempt.status)) break;
    stalls++;
  }
  return stalls >= state.maxStalls ? "no_improvement" : undefined;
}

function finishAttempt(state: Session): void {
  state.status = "ready";
  const reason = budgetReason(state);
  if (reason) stop(state, reason);
}

function interruptionReason(error: unknown): StopReason {
  if (error instanceof CliInterruptionError) return "user_stopped";
  return error instanceof BudgetExhaustedError ? "budget_exhausted" : "execution_error";
}

function completeAttempt(directory: string, state: Session, attempt: Attempt): void {
  const file = path.join(directory, "attempts", String(attempt.number), "decision.json");
  if (fs.existsSync(file)) throw new Error(`Attempt decision already exists: ${file}`);
  writeJson(file, {
    version: 1,
    ...attempt,
    best: state.best,
    stopReason: state.stopReason ?? null,
  });
  save(directory, state);
}

// A failed run can contain new diagnostics and service shutdown logs. Its
// sealed inputs, reports and evidence must remain intact before more work.
function assertFailedRunIntact(runDir: string): void {
  assertArtifactIntegrity(runDir, {
    allowUnindexed: true,
    allowChangedPaths: ["lifecycle/start.stdout.log", "lifecycle/start.stderr.log"],
  });
}

const campaignDirectory = (directory: string, attempt?: Attempt) =>
  attempt
    ? path.join(directory, "attempts", String(attempt.number), `attempt-${attempt.number}-campaign`)
    : path.join(directory, "baseline-campaign");

async function evaluate(
  directory: string,
  state: Session,
  onProgress: (message: string) => void,
  attempt?: Attempt,
): Promise<Measurement> {
  assertPinned(directory, state);
  const root = workspace(directory);
  const tree = workingTree(root, directory);
  const head = git(root, ["rev-parse", "HEAD"]);
  const remaining = Date.parse(state.deadline) - Date.now();
  if (remaining <= 0) throw new BudgetExhaustedError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BudgetExhaustedError()), remaining);
  const parent = cancellationSignal();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try {
    const options = configuration(directory, state);
    const assertUnchanged = () => {
      ownedWorkspace(directory, state);
      assertDetached(root);
      assertPinned(directory, state);
      if (git(root, ["rev-parse", "HEAD"]) !== head || workingTree(root, directory) !== tree)
        throw new Error(
          "Candidate source changed during evaluation. Keep setup outputs ignored and do not edit while evaluating.",
        );
    };
    const record = (location: string) => {
      if (attempt) {
        attempt.evaluationDirectory = path.relative(directory, location);
        save(directory, state);
      }
    };
    const execute = async () => {
      if (state.repetitions === 1)
        return { single: await runEvaluation({ ...options, onProgress, onRunCreated: record }) };
      const exitCode = process.exitCode;
      const campaign = await runCampaign({
        ...options,
        repetitions: state.repetitions,
        output: campaignDirectory(directory, attempt),
        thresholds: {},
        onProgress,
        onCampaignCreated: record,
      });
      // Campaigns report CI outcomes through the exit code; this decision owns it.
      process.exitCode = exitCode;
      return { campaign };
    };
    let result: Awaited<ReturnType<typeof execute>> | undefined;
    let executionFailure: Error | undefined;
    const processFile = path.join(directory, "process-groups.json");
    try {
      result = await withProcessRegistry(processFile, () => withCancellation(signal, execute));
    } catch (error) {
      executionFailure = error instanceof Error ? error : new Error(String(error));
    }
    try {
      await drainProcessRegistry(processFile);
    } catch (error) {
      throw new EvaluationCleanupError(
        `Evaluation process cleanup failed. Inspect ${processFile} and stop surviving workers before any further Git operation.`,
        { cause: error },
      );
    }
    // Check only after all owned workers have exited, including on failed runs.
    try {
      assertUnchanged();
    } catch (error) {
      if (!executionFailure) throw error;
      const violation = error instanceof Error ? error : new Error(String(error));
      throw new AggregateError(
        [violation, executionFailure],
        `${violation.message}\nEvaluation also failed: ${executionFailure.message}`,
      );
    }
    // Cleanup can cross the deadline after an unrelated execution failure. Only
    // treat failures caused by this signal (including wrapped aborts) as cancellation.
    if (signal.aborted) {
      for (let cause: unknown = executionFailure; cause instanceof Error; cause = cause.cause) {
        if (cause === signal.reason) throw signal.reason;
      }
    }
    if (executionFailure) {
      // A campaign records repetition failures itself; anything it throws is not
      // attributable to one candidate run.
      if (state.repetitions > 1 || !attempt?.evaluationDirectory) throw executionFailure;
      if (state.best) readBest(directory, state.best);
      const failedRun = path.join(directory, attempt.evaluationDirectory);
      if (loadRunState(failedRun).status !== "failed") throw executionFailure;
      assertFailedRunIntact(failedRun);
      throw new CandidateExecutionError(executionFailure);
    }
    signal.throwIfAborted();
    if (result?.campaign) {
      const { campaignDir, campaign } = result.campaign;
      const failed = campaign.runs.filter((run) => run.status === "failed");
      if (failed.length) {
        const failure = new Error(
          failed.map((run) => `Repetition ${run.ordinal} failed: ${run.error}`).join("\n"),
        );
        if (!attempt) throw failure;
        if (state.best) readBest(directory, state.best);
        for (const run of failed) {
          if (!run.runDir || loadRunState(run.runDir).status !== "failed") throw failure;
          assertFailedRunIntact(run.runDir);
        }
        throw new CandidateExecutionError(failure);
      }
      const checkpoint = loadCampaignState(campaignDir);
      if (stableJson(checkpoint.runs) !== stableJson(campaign.runs))
        throw new Error("Improvement campaign checkpoint does not match its retained campaign");
      return readCampaign(directory, {
        directory: path.relative(directory, campaignDir),
        reportHash: sha256(fs.readFileSync(path.join(campaignDir, "campaign.json"))),
        runs: campaign.runs.map((record) => {
          if (record.status !== "complete")
            throw new Error("Improvement requires complete repetitions");
          const index = assertArtifactIntegrity(record.runDir, { require: true })!;
          if (index.rootSha256 !== checkpoint.artifactRoots[String(record.ordinal)])
            throw new Error(
              `Campaign repetition ${record.ordinal} artifacts changed before the decision`,
            );
          return {
            directory: path.relative(directory, record.runDir),
            reportHash: sha256(fs.readFileSync(path.join(record.runDir, "report.json"))),
          };
        }),
      });
    }
    const single = result?.single;
    if (!single?.report) throw new Error("Full evaluation completed without a report");
    const run = {
      directory: path.relative(directory, single.runDir),
      reportHash: sha256(fs.readFileSync(path.join(single.runDir, "report.json"))),
    };
    return { run, report: readRun(directory, run) };
  } finally {
    clearTimeout(timer);
  }
}

/** Creates an isolated candidate checkout. The source checkout and its branch never move. */
export async function startImprovement(
  input: StartOptions,
  onProgress = (_message: string) => {},
): Promise<Session> {
  assertEvaluationPlatform();
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(`Invalid improvement settings:\n${z.prettifyError(parsed.error)}`);
  const options = parsed.data;
  const configFile = fs.realpathSync(path.resolve(options.config));
  const sourceConfig = loadConfig(configFile, options.suite ? { suite: options.suite } : {});
  const source = fs.realpathSync(sourceConfig.project.root);
  if (git(source, ["rev-parse", "--show-toplevel"]) !== source)
    throw new Error("Improvement currently requires project.root to equal the Git repository root");
  if (!isWithin(source, configFile))
    throw new Error("Evaluation config must be tracked inside project.root");
  try {
    git(source, ["ls-files", "--error-unmatch", "--", path.relative(source, configFile)]);
  } catch (error) {
    throw new Error(
      `Evaluation config must be tracked before starting improvement: ${configFile}`,
      { cause: error },
    );
  }
  assertClean(source);
  assertNoSubmodules(source);
  const directory = prospectiveRealPath(options.output);
  if (isWithin(source, directory) || isWithin(directory, source))
    throw new Error("Improvement output must be a new directory outside the source checkout");
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Improvement output already exists: ${directory}. Choose a new --output directory; inspect an existing session with aek improve status --session ${shellQuote(directory)}.`,
    );
  }
  return withRunLock(
    directory,
    async () => {
      const initial = git(source, ["rev-parse", "HEAD"]);
      git(source, ["worktree", "add", "--detach", workspace(directory), initial]);
      const root = workspace(directory);
      const state: Session = {
        version: 2,
        id: crypto.randomUUID(),
        source,
        gitCommonDir: git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        workspaceGitDir: git(root, ["rev-parse", "--absolute-git-dir"]),
        config: path.relative(source, configFile),
        ...(options.suite ? { suite: options.suite } : {}),
        goal: options.goal,
        startedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + options.budgetSeconds * 1000).toISOString(),
        maxAttempts: options.maxAttempts,
        maxStalls: options.maxStalls,
        minimumGain: options.minimumGain,
        repetitions: options.repetitions ?? 1,
        status: "initializing",
        initial,
        pinnedFiles: {},
        attempts: [],
      };
      git(root, ["update-ref", ref(state, "initial"), initial]);
      writeJson(path.join(directory, "process-groups.json"), []);
      save(directory, state);
      onProgress(`Improvement session: ${directory}\nEdit candidates only in: ${root}`);
      try {
        state.pinnedFiles = pinnedInputs(directory, state);
        save(directory, state);
        const measurement = await evaluate(directory, state, onProgress);
        state.best = { checkpoint: initial, ...reference(measurement), accepted: false };
        const reports = runReports(measurement);
        if (state.repetitions > 1) {
          const cases = new Set(
            reports.flatMap((report) =>
              report.areas.flatMap((area) =>
                area.caseResults.map((item) =>
                  JSON.stringify([area.id, item.rubricId, item.caseId]),
                ),
              ),
            ),
          );
          // The paired bootstrap resamples matched cases; it is undefined for fewer than two.
          if (cases.size < 2)
            throw new Error(
              `Repeated-run acceptance needs at least two scored cases for its paired-case interval, but the suite produced ${cases.size}. Cases come from LLM-judged rubric items linked to scenarios, text datasets, and scenario templates; command, capture, and visual checks produce none. Start a new session without --repetitions for single-run acceptance.`,
            );
        }
        if (reports.some(insufficientEvidence)) stop(state, "insufficient_evidence");
        else state.status = "ready";
        save(directory, state);
        return state;
      } catch (error) {
        const reason = interruptionReason(error);
        stop(state, reason);
        const detail = error instanceof Error ? error.message : String(error);
        if (reason === "execution_error") state.error = detail;
        else state.stopDetail = detail;
        save(directory, state);
        if (reason === "budget_exhausted") return state;
        throw new ImprovementSessionError(error, state);
      }
    },
    { recoverStale: false },
  );
}

export async function beginAttempt(directoryInput: string, hypothesis: string): Promise<Session> {
  if (!hypothesis.trim()) throw new Error("An attempt requires a concrete hypothesis");
  const directory = sessionDirectory(directoryInput);
  return withRunLock(
    directory,
    () => {
      const state = load(directory);
      const root = ownedWorkspace(directory, state);
      assertDetached(root);
      if (
        state.status === "stopped" &&
        state.stopReason &&
        state.stopReason !== "execution_error"
      ) {
        if (state.best) readBest(directory, state.best);
        return state;
      }
      if (state.status !== "ready" || !state.best)
        throw new Error(`Cannot begin an attempt while session is ${state.status}`);
      assertClean(root);
      if (git(root, ["rev-parse", "HEAD"]) !== state.best.checkpoint)
        throw new Error("Workspace no longer matches the best checkpoint");
      readBest(directory, state.best);
      assertPinned(directory, state);
      const reason = budgetReason(state);
      if (reason) stop(state, reason);
      else {
        state.attempts.push({
          number: state.attempts.length + 1,
          hypothesis: hypothesis.trim(),
          startedAt: new Date().toISOString(),
          status: "editing",
          reasons: [],
        });
        state.status = "editing";
      }
      save(directory, state);
      return state;
    },
    { recoverStale: false },
  );
}

type SingleRun = Extract<Measurement, { run: Reference }>;
type Campaign = Extract<Measurement, { campaign: CampaignReference }>;
type Decision = Extract<Attempt["status"], "accepted" | "rejected" | "inconclusive">;

const gainFails = (state: Session, gain: number | null) =>
  gain === null || gain <= 0 || belowPercentageThreshold(gain, state.minimumGain);
const gainReason = (state: Session, subject: string, gain: number | null) =>
  `${subject} ${gain ?? "unavailable"} does not meet the required positive improvement${state.minimumGain ? ` of at least ${state.minimumGain} points` : ""}`;

/** Strict single-run acceptance: one baseline run against one candidate run. */
function singleRunDecision(
  directory: string,
  state: Session,
  attempt: Attempt,
  baseline: SingleRun,
  candidate: SingleRun,
  comparisonDir: string,
): Decision {
  const { report } = candidate;
  const comparison = compareReports(baseline.report, report);
  writeComparisonArtifacts(comparisonDir, comparison, {
    baselineFile: path.join(directory, baseline.run.directory, "report.json"),
    candidateFile: path.join(directory, candidate.run.directory, "report.json"),
  });
  attempt.comparison = path.relative(directory, comparisonDir);
  if (comparison.compatibility.status !== "compatible")
    throw new Error(`Evaluator changed: ${comparison.compatibility.differences.join(" ")}`);
  if (insufficientEvidence(report)) {
    attempt.reasons = [
      "The full suite has insufficient evidence; this is not a product quality score.",
    ];
    return "inconclusive";
  }
  attempt.reasons = [
    ...evaluateSuiteCompleteness(configuration(directory, state).config, report, {
      split: "all",
      includeOptional: true,
    }).failures,
    ...comparisonFailures(comparison, { requireCompatible: true, failOnRegression: true }),
    ...caseRegressionFailures(
      baseline.report.areas.flatMap((area) => area.caseResults),
      report.areas.flatMap((area) => area.caseResults),
    ),
  ];
  const before = aggregateAreaMeasurements(baseline.report.areas).scorePct;
  const after = aggregateAreaMeasurements(report.areas).scorePct;
  const gain = before === null || after === null ? null : after - before;
  if (gain !== null) attempt.scoreGain = gain;
  if (gainFails(state, gain)) attempt.reasons.push(gainReason(state, "Score gain", gain));
  return attempt.reasons.length ? "rejected" : "accepted";
}

/** Full-precision mean of the repetitions' headline scores. */
function meanScore(reports: RunReport[]): number | null {
  const scores = reports.map((report) => aggregateAreaMeasurements(report.areas).scorePct);
  if (scores.some((score) => score === null)) return null;
  return scores.reduce<number>((sum, score) => sum + score!, 0) / scores.length;
}

/**
 * Repeated-run acceptance compares n-repetition campaigns. Every aggregate
 * campaign regression, including any critical-gate pass-rate drop, rejects.
 * Per-case mean decreases are not used directly: under noisy judging an
 * unchanged case decreases by chance about half the time. Items and cases
 * reject only when they regressed in every repetition. A sufficient mean gain
 * whose paired-case interval does not exclude zero is inconclusive.
 */
function repeatedRunDecision(
  directory: string,
  state: Session,
  attempt: Attempt,
  baseline: Campaign,
  candidate: Campaign,
  comparisonDir: string,
): Decision {
  const comparison = compareCampaigns(baseline.report, candidate.report);
  writeCampaignComparisonArtifacts(comparisonDir, comparison);
  attempt.comparison = path.relative(directory, comparisonDir);
  if (comparison.compatibility.status !== "compatible")
    throw new Error(`Evaluator changed: ${comparison.compatibility.reasons.join(" ")}`);
  const { reports } = candidate;
  if (reports.some(insufficientEvidence)) {
    attempt.reasons = [
      `At least one of ${reports.length} repetitions has insufficient evidence; this is not a product quality score.`,
    ];
    return "inconclusive";
  }
  const config = configuration(directory, state).config;
  attempt.reasons = [
    ...new Set(
      reports.flatMap(
        (report) =>
          evaluateSuiteCompleteness(config, report, { split: "all", includeOptional: true })
            .failures,
      ),
    ),
    // Mean-level case decreases are replaced by the reproduced-regression rule below.
    ...campaignComparisonFailures(
      { ...comparison, summary: { ...comparison.summary, regressed: 0 } },
      { requireCompatible: true, failOnRegression: true },
    ),
    ...reproducedRegressionFailures(baseline.reports, reports),
    ...gatePassRateFailures(baseline.reports, reports),
  ];
  const before = meanScore(baseline.reports);
  const after = meanScore(reports);
  const gain = before === null || after === null ? null : after - before;
  if (gain !== null) attempt.scoreGain = gain;
  if (gainFails(state, gain))
    attempt.reasons.push(gainReason(state, `Mean score gain over ${reports.length} runs`, gain));
  const interval = comparison.pairedCases.confidenceInterval95;
  if (attempt.reasons.length) return "rejected";
  if (!interval || interval.lower <= 0) {
    attempt.reasons = [
      `Mean score gain ${gain} over ${reports.length} runs is sufficient, but the paired-case 95% bootstrap interval ${interval ? `[${interval.lower}, ${interval.upper}]` : `is unavailable for ${comparison.pairedCases.judgeable} matched case(s)`} does not exclude zero; the improvement is not established.`,
    ];
    return "inconclusive";
  }
  return "accepted";
}

/** Guidance is retained for repair context only. Acceptance uses a new full evaluation. */
export async function evaluateAttempt(
  directoryInput: string,
  guidanceFile?: string,
  onProgress = (_message: string) => {},
): Promise<Session> {
  const directory = sessionDirectory(directoryInput);
  return withRunLock(
    directory,
    async () => {
      const state = load(directory);
      const root = ownedWorkspace(directory, state);
      assertDetached(root);
      const attempt = state.attempts.at(-1);
      if (state.status !== "editing" || !state.best || attempt?.status !== "editing")
        throw new Error(`Cannot evaluate an attempt while session is ${state.status}`);
      if (git(root, ["rev-parse", "HEAD"]) !== state.best.checkpoint)
        throw new Error("Do not commit or change HEAD inside an improvement workspace");
      if (guidanceFile) {
        const bytes = fs.readFileSync(guidanceFile);
        if (bytes.length > 65536) throw new Error("Repair guidance must be at most 64 KiB");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.trim()) throw new Error("Repair guidance must not be empty");
        attempt.guidance = { text, sha256: sha256(bytes) };
      }
      attempt.checkpoint = checkpoint(
        root,
        directory,
        ref(state, `attempt-${attempt.number}`),
        `AEK attempt ${attempt.number}: ${attempt.hypothesis}`,
      );
      attempt.status = "evaluating";
      state.status = "evaluating";
      save(directory, state);
      const previousBest = state.best;
      let failure: Error | undefined;
      try {
        const baseline = readBest(directory, state.best);
        restoreBest(directory, state, attempt.checkpoint);
        const candidate = await evaluate(directory, state, onProgress, attempt);
        Object.assign(attempt, reference(candidate));
        readBest(directory, previousBest);
        const comparisonDir = path.join(
          directory,
          "attempts",
          String(attempt.number),
          "comparison",
        );
        if ("campaign" in baseline && "campaign" in candidate)
          attempt.status = repeatedRunDecision(
            directory,
            state,
            attempt,
            baseline,
            candidate,
            comparisonDir,
          );
        else if ("run" in baseline && "run" in candidate)
          attempt.status = singleRunDecision(
            directory,
            state,
            attempt,
            baseline,
            candidate,
            comparisonDir,
          );
        else throw new Error("Improvement baseline and candidate evaluation modes differ");
        if (attempt.status === "accepted")
          state.best = { checkpoint: attempt.checkpoint, ...reference(candidate), accepted: true };
        finishAttempt(state);
        restoreBest(directory, state, state.best.checkpoint);
      } catch (error) {
        state.best = previousBest;
        const cause = error instanceof Error ? error : new Error(String(error));
        delete attempt.scoreGain;
        attempt.reasons = [cause.message];
        const reason = interruptionReason(error);
        if (reason === "execution_error") {
          // A failed execution remains an error, without a quality score or automatic retry.
          attempt.status = "execution_error";
          failure = cause;
          if (error instanceof CandidateExecutionError) finishAttempt(state);
          else {
            stop(state, reason);
            state.error = cause.message;
          }
        } else {
          // Interruption and budget expiry end the session without judging the candidate.
          attempt.status = "stopped";
          stop(state, reason);
          state.stopDetail = cause.message;
          if (reason === "user_stopped") failure = cause;
        }
        save(directory, state);
        if (!(error instanceof EvaluationCleanupError)) {
          // Preserve writes from a failing checker/setup before restoring the best source.
          try {
            ownedWorkspace(directory, state);
            assertDetached(root);
            attempt.recoveryCheckpoint = checkpoint(
              root,
              directory,
              ref(state, `attempt-${attempt.number}-error`),
              "AEK failed evaluation workspace",
            );
            restoreBest(directory, state, state.best.checkpoint);
          } catch (recoveryError) {
            stop(state, "execution_error");
            state.error = `${cause.message}; automatic restoration failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. Inspect the retained workspace before any further Git operation.`;
            attempt.reasons.push(state.error);
            failure = new Error(state.error, { cause });
          }
        }
      }
      completeAttempt(directory, state, attempt);
      if (failure) throw new ImprovementSessionError(failure, state);
      return state;
    },
    { recoverStale: false },
  );
}

export async function stopImprovement(directoryInput: string, reason: string): Promise<Session> {
  if (!reason.trim()) throw new Error("Stopping requires a reason");
  const directory = sessionDirectory(directoryInput);
  return withRunLock(
    directory,
    () => {
      const state = load(directory);
      const root = ownedWorkspace(directory, state);
      assertDetached(root);
      const attempt = state.attempts.at(-1);
      if (state.status === "stopped") return state;
      if (!state.best)
        throw new Error("Session has no completed baseline; inspect its retained diagnostics");
      const retained = checkpoint(root, directory, ref(state, "stopped"), `AEK stopped: ${reason}`);
      state.stoppedCheckpoint = retained;
      if (attempt && ["editing", "evaluating"].includes(attempt.status)) {
        if (attempt.checkpoint) attempt.recoveryCheckpoint = retained;
        else attempt.checkpoint = retained;
        attempt.status = "stopped";
        attempt.reasons = [reason.trim()];
      }
      restoreBest(directory, state, state.best.checkpoint);
      stop(state, "user_stopped");
      state.stopDetail = reason.trim();
      if (attempt?.status === "stopped") completeAttempt(directory, state, attempt);
      else save(directory, state);
      return state;
    },
    { recoverStale: false },
  );
}

export function improvementStatus(directoryInput: string) {
  const directory = sessionDirectory(directoryInput);
  const state = load(directory);
  ownedWorkspace(directory, state);
  assertDetached(workspace(directory));
  if (state.best) readBest(directory, state.best);
  const source = shellQuote(state.source);
  let cleanupBlockedReason: string | null = null;
  if (state.status === "stopped") {
    const lock = [".run.lock", ".run.lock-acquisition"]
      .map((name) => path.join(directory, name))
      .find((file) => fs.existsSync(file));
    if (lock)
      cleanupBlockedReason = `Session lock remains: ${lock}. Wait for the active command to finish; if it crashed, inspect the workspace and stop surviving workers before removing the stale lock.`;
    else {
      const processFile = path.join(directory, "process-groups.json");
      const groups = runningProcessGroups(processFile);
      if (groups.length)
        cleanupBlockedReason = `Owned worker groups are still running: ${groups.join(", ")}. Inspect ${processFile}, stop surviving workers, and rerun status before removing the workspace or session.`;
    }
  }
  return {
    directory,
    workspace: workspace(directory),
    ...state,
    nextBudgetStop: state.status === "ready" ? (budgetReason(state) ?? null) : null,
    cleanupBlockedReason,
    // Never run automatically: these discard the workspace and every retained candidate commit.
    cleanup:
      state.status === "stopped" && !cleanupBlockedReason
        ? [
            `git -C ${source} worktree remove ${shellQuote(workspace(directory))}`,
            `git -C ${source} for-each-ref --format='delete %(refname)' ${shellQuote(`refs/aek/improvements/${state.id}/`)} | git -C ${source} update-ref --stdin`,
          ]
        : null,
  };
}
