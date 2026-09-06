import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { humanAdjudicationSchema } from "./artifact-schemas.js";
import type { ArtifactIndex } from "./integrity.js";
import { sha256, stableJson } from "./io.js";
import type {
  AdjudicationEvidence,
  EvalSpec,
  HumanAdjudication,
  JudgedItem,
  RubricItem,
  RunReport,
} from "./types.js";

const text = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisions: z
      .array(
        z
          .object({
            areaId: text,
            itemId: text,
            previousRevision: digest.nullable(),
            verdict: z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]),
            rationale: text,
            evidence: z
              .array(
                z.discriminatedUnion("kind", [
                  z
                    .object({ kind: z.literal("collected"), path: text, description: text })
                    .strict(),
                  z
                    .object({
                      kind: z.literal("human"),
                      path: text,
                      description: text,
                      observedAt: z.iso.datetime({ offset: true }),
                    })
                    .strict(),
                ]),
              )
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

const key = (areaId: string, itemId: string) => JSON.stringify([areaId, itemId]);

export function adjudicationCriterionHash(rubric: RubricItem): string {
  const { weight: _weight, tags: _tags, gate: _gate, ...definition } = rubric;
  return sha256(
    stableJson({
      ...definition,
      grader: rubric.grader.type === "hybrid" ? { type: "hybrid" } : rubric.grader,
    }),
  );
}

export function automaticAbstained(item: JudgedItem, rubric: RubricItem): boolean {
  const original = item.adjudication?.original ?? item;
  return (
    rubric.grader.type !== "manual" &&
    (rubric.grader.type === "hybrid"
      ? (rubric.grader.autoShare > 0 || item.adjudication !== undefined) &&
        original.components?.automatic === "cannot_judge"
      : original.source !== "manual" &&
        original.source !== "adjudication" &&
        original.verdict === "cannot_judge")
  );
}

export function validateAdjudication(record: HumanAdjudication): void {
  humanAdjudicationSchema.parse(record);
  const { revisionHash, ...payload } = record;
  if (
    revisionHash !== sha256(stableJson(payload)) ||
    record.originalSha256 !== sha256(stableJson(record.original))
  )
    throw new Error(
      "Adjudication checksum does not match its recorded decision or original result",
    );
  const components = record.original.components;
  if (components !== undefined && components.automatic === undefined)
    throw new Error(
      "Adjudication original result is missing its automatic component; restore the complete original judgement",
    );
  if (
    record.itemId !== record.original.id ||
    record.original.source === "adjudication" ||
    (components === undefined ? record.original.verdict : components.automatic) !== "cannot_judge"
  )
    throw new Error("Adjudication must preserve an original automatic cannot_judge result");
  if (record.verdict !== "cannot_judge" && !record.evidence.length)
    throw new Error("An adjudicated verdict requires supporting evidence");
  if (record.verdict === "cannot_judge" && record.supersedes === null)
    throw new Error("Only an existing adjudication can be withdrawn");
  for (const evidence of record.evidence) {
    if (
      path.posix.normalize(evidence.path) !== evidence.path ||
      evidence.path.startsWith("/") ||
      evidence.path === ".." ||
      evidence.path.startsWith("../") ||
      evidence.path.includes("\\")
    )
      throw new Error("Adjudication evidence requires a normalized run-relative path");
    if (
      evidence.kind === "human" &&
      (evidence.path !== `adjudication-evidence/${evidence.sha256}` ||
        Date.parse(evidence.observedAt!) > Date.parse(record.reviewedAt))
    )
      throw new Error("Human evidence has an invalid path or future observation timestamp");
  }
}

export function assertItemAdjudication(item: JudgedItem, rubric: RubricItem, areaId: string): void {
  if (item.adjudicationReceipt)
    throw new Error(
      `Cannot score redacted adjudication provenance for ${areaId}/${item.id}; use the original run`,
    );
  const record = item.adjudication;
  if (!record) {
    if (item.source === "adjudication")
      throw new Error(`Missing adjudication provenance for ${areaId}/${item.id}`);
    return;
  }
  validateAdjudication(record);
  // A rescore may give a hybrid's automatic share zero weight; the recorded
  // decision remains auditable but contributes nothing to that score.
  const originalAbstained =
    rubric.grader.type === "hybrid"
      ? record.original.components?.automatic === "cannot_judge" &&
        item.components?.automatic === "cannot_judge"
      : record.original.verdict === "cannot_judge" && record.original.source !== "manual";
  if (
    rubric.grader.type === "manual" ||
    !originalAbstained ||
    record.areaId !== areaId ||
    record.itemId !== item.id ||
    record.criterionSha256 !== adjudicationCriterionHash(rubric)
  )
    throw new Error(`Adjudication does not match the automatic criterion ${areaId}/${item.id}`);
}

/** Validate embedded provenance even when a comparison snapshot has no rubric definitions. */
export function assertReportAdjudications(report: RunReport): void {
  for (const area of report.areas) {
    for (const item of area.items) {
      const record = item.adjudication;
      if (!record) {
        if (item.source === "adjudication" && !item.adjudicationReceipt)
          throw new Error(`Missing adjudication provenance for ${area.id}/${item.id}`);
        if (
          item.adjudicationReceipt &&
          !item.components &&
          item.verdict !== item.adjudicationReceipt.verdict
        )
          throw new Error(`Report disagrees with adjudication receipt for ${area.id}/${item.id}`);
        continue;
      }
      validateAdjudication(record);
      if (
        item.adjudicationReceipt ||
        record.areaId !== area.id ||
        record.itemId !== item.id ||
        (item.components
          ? item.components.automatic !== "cannot_judge"
          : item.verdict !== record.verdict)
      )
        throw new Error(`Report disagrees with adjudication provenance for ${area.id}/${item.id}`);
    }
  }
}

/** Prepare the entire decision batch before publishing any report or new file. */
export function prepareAdjudications(options: {
  runDir: string;
  report: RunReport;
  specs: EvalSpec[];
  inputFile: string;
  reviewer: string;
  index: ArtifactIndex;
}): { items: Map<string, JudgedItem[]>; files: Record<string, Buffer> } {
  const reviewer = text.parse(options.reviewer);
  const index = options.index;
  const artifacts = new Map(index.entries.map((entry) => [entry.path, entry]));
  const input = inputSchema.parse(JSON.parse(fs.readFileSync(options.inputFile, "utf8")));
  const historyFile = path.join(options.runDir, "adjudications.ndjson");
  const history: HumanAdjudication[] = fs.existsSync(historyFile)
    ? fs
        .readFileSync(historyFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const latest = new Map<string, HumanAdjudication>();
  let head: string | null = null;
  for (const record of history) {
    validateAdjudication(record);
    for (const evidence of record.evidence) {
      const artifact = artifacts.get(evidence.path);
      if (
        !artifact ||
        artifact.sha256 !== evidence.sha256 ||
        artifact.bytes !== evidence.bytes ||
        (evidence.kind === "human"
          ? artifact.role !== "review"
          : !["evidence", "judgement", "input"].includes(artifact.role))
      )
        throw new Error(
          `Adjudication evidence no longer matches its recorded artifact: ${evidence.path}`,
        );
    }
    const previous = latest.get(key(record.areaId, record.itemId));
    if (
      record.previousHash !== head ||
      record.supersedes !== (previous?.revisionHash ?? null) ||
      (previous &&
        (record.originalSha256 !== previous.originalSha256 ||
          record.criterionSha256 !== previous.criterionSha256))
    )
      throw new Error("Broken adjudication revision chain");
    latest.set(key(record.areaId, record.itemId), record);
    head = record.revisionHash;
  }
  const items = new Map(options.report.areas.map((area) => [area.id, structuredClone(area.items)]));
  for (const area of options.report.areas) {
    for (const item of area.items) {
      const previous = latest.get(key(area.id, item.id));
      if (stableJson(previous ?? null) !== stableJson(item.adjudication ?? null))
        throw new Error(`Report and adjudication history disagree for ${area.id}/${item.id}`);
    }
  }
  for (const record of latest.values()) {
    if (!items.get(record.areaId)?.some((item) => item.id === record.itemId))
      throw new Error("Adjudication history references an item missing from the report");
  }
  const seen = new Set<string>();
  const files: Record<string, Buffer> = Object.create(null);
  const reviewedAt = new Date().toISOString();
  let totalBytes = 0;
  for (const decision of input.decisions) {
    const identity = key(decision.areaId, decision.itemId);
    if (seen.has(identity))
      throw new Error(`Duplicate adjudication: ${decision.areaId}/${decision.itemId}`);
    seen.add(identity);
    const rubric = options.specs
      .find((spec) => spec.id === decision.areaId)
      ?.rubric.find((item) => item.id === decision.itemId);
    const item = items.get(decision.areaId)?.find((item) => item.id === decision.itemId);
    if (!rubric || !item || !automaticAbstained(item, rubric))
      throw new Error(
        `Only existing automatic cannot_judge results can be adjudicated: ${decision.areaId}/${decision.itemId}`,
      );
    assertItemAdjudication(item, rubric, decision.areaId);
    const previous = latest.get(identity);
    if (decision.previousRevision !== (previous?.revisionHash ?? null))
      throw new Error(
        `Stale previousRevision for ${decision.areaId}/${decision.itemId}; use the latest adjudication hash`,
      );
    const evidence: AdjudicationEvidence[] = decision.evidence.map((entry) => {
      if (entry.kind === "collected") {
        const artifact = artifacts.get(entry.path);
        if (!artifact || !["evidence", "judgement", "input"].includes(artifact.role))
          throw new Error(
            `Collected evidence must reference an indexed input, evidence or judgement artifact: ${entry.path}`,
          );
        return { ...entry, sha256: artifact.sha256, bytes: artifact.bytes };
      }
      const source = path.resolve(path.dirname(path.resolve(options.inputFile)), entry.path);
      const descriptor = fs.openSync(
        source,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024)
          throw new Error(
            `Human evidence must be a nonempty regular file of at most 20 MiB: ${entry.path}`,
          );
        bytes = fs.readFileSync(descriptor);
        if (bytes.length !== stat.size)
          throw new Error(`Human evidence changed while reading: ${entry.path}`);
      } finally {
        fs.closeSync(descriptor);
      }
      totalBytes += bytes.length;
      if (totalBytes > 100 * 1024 * 1024)
        throw new Error("Adjudication evidence exceeds 100 MiB per batch");
      const hash = sha256(bytes);
      const retained = `adjudication-evidence/${hash}`;
      files[retained] = bytes;
      return {
        ...entry,
        path: retained,
        sha256: hash,
        bytes: bytes.length,
        filename: path.basename(source),
      };
    });
    const { adjudication: _adjudication, ...current } = item;
    const original = previous?.original ?? current;
    const payload: Omit<HumanAdjudication, "revisionHash"> = {
      schemaVersion: 1,
      areaId: decision.areaId,
      itemId: decision.itemId,
      verdict: decision.verdict,
      reviewer,
      reviewedAt,
      rationale: decision.rationale,
      evidence,
      original,
      originalSha256: sha256(stableJson(original)),
      criterionSha256: adjudicationCriterionHash(rubric),
      basisArtifactRootSha256: index.rootSha256,
      supersedes: previous?.revisionHash ?? null,
      previousHash: head,
    };
    const record: HumanAdjudication = { ...payload, revisionHash: sha256(stableJson(payload)) };
    validateAdjudication(record);
    item.adjudication = record;
    item.source = "adjudication";
    if (rubric.grader.type !== "hybrid") item.verdict = record.verdict;
    history.push(record);
    latest.set(identity, record);
    head = record.revisionHash;
  }
  files["adjudications.ndjson"] = Buffer.from(
    `${history.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return { items, files };
}
