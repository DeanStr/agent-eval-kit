import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { campaignRunSchema, runReceiptSchema } from "./artifact-schemas.js";
import {
  buildCampaignReport,
  campaignRunRecord,
  createCampaignDirectory,
  writeCampaignArtifacts,
  type CampaignRunRecord,
} from "./campaign.js";
import { configOverridesSchema, loadRunState, processIsAlive, withRunLock } from "./run/state.js";
import { prepareEvaluation, runEvaluation, type RunOptions } from "./runner.js";
import { buildRunReceipt } from "./receipts.js";
import { sha256, stableJson, writeJson } from "./io.js";
import { assertArtifactIntegrity, createArtifactIndex, type ArtifactIndex } from "./integrity.js";
import { verifyFailedRunArtifacts } from "./run/failed-artifacts.js";
import { loadComparisonInput } from "./compare.js";
import { evaluateCiThresholds, type CiThresholds } from "./ci.js";
import { throwIfCancelled } from "./cancellation.js";
import { omitUndefinedDeep } from "./invariants.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignId: z.string().min(1),
    project: z.string().min(1),
    startedAt: z.iso.datetime(),
    configFile: z.string().min(1),
    configOverrides: configOverridesSchema.optional(),
    selectedAreas: z.array(z.string().min(1)).min(1),
    selectedScenarios: z.array(z.string().min(1)).optional(),
    selectedSplit: z.enum(["development", "evaluation", "all"]),
    plannedRepetitions: z.number().int().min(2),
    thresholds: z
      .object({
        minimumScore: z.number().min(0).max(100).optional(),
        minimumCoverage: z.number().min(0).max(100).optional(),
      })
      .strict(),
    inputFingerprint: hash,
    evaluationFingerprint: hash,
    fixedInputsFingerprint: hash,
    runs: z.array(campaignRunSchema),
    artifactRoots: z.record(z.string(), hash),
    recoveryError: z.string().min(1).optional(),
    active: z
      .object({ ordinal: z.number().int().positive(), runDir: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();
type CampaignState = z.infer<typeof stateSchema>;

// Target commands may change the target, but never the evaluator or snapshotted inputs.
function fixedInputsFingerprint(receipt: {
  evaluationFingerprint: string;
  inputs: unknown;
}): string {
  return sha256(
    stableJson({ evaluationFingerprint: receipt.evaluationFingerprint, inputs: receipt.inputs }),
  );
}

function saveState(directory: string, state: CampaignState): void {
  stateSchema.parse(state);
  writeJson(path.join(directory, "campaign-state.json"), {
    state,
    sha256: sha256(stableJson(state)),
  });
}

export function loadCampaignState(directory: string): CampaignState {
  const file = path.join(path.resolve(directory), "campaign-state.json");
  if (!fs.existsSync(file))
    throw new Error(`Campaign recovery state is missing: ${file}; start a new campaign`);
  const envelope = z
    .object({ state: stateSchema, sha256: hash })
    .strict()
    .parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const state = envelope.state;
  if (sha256(stableJson(state)) !== envelope.sha256)
    throw new Error(`Campaign state checksum mismatch: ${file}`);
  if (state.campaignId !== path.basename(path.resolve(directory)))
    throw new Error(`Campaign identity does not match directory: ${file}`);
  if (
    state.runs.some((run, index) => run.ordinal !== index + 1) ||
    state.runs.length > state.plannedRepetitions ||
    (state.active &&
      (state.active.ordinal !== state.runs.length + 1 ||
        state.active.ordinal > state.plannedRepetitions))
  )
    throw new Error(`Invalid campaign attempt order: ${file}`);
  const recorded = new Set(state.runs.map((r) => String(r.ordinal)));
  if (Object.keys(state.artifactRoots).some((ordinal) => !recorded.has(ordinal)))
    throw new Error(`Unexpected campaign artifact receipt: ${file}`);
  return omitUndefinedDeep(state);
}

function loadActiveRunState(runDir: string) {
  if (!fs.existsSync(runDir))
    throw new Error(
      `Campaign run directory is missing: ${runDir}. Restore the original directory before resuming.`,
    );
  const stateFile = path.join(runDir, "run-state.json");
  if (fs.existsSync(stateFile)) return loadRunState(runDir);
  // Before the first state write, the runner only acquires its lock and
  // snapshots inputs. Everything else requires a state that must be restored.
  const unexpected = fs.readdirSync(runDir, { withFileTypes: true }).filter((entry) => {
    if (entry.isDirectory() && ["inputs", ".run.lock-acquisition"].includes(entry.name))
      return false;
    if (entry.isFile() && entry.name === ".run.lock") return false;
    return !(
      entry.isFile() &&
      /^run-state\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        entry.name,
      )
    );
  });
  if (unexpected.length)
    throw new Error(
      `Campaign run state is missing: ${stateFile}, but execution artifacts exist (${unexpected.map((entry) => entry.name).join(", ")}). Restore the original run-state.json before resuming.`,
    );
  return undefined;
}

export async function runCampaign(
  options: RunOptions & {
    repetitions: number;
    output?: string;
    resumeCampaign?: string;
    thresholds: CiThresholds;
  },
): Promise<void> {
  await prepareEvaluation(options);
  const directory = options.resumeCampaign
    ? path.resolve(options.resumeCampaign)
    : createCampaignDirectory(options.config, options.output);
  const receiptOptions = {
    config: options.config,
    specs: options.specs,
    fixtures: options.fixtures,
    split: options.split ?? ("development" as const),
    ...(options.scenarioIds ? { scenarioIds: options.scenarioIds } : {}),
    ignoredTargetPaths: [directory],
  };
  await withRunLock(directory, async () => {
    const saved = options.resumeCampaign ? loadCampaignState(directory) : undefined;
    if (saved?.recoveryError)
      throw new Error(`Campaign checkpoint failed: ${saved.recoveryError}. Start a new campaign.`);
    const initial = buildRunReceipt(receiptOptions);
    const state: CampaignState = saved
      ? saved
      : {
          schemaVersion: 1,
          campaignId: path.basename(directory),
          project: options.config.project.name,
          startedAt: new Date().toISOString(),
          configFile: path.resolve(options.configFile),
          ...(options.configOverrides ? { configOverrides: options.configOverrides } : {}),
          selectedAreas: options.specs.map((spec) => spec.id),
          ...(options.scenarioIds ? { selectedScenarios: options.scenarioIds } : {}),
          selectedSplit: options.split ?? "development",
          plannedRepetitions: options.repetitions,
          thresholds: options.thresholds,
          inputFingerprint: initial.inputFingerprint,
          evaluationFingerprint: initial.evaluationFingerprint,
          fixedInputsFingerprint: fixedInputsFingerprint(initial),
          runs: [],
          artifactRoots: {},
        };
    const activeRunDir = state.active?.runDir;
    const activeRunState = activeRunDir ? loadActiveRunState(activeRunDir) : undefined;
    if (activeRunState?.status === "running" && processIsAlive(activeRunState.pid))
      throw new Error(
        `Campaign repetition ${state.active!.ordinal} still belongs to active process ${activeRunState.pid}`,
      );
    let matchingInputs = state.inputFingerprint === initial.inputFingerprint;
    // A crash can land after a run seals setup/checker mutations and before the
    // campaign records them. Only an intact active receipt can attest that change.
    if (
      !matchingInputs &&
      activeRunDir &&
      activeRunState &&
      fs.existsSync(path.join(activeRunDir, "artifact-index.json"))
    ) {
      const index =
        activeRunState.status === "complete"
          ? assertArtifactIntegrity(activeRunDir, { require: true })!
          : verifyFailedRunArtifacts(activeRunDir, initial);
      if (index.entries.some((entry) => entry.path === "receipt.json")) {
        const receipt = runReceiptSchema.parse(
          JSON.parse(fs.readFileSync(path.join(activeRunDir, "receipt.json"), "utf8")),
        );
        matchingInputs =
          receipt.inputFingerprint === initial.inputFingerprint &&
          receipt.inputFingerprint === activeRunState.inputFingerprint &&
          fixedInputsFingerprint(receipt) === state.fixedInputsFingerprint;
      }
    }
    if (!matchingInputs || state.fixedInputsFingerprint !== fixedInputsFingerprint(initial))
      throw new Error(
        "Campaign inputs changed since the last checkpoint (target, evaluator, fixtures, or provider method). Restore the original inputs or start a new campaign.",
      );
    const reports = new Map<number, ReturnType<typeof loadComparisonInput>["report"]>();
    for (const run of state.runs) {
      const root = state.artifactRoots[String(run.ordinal)];
      if (run.status === "complete" && !root)
        throw new Error(`Campaign repetition ${run.ordinal} is missing its artifact receipt`);
      if (root) {
        if (!run.runDir)
          throw new Error(`Campaign repetition ${run.ordinal} is missing its run directory`);
        const checkpointOptions =
          run.status === "failed"
            ? {
                index: JSON.parse(
                  fs.readFileSync(
                    path.join(directory, "failed-artifacts", `${run.ordinal}.json`),
                    "utf8",
                  ),
                ) as ArtifactIndex,
              }
            : {};
        const index = assertArtifactIntegrity(run.runDir, {
          require: true,
          allowUnindexed: run.status === "failed",
          ...checkpointOptions,
        })!;
        if (index.rootSha256 !== root)
          throw new Error(
            `Campaign repetition ${run.ordinal} artifacts changed; restore the original run`,
          );
      }
      if (run.status === "complete") {
        if (loadRunState(run.runDir).status !== "complete")
          throw new Error(`Campaign repetition ${run.ordinal} is no longer complete`);
        const { report } = loadComparisonInput(run.runDir);
        if (stableJson(campaignRunRecord(run.ordinal, run.runDir, report)) !== stableJson(run))
          throw new Error(`Campaign repetition ${run.ordinal} does not match its retained report`);
        reports.set(run.ordinal, report);
      }
    }
    const publish = () => {
      saveState(directory, state);
      return writeCampaignArtifacts(
        directory,
        buildCampaignReport({ ...state, runs: state.runs as CampaignRunRecord[] }),
      );
    };
    const finishAttempt = (record: CampaignRunRecord) => {
      state.runs.push(record);
      try {
        const current = buildRunReceipt(receiptOptions);
        if (fixedInputsFingerprint(current) !== state.fixedInputsFingerprint)
          throw new Error(
            "Evaluator or candidate inputs changed during the campaign; restore the inputs and start a new campaign",
          );
        if (
          record.runDir &&
          (record.status === "complete" ||
            fs.existsSync(path.join(record.runDir, "artifact-index.json")))
        ) {
          if (record.status === "failed") {
            verifyFailedRunArtifacts(record.runDir, current);
            const checkpoint = createArtifactIndex(record.runDir, { includeRunIndex: true });
            writeJson(
              path.join(directory, "failed-artifacts", `${record.ordinal}.json`),
              checkpoint,
            );
            state.artifactRoots[String(record.ordinal)] = checkpoint.rootSha256;
          } else
            state.artifactRoots[String(record.ordinal)] = assertArtifactIntegrity(record.runDir, {
              require: true,
            })!.rootSha256;
        }
        state.inputFingerprint = current.inputFingerprint;
      } catch (error) {
        state.recoveryError = error instanceof Error ? error.message : String(error);
        state.runs[state.runs.length - 1] = {
          ordinal: record.ordinal,
          status: "failed",
          error: `${record.status === "failed" ? `${record.error} ` : ""}Campaign checkpoint failed: ${state.recoveryError}`,
          ...(record.runDir ? { runDir: record.runDir } : {}),
        };
        reports.delete(record.ordinal);
        throw error;
      } finally {
        delete state.active;
        publish();
      }
    };

    if (state.active) {
      const { ordinal, runDir } = state.active;
      if (runDir && activeRunState) {
        if (activeRunState.status === "complete") {
          // Verify before changing the journal so damaged artifacts can be restored.
          assertArtifactIntegrity(runDir, { require: true });
          const { report } = loadComparisonInput(runDir);
          reports.set(ordinal, report);
          finishAttempt(campaignRunRecord(ordinal, runDir, report));
        } else
          finishAttempt({
            ordinal,
            status: "failed",
            error: "Campaign interrupted before this attempt was recorded; original run retained.",
            runDir,
          });
      } else
        finishAttempt({
          ordinal,
          status: "failed",
          error: "Campaign interrupted before this attempt completed.",
          ...(runDir ? { runDir } : {}),
        });
    }
    publish();
    console.log(
      `Campaign ${state.campaignId}: ${state.runs.length}/${state.plannedRepetitions} attempts retained; ${directory}`,
    );
    for (let ordinal = state.runs.length + 1; ordinal <= state.plannedRepetitions; ordinal++) {
      throwIfCancelled();
      state.active = { ordinal };
      saveState(directory, state);
      console.log(
        `Campaign ${state.campaignId}: repetition ${ordinal}/${state.plannedRepetitions}`,
      );
      let record: CampaignRunRecord;
      try {
        const result = await runEvaluation({
          ...options,
          ignoredTargetPaths: [directory],
          onRunCreated: (runDir) => {
            state.active = { ordinal, runDir };
            saveState(directory, state);
          },
        });
        if (!result.report) throw new Error("Evaluation completed without a report");
        reports.set(ordinal, result.report);
        record = campaignRunRecord(ordinal, result.runDir, result.report);
      } catch (error) {
        record = {
          ordinal,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          ...(state.active?.runDir ? { runDir: state.active.runDir } : {}),
        };
      }
      finishAttempt(record);
      throwIfCancelled();
    }
    const artifacts = publish();
    const campaign = buildCampaignReport({ ...state, runs: state.runs as CampaignRunRecord[] });
    console.log(
      `Campaign complete: ${campaign.coverage.completedRuns}/${state.plannedRepetitions} runs; artifacts ${artifacts.json}, ${artifacts.html}`,
    );
    const failures = [...reports].flatMap(([ordinal, report]) =>
      evaluateCiThresholds(report, omitUndefinedDeep(state.thresholds)).map(
        (failure) => `repetition ${ordinal}: ${failure}`,
      ),
    );
    if (campaign.compatibility.status !== "compatible")
      failures.push(
        `campaign inputs are ${campaign.compatibility.status}; aggregate measurements are unavailable`,
      );
    for (const failure of failures) console.error(`CI campaign failed: ${failure}`);
    if (state.runs.some((run) => run.status === "failed")) process.exitCode = 1;
    else if (failures.length) process.exitCode = 2;
  });
}
