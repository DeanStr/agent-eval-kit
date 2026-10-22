import { shellQuote } from "./cli-recovery.js";
import { validateCheckpoints } from "./checkpoints.js";
import { validateOutputs } from "./workflow.js";
import { readEvidenceFile, validateEvidenceFiles } from "./evidence/files.js";
import { omitUndefined } from "./invariants.js";
import { runReceiptSchema, scenarioEvidenceSchema } from "./artifact-schemas.js";
import fs from "node:fs";
import { loadResumableRunReport } from "./compare.js";
import path from "node:path";
import type { ConfigOverrides } from "./config.js";
import {
  assertCollectionCompatible,
  loadCollection,
  snapshotJudgingDefinitions,
} from "./collection.js";
import { throwIfCancelled } from "./cancellation.js";
import { judgeArea } from "./graders.js";
import { assertArtifactIntegrity, writeArtifactIndex } from "./integrity.js";
import {
  createTimestampedDirectory,
  prospectiveRealPath,
  sha256,
  stableJson,
  writeJson,
} from "./io.js";
import {
  buildRunReceipt,
  configCompatibility,
  currentJudgingRuntime,
  fixtureReceipts,
  judgingProviderReceipt,
  requiresModelJudging,
} from "./receipts.js";
import { buildReport, scoreArea } from "./scoring.js";
import { writeReportArtifacts } from "./report.js";
import { materializeSpecs } from "./specs.js";
import { loadRunState, withRunLock, type RunState } from "./run/state.js";
import { recoverRunArtifacts } from "./run/recovery.js";
import { graderMethodInputs } from "./judging/command-inputs.js";
import { textInputs, textInputPath, readTextSource } from "./text/inputs.js";
import { snapshotVisualInputs, validateVisualInputs, visualInputs } from "./visual/inputs.js";
import type { AreaResult, EvalConfig, EvalSpec, RunReceipt, ScenarioEvidence } from "./types.js";

export async function judgeCollected(options: {
  evidenceDir: string;
  config: EvalConfig;
  configFile: string;
  specs: EvalSpec[];
  fixtures: unknown;
  explicitConfig?: boolean;
  configOverrides?: ConfigOverrides;
  resumeDir?: string;
  onProgress?: (message: string) => void;
  onRunCreated?: (runDir: string) => void;
}) {
  throwIfCancelled();
  const sourceDir = fs.realpathSync(options.evidenceDir);
  const sourceState = loadRunState(sourceDir);
  if (sourceState.mode !== "collect" || sourceState.status !== "complete")
    throw new Error("judge requires a completed aek collect bundle");
  const manifest = loadCollection(sourceDir);
  const sourceIndex = assertArtifactIntegrity(sourceDir, { require: true })!;
  const { config, specs } = options;
  assertCollectionCompatible(manifest, config, specs, Boolean(options.explicitConfig));
  const sourceReceipt = runReceiptSchema.parse(
    JSON.parse(fs.readFileSync(path.join(sourceDir, "receipt.json"), "utf8")),
  ) as RunReceipt;
  if (!sourceReceipt.inputs.collectionMethodSha256)
    throw new Error("Collection method receipt is missing; collect fresh evidence");
  if (!sourceReceipt.inputs.configCompatibility)
    throw new Error("Saved config compatibility hashes are missing; collect fresh evidence");
  if (!options.explicitConfig && requiresModelJudging(specs, manifest.split)) {
    const current = configCompatibility(config);
    const saved = sourceReceipt.inputs.configCompatibility;
    const keys = new Set([...Object.keys(saved), ...Object.keys(current)]);
    const changed = [...keys].filter((key) => {
      if (key !== "config.instructions" && key !== "config.project" && !key.startsWith("judge."))
        return false;
      if (
        key === "judge.provider" &&
        options.configOverrides?.judgeProvider === config.judge.provider
      )
        return false;
      if (
        key === "judge.model" &&
        options.configOverrides?.judgeModel !== undefined &&
        options.configOverrides.judgeModel === config.judge.model
      )
        return false;
      return current[key] !== saved[key];
    });
    if (changed.length)
      throw new Error(
        `Sealed judge inputs differ from their collected values (${changed.join(", ")}). Supply --config with the original judge inputs; redacted values cannot drive model judging.`,
      );
  }
  const provenance: RunReceipt = structuredClone(sourceReceipt);
  provenance.runtime.judging = currentJudgingRuntime();
  // Only the judge runs now. Collection runtime and target remain the originals.
  provenance.providers.judge = judgingProviderReceipt(config, specs, manifest.split);
  provenance.inputs.config = {
    sha256: sha256(stableJson(config)),
    bytes: Buffer.byteLength(stableJson(config)),
  };
  provenance.inputs.configRepresentation = options.explicitConfig ? "resolved" : "redacted";
  provenance.inputs.configCompatibility = options.explicitConfig
    ? configCompatibility(config)
    : {
        ...sourceReceipt.inputs.configCompatibility,
        "judge.provider": sha256(stableJson(config.judge.provider)),
        "judge.model": sha256(stableJson(config.judge.model ?? null)),
      };
  const receiptsFor = (inputs: Record<string, { sha256: string; bytes: number }>) =>
    Object.fromEntries(
      Object.entries(inputs).map(([key, { sha256, bytes }]) => [key, { sha256, bytes }]),
    );
  let newTextReferences: ReturnType<typeof textInputs> | undefined;
  if (options.explicitConfig) {
    if (
      stableJson(fixtureReceipts(config.paths.fixtures, options.fixtures)) !==
      stableJson(sourceReceipt.inputs.fixtures)
    )
      throw new Error("Fixtures changed; collect fresh evidence");
    if (
      stableJson(receiptsFor(graderMethodInputs(config, specs, manifest.split))) !==
      stableJson(sourceReceipt.inputs.graderMethods)
    )
      throw new Error("Executable check implementation changed; collect fresh evidence");
    await validateVisualInputs(config, specs, manifest.split, manifest.scenarioIds, true);
    provenance.inputs.visual = receiptsFor(visualInputs(config, specs, manifest.split));
    newTextReferences = textInputs(config, specs, manifest.split, "textReferences");
    provenance.inputs.textReferences = receiptsFor(newTextReferences);
  }
  provenance.collection = {
    runId: sourceState.runId,
    artifactRootSha256: sourceIndex.rootSha256,
    definitionsSha256: manifest.definitionsSha256,
  };
  const receipt = buildRunReceipt({
    config,
    specs,
    fixtures: options.fixtures,
    ...omitUndefined({ scenarioIds: manifest.scenarioIds }),
    split: manifest.split,
    evidenceProvenance: provenance,
  });
  const materialized = materializeSpecs(specs, manifest.split).filter(
    (spec) => spec.rubric.length || spec.exclusions?.length,
  );
  const configuredRoot = path.resolve(config.paths.runs);
  const outputRoot = prospectiveRealPath(configuredRoot);
  if (
    !options.resumeDir &&
    (outputRoot === sourceDir || outputRoot.startsWith(sourceDir + path.sep))
  )
    throw new Error("Judging output must be outside the immutable collection bundle");
  const runDir = options.resumeDir
    ? fs.realpathSync(options.resumeDir)
    : createTimestampedDirectory(outputRoot);
  if (runDir === sourceDir || runDir.startsWith(sourceDir + path.sep))
    throw new Error("Judging output must be outside the immutable collection bundle");
  let preparing = false;
  return withRunLock(runDir, async () => {
    let state: RunState;
    const priorAreas = new Map<string, AreaResult>();
    if (options.resumeDir) {
      state = loadRunState(runDir);
      if (
        state.mode !== "judge" ||
        state.evidenceSource !== sourceDir ||
        state.inputFingerprint !== receipt.inputFingerprint
      )
        throw new Error("Judge inputs or evidence changed; start a new judging run");
      if (state.status === "complete")
        throw new Error(
          "Judging run is complete; start a new judging run to retain a separate result",
        );
      const savedReceipt = JSON.parse(fs.readFileSync(path.join(runDir, "receipt.json"), "utf8"));
      if (stableJson(savedReceipt) !== stableJson(receipt))
        throw new Error(
          "Judging receipt changed; restore the sealed receipt or start a new judging run",
        );
      // Evidence copies are immutable, even when partial judgement artifacts are recoverable.
      for (const entry of sourceIndex.entries.filter(
        (entry) => !entry.path.startsWith("inputs/") && entry.path !== "receipt.json",
      )) {
        const file = path.join(runDir, entry.path);
        if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== entry.sha256)
          throw new Error(`Collected evidence copy changed: ${entry.path}`);
      }
      const recovery = recoverRunArtifacts(runDir, materialized, state);
      if (recovery.reportIsSealed) {
        for (const area of loadResumableRunReport(path.join(runDir, "report.json")).report.areas) {
          if (recovery.prefixIsFullySealed(`areas/${area.id}/`)) priorAreas.set(area.id, area);
        }
      }
    } else {
      preparing = true;
      // Copy bytes, never hardlink: later judging cannot mutate the source bundle.
      for (const entry of sourceIndex.entries) {
        const bytes = fs.readFileSync(path.join(sourceDir, entry.path));
        if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
          throw new Error(`Collection changed while copying: ${entry.path}`);
        const file = path.join(runDir, entry.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { mode: 0o600 });
      }
      snapshotJudgingDefinitions(runDir, config, specs, receipt);
      if (options.explicitConfig) {
        fs.rmSync(path.join(runDir, "inputs", "visual"), { recursive: true, force: true });
        snapshotVisualInputs(config, specs, runDir, manifest.split, receipt.inputs.visual!);
        fs.rmSync(path.join(runDir, "inputs", "textReferences"), { recursive: true, force: true });
        for (const [key, input] of Object.entries(newTextReferences!)) {
          const { bytes } = readTextSource(input.source);
          if (sha256(bytes) !== input.sha256)
            throw new Error(`Text reference changed during snapshot: ${key}`);
          const file = textInputPath(runDir, key, "textReferences");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes);
        }
      }
      state = {
        schemaVersion: 1,
        mode: "judge",
        evidenceSource: sourceDir,
        status: "running",
        runId: path.basename(runDir),
        pid: process.pid,
        configFile: path.resolve(options.configFile),
        ...omitUndefined({ configOverrides: options.configOverrides }),
        startedAt: new Date().toISOString(),
        selectedAreas: specs.map((spec) => spec.id),
        ...omitUndefined({ selectedScenarios: manifest.scenarioIds }),
        selectedSplit: manifest.split,
        specHashes: Object.fromEntries(
          Object.entries(receipt.inputs.specs).map(([id, input]) => [id, input.sha256]),
        ),
        inputFingerprint: receipt.inputFingerprint,
      };
      writeJson(path.join(runDir, "receipt.json"), receipt);
      writeArtifactIndex(runDir);
    }
    state.status = "running";
    state.pid = process.pid;
    delete state.lastError;
    writeJson(path.join(runDir, "run-state.json"), state);
    preparing = false;
    options.onRunCreated?.(runDir);
    const areas: AreaResult[] = [];
    try {
      for (const spec of materialized) {
        throwIfCancelled();
        const priorArea = priorAreas.get(spec.id);
        if (priorArea) {
          areas.push(priorArea);
          continue;
        }
        if (!spec.rubric.length) {
          areas.push(scoreArea({ spec, config, evidence: [], judgements: [] }));
          continue;
        }
        const evidence = spec.scenarios.map((scenario) => {
          const value = scenarioEvidenceSchema.parse(
            JSON.parse(fs.readFileSync(path.join(runDir, scenario.id, "evidence.json"), "utf8")),
          ) as ScenarioEvidence;
          if (value.scenarioId !== scenario.id || value.outcome === "agent_error")
            throw new Error(`Invalid collected scenario: ${scenario.id}`);
          validateCheckpoints(scenario, value.checkpoints ?? {}, value.transcript);
          validateOutputs(scenario, value.outputs ?? {}, value.transcript, value.files);
          validateEvidenceFiles(
            value.files ?? [],
            value.transcript,
            value.outcome === "completed" ? scenario.collect?.files : [],
          );
          for (const file of value.files ?? [])
            readEvidenceFile(path.join(runDir, scenario.id), file);
          return value;
        });
        const collectedCommands = JSON.parse(
          fs.readFileSync(path.join(runDir, "areas", spec.id, "collected-commands.json"), "utf8"),
        );
        const judged = await judgeArea({
          config,
          spec,
          evidence,
          runDir,
          commands: { mode: "collected", results: collectedCommands },
          areaDirectory: path.join(runDir, "areas", spec.id),
          ...omitUndefined({ onProgress: options.onProgress }),
          onVoteComplete: () => writeArtifactIndex(runDir),
        });
        areas.push(
          scoreArea({
            spec,
            judgements: judged.items,
            evidence,
            config,
            defects: judged.defects,
            notes: judged.notes,
            caseResults: judged.cases,
          }),
        );
        writeReportArtifacts(
          runDir,
          buildReport({ runId: state.runId, startedAt: state.startedAt, config, areas, receipt }),
          materialized,
        );
      }
      throwIfCancelled();
      const report = buildReport({
        runId: state.runId,
        startedAt: state.startedAt,
        config,
        areas,
        receipt,
      });
      writeReportArtifacts(runDir, report, materialized);
      state.status = "complete";
      writeJson(path.join(runDir, "run-state.json"), state);
      return { runDir, report };
    } catch (error) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      writeJson(path.join(runDir, "run-state.json"), state);
      options.onProgress?.(
        `With unchanged judging inputs, retry with: aek judge --resume ${shellQuote(runDir)}. After changing judging inputs, start a new judge run against the sealed collection.`,
      );
      throw error;
    }
  }).catch((error) => {
    // Failed preparation has no resumable state; retain only runs that reached execution.
    if (preparing) fs.rmSync(runDir, { recursive: true, force: true });
    throw error;
  });
}
