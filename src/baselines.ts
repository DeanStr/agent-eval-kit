import { evaluatePromotion, PromotionPolicyError } from "./promotion.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadComparisonInput } from "./compare.js";
import { artifactIndexRoot, assertArtifactIntegrity, type ArtifactIndex } from "./integrity.js";
import { isPortablePathComponent, sha256, stableJson, writeJson } from "./io.js";
import { loadRunState } from "./run/state.js";
import type { EvalConfig, JudgedVotes, RunReceipt, RunReport } from "./types.js";

export interface BaselinePromotion {
  schemaVersion: 1;
  baselineName: string;
  snapshotId: string;
  sourceRunId: string;
  sourceReportSha256: string;
  reportSha256: string;
  sourceArtifactIndexSha256: string;
  sourceArtifactRootSha256: string;
  evaluationFingerprint: string;
  target: RunReport["target"] & Pick<RunReceipt["target"], "git" | "treeSha256">;
  reviewer: string;
  promotedAt: string;
  promotionSha256: string;
  policy?: ReturnType<typeof evaluatePromotion>;
  images?: Record<
    string,
    { file: string; sha256: string; bytes: number; scenario: string; label: string }
  >;
}

interface BaselinePointer {
  schemaVersion: 1;
  baselineName: string;
  snapshotId: string;
  promotedAt: string;
}

export interface PromotedBaseline {
  directory: string;
  file: string;
  report: RunReport;
  promotion: BaselinePromotion;
}

function promotionHash(promotion: Omit<BaselinePromotion, "promotionSha256">): string {
  return sha256(stableJson(promotion));
}

const validName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const validSnapshot = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export function baselinesRoot(config: EvalConfig): string {
  return path.resolve(
    config.paths.baselines ?? path.join(config.project.root, "evals", "baselines"),
  );
}

/** Ballots carry per-vote grader reasoning, which snapshots omit like the item reasoning. */
function withoutBallots<T extends { votes?: JudgedVotes }>(value: T): T {
  if (!value.votes?.ballots) return value;
  const { ballots: _ballots, ...votes } = value.votes;
  return { ...value, votes };
}

function compactBaselineReport(report: RunReport): RunReport {
  const { url: _reportUrl, ...target } = report.target;
  const { url: _receiptUrl, ...receiptTarget } = report.receipt.target;
  return {
    ...report,
    // Promoted snapshots are designed to be reviewable and committable. A
    // deployment URL can disclose private hosts or query-string credentials,
    // and is not needed for compatibility (the fingerprint covers policy).
    target: { ...target, root: "." },
    receipt: { ...report.receipt, target: receiptTarget },
    areas: report.areas.map((area) => ({
      ...area,
      items: area.items.map(({ comparisons: _comparisons, adjudication, ...item }) => ({
        ...withoutBallots(item),
        ...(adjudication
          ? {
              adjudicationReceipt: {
                verdict: adjudication.verdict,
                revisionHash: adjudication.revisionHash,
              },
            }
          : {}),
        reasoning: "Promoted baseline comparison snapshot.",
        evidenceRefs: [],
      })),
      defects: [],
      notes: "",
      scenarios: [],
      caseResults: area.caseResults.map((item) => ({
        ...withoutBallots(item),
        reasoning: "Promoted baseline case snapshot.",
        evidenceRefs: [],
      })),
    })),
  };
}

function baselineDirectory(config: EvalConfig, name: string): string {
  if (!validName.test(name) || !isPortablePathComponent(name)) {
    throw new Error(
      "Baseline name must be a portable path component using 1-100 letters, numbers, dots, underscores, or hyphens",
    );
  }
  return path.join(baselinesRoot(config), name);
}

function promotionTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readPointer(directory: string): BaselinePointer {
  const file = path.join(directory, "current.json");
  if (!fs.existsSync(file)) throw new Error(`Baseline has no current promotion: ${directory}`);
  const pointer = JSON.parse(fs.readFileSync(file, "utf8")) as BaselinePointer;
  if (
    pointer.schemaVersion !== 1 ||
    typeof pointer.baselineName !== "string" ||
    typeof pointer.snapshotId !== "string" ||
    !validSnapshot.test(pointer.snapshotId) ||
    !isPortablePathComponent(pointer.snapshotId)
  ) {
    throw new Error(`Invalid baseline pointer: ${file}`);
  }
  return pointer;
}

export function promoteBaseline(options: {
  config: EvalConfig;
  runDir: string;
  name: string;
  reviewer: string;
  includeImages?: boolean;
  mode?: "release" | "milestone";
  reason?: string;
}): PromotedBaseline {
  const runDir = path.resolve(options.runDir);
  const reviewer = options.reviewer.trim();
  if (!reviewer) throw new Error("Baseline promotion requires a non-empty reviewer");
  const state = loadRunState(runDir);
  if (state.status !== "complete")
    throw new Error(`Only complete runs can be promoted; run status is ${state.status}`);
  const artifactIndex = assertArtifactIntegrity(runDir, { require: true })!;
  const sourceIndexFile = path.join(runDir, "artifact-index.json");
  const sourceIndexBytes = fs.readFileSync(sourceIndexFile);
  const source = loadComparisonInput(runDir);
  if (!source.report.receipt)
    throw new Error("Only reports with evaluation receipts can be promoted");
  const policy = evaluatePromotion(
    options.config,
    source.report,
    options.mode ?? "release",
    options.reason,
  );
  if (policy.failures.length) throw new PromotionPolicyError(policy.failures);
  const sourceReportBytes = fs.readFileSync(source.file);
  const baselineReport = compactBaselineReport(source.report);
  const reportBytes = Buffer.from(`${JSON.stringify(baselineReport, null, 2)}\n`);
  const sourceReportSha256 = sha256(sourceReportBytes);
  const reportSha256 = sha256(reportBytes);
  const directory = baselineDirectory(options.config, options.name);
  fs.mkdirSync(directory, { recursive: true });
  const snapshotId = `${promotionTimestamp()}-${reportSha256.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotDirectory = path.join(directory, snapshotId);
  const staged = path.join(directory, `.aek-baseline-${crypto.randomUUID()}.tmp`);
  const promotedAt = new Date().toISOString();
  const images: NonNullable<BaselinePromotion["images"]> = {};
  if (options.includeImages) {
    for (const area of source.report.areas)
      for (const scenario of area.scenarios)
        for (const shot of scenario.screenshots) {
          const key = JSON.stringify([scenario.scenarioId, shot.path]);
          if (images[key])
            throw new Error(`Duplicate screenshot path in ${scenario.scenarioId}: ${shot.path}`);
          const relative = `${scenario.scenarioId}/${shot.path}`;
          const entry = artifactIndex.entries.find((entry) => entry.path === relative);
          if (!entry) throw new Error(`Screenshot is not sealed: ${relative}`);
          const extension = path.extname(shot.path).toLowerCase();
          if (![".jpg", ".jpeg", ".png"].includes(extension))
            throw new Error(`Unsupported baseline image format: ${relative}`);
          const file = `images/${sha256(key)}${extension}`;
          images[key] = {
            file,
            sha256: entry.sha256,
            bytes: entry.bytes,
            scenario: scenario.scenarioId,
            label: shot.label,
          };
        }
  }
  const promotionPayload: Omit<BaselinePromotion, "promotionSha256"> = {
    schemaVersion: 1,
    policy,
    ...(options.includeImages ? { images } : {}),
    baselineName: options.name,
    snapshotId,
    sourceRunId: source.report.runId,
    sourceReportSha256,
    reportSha256,
    sourceArtifactIndexSha256: sha256(sourceIndexBytes),
    sourceArtifactRootSha256: artifactIndex.rootSha256,
    evaluationFingerprint: source.report.receipt.evaluationFingerprint,
    target: {
      kind: source.report.target.kind,
      root: ".",
      ...(source.report.receipt.target.git === undefined
        ? {}
        : { git: source.report.receipt.target.git }),
      ...(source.report.receipt.target.treeSha256 === undefined
        ? {}
        : { treeSha256: source.report.receipt.target.treeSha256 }),
    },
    reviewer,
    promotedAt,
  };
  const promotion: BaselinePromotion = {
    ...promotionPayload,
    promotionSha256: promotionHash(promotionPayload),
  };
  try {
    fs.mkdirSync(staged);
    if (options.includeImages) {
      fs.mkdirSync(path.join(staged, "images"));
      for (const [key, image] of Object.entries(images)) {
        const [scenarioId, shotPath] = JSON.parse(key) as string[];
        if (scenarioId === undefined || shotPath === undefined)
          throw new Error(`Invalid baseline image key: ${key}`);
        const scenario = source.report.areas
          .flatMap((area) => area.scenarios)
          .find((s) => s.scenarioId === scenarioId)!;
        const shot = scenario.screenshots.find((s) => s.path === shotPath)!;
        const bytes = fs.readFileSync(path.join(runDir, scenarioId, shot.path));
        if (bytes.length !== image.bytes || sha256(bytes) !== image.sha256)
          throw new Error("Baseline image changed during promotion");
        fs.writeFileSync(path.join(staged, image.file), bytes);
      }
    }
    fs.writeFileSync(path.join(staged, "report.json"), reportBytes, { flag: "wx" });
    fs.writeFileSync(path.join(staged, "source-artifact-index.json"), sourceIndexBytes, {
      flag: "wx",
    });
    writeJson(path.join(staged, "promotion.json"), promotion);
    fs.renameSync(staged, snapshotDirectory);
    const pointer: BaselinePointer = {
      schemaVersion: 1,
      baselineName: options.name,
      snapshotId,
      promotedAt,
    };
    writeJson(path.join(directory, "current.json"), pointer);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  return {
    directory: snapshotDirectory,
    file: path.join(snapshotDirectory, "report.json"),
    report: baselineReport,
    promotion,
  };
}

export function loadPromotedBaseline(config: EvalConfig, name: string): PromotedBaseline {
  const directory = baselineDirectory(config, name);
  const pointer = readPointer(directory);
  if (pointer.baselineName !== name)
    throw new Error(`Baseline pointer name mismatch: expected ${name}`);
  const snapshotDirectory = path.join(directory, pointer.snapshotId);
  const promotionFile = path.join(snapshotDirectory, "promotion.json");
  const reportFile = path.join(snapshotDirectory, "report.json");
  const sourceIndexFile = path.join(snapshotDirectory, "source-artifact-index.json");
  for (const file of [promotionFile, reportFile, sourceIndexFile]) {
    if (!fs.existsSync(file)) throw new Error(`Incomplete baseline snapshot; missing ${file}`);
  }
  const promotion = JSON.parse(fs.readFileSync(promotionFile, "utf8")) as BaselinePromotion;
  if (
    promotion.schemaVersion !== 1 ||
    promotion.baselineName !== name ||
    promotion.snapshotId !== pointer.snapshotId
  ) {
    throw new Error(`Invalid baseline promotion metadata: ${promotionFile}`);
  }
  const { promotionSha256, ...promotionPayload } = promotion;
  if (promotionSha256 !== promotionHash(promotionPayload)) {
    throw new Error(`Promoted baseline metadata checksum changed: ${promotionFile}`);
  }
  if (sha256(fs.readFileSync(reportFile)) !== promotion.reportSha256) {
    throw new Error(`Promoted baseline report checksum changed: ${reportFile}`);
  }
  if (sha256(fs.readFileSync(sourceIndexFile)) !== promotion.sourceArtifactIndexSha256) {
    throw new Error(`Promoted baseline artifact-index checksum changed: ${sourceIndexFile}`);
  }
  const sourceIndex = JSON.parse(fs.readFileSync(sourceIndexFile, "utf8")) as ArtifactIndex;
  if (
    sourceIndex.schemaVersion !== 1 ||
    sourceIndex.rootSha256 !== artifactIndexRoot(sourceIndex) ||
    sourceIndex.rootSha256 !== promotion.sourceArtifactRootSha256
  ) {
    throw new Error(`Promoted baseline artifact root mismatch: ${sourceIndexFile}`);
  }
  for (const image of Object.values(promotion.images ?? {})) {
    if (!/^images\/[a-f0-9]{64}\.(?:jpg|jpeg|png)$/i.test(image.file))
      throw new Error("Invalid baseline image path");
    const bytes = fs.readFileSync(path.join(snapshotDirectory, image.file));
    if (bytes.length !== image.bytes || sha256(bytes) !== image.sha256)
      throw new Error("Baseline image checksum changed");
  }
  const loaded = loadComparisonInput(reportFile);
  if (loaded.report.receipt.evaluationFingerprint !== promotion.evaluationFingerprint) {
    throw new Error(`Promoted baseline evaluator fingerprint changed: ${reportFile}`);
  }
  return { directory: snapshotDirectory, ...loaded, promotion };
}

export function listPromotedBaselines(config: EvalConfig): Array<{
  name: string;
  snapshotId: string;
  sourceRunId: string;
  reviewer: string;
  promotedAt: string;
}> {
  const root = baselinesRoot(config);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && validName.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const baseline = loadPromotedBaseline(config, entry.name);
      return {
        name: entry.name,
        snapshotId: baseline.promotion.snapshotId,
        sourceRunId: baseline.promotion.sourceRunId,
        reviewer: baseline.promotion.reviewer,
        promotedAt: baseline.promotion.promotedAt,
      };
    });
}
