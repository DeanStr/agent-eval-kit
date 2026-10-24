import { evidenceFileSchema } from "./evidence/files.js";
import { checkpointEvidenceSchema } from "./checkpoints.js";
import { cropSchema, browserDiagnosticSchema } from "./visual/contracts.js";
import { z } from "zod";
import { calculateScoreSlice } from "./score-slice.js";
import type { ScoreSlice, Verdict } from "./types.js";

const text = z.string();
const id = text.min(1);
const strings = z.array(text);
const count = z.number().int().nonnegative();
const percent = z.number().min(0).max(100);
const fraction = z.number().min(0).max(1);
const verdict = z.enum(["pass", "partial", "fail", "not_found", "cannot_judge"]);
const confidence = z.enum(["high", "medium", "low"]);
const provider = z.enum(["mock", "codex", "claude", "grok", "cursor"]);
const split = z.enum(["development", "evaluation"]);
const targetKind = z.enum(["web", "repository", "command"]);
const record = <T extends z.ZodType>(value: T) => z.record(text, value);
const artifact = z.object({ sha256: id, bytes: count });
const sliceShape = {
  earned: z.number().nonnegative(),
  judgeable: z.number().nonnegative(),
  total: z.number().nonnegative(),
  scorePct: percent.nullable(),
  coveragePct: percent,
};
function validateScoreSlice(value: ScoreSlice, context: z.RefinementCtx): void {
  const tolerance = Number.EPSILON * Math.max(value.earned, value.judgeable, value.total) * 16;
  if (value.earned > value.judgeable + tolerance || value.judgeable > value.total + tolerance) {
    context.addIssue({
      code: "custom",
      message: "Score weights must satisfy earned <= judgeable <= total",
    });
  }
  const expected = calculateScoreSlice(value);
  for (const field of ["scorePct", "coveragePct"] as const) {
    if (value[field] !== expected[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `Must be ${expected[field]} for the recorded weights`,
      });
    }
  }
}

export const scoreSliceSchema = z.object(sliceShape).superRefine(validateScoreSlice);
const stratum = z.object({ ...sliceShape, cases: count }).superRefine(validateScoreSlice);

function validCasePoints(value: { verdict: Verdict; points: number | null }): boolean {
  switch (value.verdict) {
    case "pass":
      return value.points === 1;
    case "fail":
    case "not_found":
      return value.points === 0;
    case "cannot_judge":
      return value.points === null;
    case "partial":
      return value.points !== null;
  }
}

const casePointsMessage =
  "Case points must be pass=1, fail/not_found=0, cannot_judge=null, or configured partial credit in [0,1]";
const judgement = {
  verdict,
  confidence,
  reasoning: text,
  evidenceRefs: strings,
};
export const collectedCommandResultsSchema = z
  .array(
    z
      .object({
        ...judgement,
        id,
        source: z.literal("command"),
      })
      .strict(),
  )
  .refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
    "Duplicate collected command IDs",
  );

export const judgedVotesSchema = z
  .object({
    attempted: count,
    judgeable: count,
    counts: record(count),
    decision: text,
    ballots: z
      .array(z.object({ verdict, confidence, outcome: id, reasoning: text }).strict())
      .optional(),
  })
  .superRefine((votes, context) => {
    if (!votes.ballots) return;
    const counts: Record<string, number> = {};
    for (const ballot of votes.ballots) counts[ballot.outcome] = (counts[ballot.outcome] ?? 0) + 1;
    if (
      votes.ballots.length !== votes.attempted ||
      Object.keys(counts).length !== Object.keys(votes.counts).length ||
      Object.entries(counts).some(([outcome, value]) => votes.counts[outcome] !== value)
    )
      context.addIssue({
        code: "custom",
        path: ["ballots"],
        message: "Recorded ballots must match the attempted vote count and outcome counts",
      });
  });
const originalItem = z.object({
  ...judgement,
  id,
  source: z.enum([
    "text-pairwise",
    "text-rubric",
    "llm",
    "command",
    "manual",
    "adjudication",
    "pairwise",
    "capture",
    "image-distinctness",
    "image-regression",
  ]),
  components: z.object({ automatic: verdict.optional(), manual: verdict.optional() }).optional(),
  score: scoreSliceSchema,
  comparisons: strings.optional(),
  votes: judgedVotesSchema.optional(),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reviewText = z.string().trim().min(1);
export const humanAdjudicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    areaId: id,
    itemId: id,
    verdict,
    reviewer: reviewText,
    reviewedAt: z.iso.datetime({ offset: true }),
    rationale: reviewText,
    evidence: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("collected"),
            path: id,
            description: reviewText,
            sha256: digest,
            bytes: count,
          })
          .strict(),
        z
          .object({
            kind: z.literal("human"),
            path: z.string().regex(/^adjudication-evidence\/[a-f0-9]{64}$/),
            description: reviewText,
            sha256: digest,
            bytes: count,
            filename: id,
            observedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      ]),
    ),
    original: originalItem.strict(),
    originalSha256: digest,
    criterionSha256: digest,
    basisArtifactRootSha256: digest,
    supersedes: digest.nullable(),
    previousHash: digest.nullable(),
    revisionHash: digest,
  })
  .strict();
const item = originalItem.extend({
  adjudication: humanAdjudicationSchema.optional(),
  adjudicationReceipt: z.object({ verdict, revisionHash: digest }).strict().optional(),
});
const uniqueItems = z
  .array(item)
  .refine(
    (values) => new Set(values.map((value) => value.id)).size === values.length,
    "Duplicate rubric item IDs",
  );
const gateShape = {
  itemId: id,
  status: z.enum(["passed", "failed", "unavailable"]),
  verdict: verdict.optional(),
  reason: text,
};
const gate = z.object(gateShape);
const providerModel = z.object({ provider, model: text.optional(), effort: id.optional() });
const receiptProvider = providerModel.extend({ cliVersion: id });
const receiptTarget = z.object({
  kind: targetKind,
  url: text.optional(),
  treeSha256: text.optional(),
  git: z.object({ commit: id, dirty: z.boolean(), worktreeSha256: text.optional() }).optional(),
});
const receipt = z.object({
  collection: z.object({ runId: id, artifactRootSha256: id, definitionsSha256: id }).optional(),
  schemaVersion: z.literal(1),
  evaluationFingerprint: id,
  inputFingerprint: id,
  inputs: z.object({
    config: artifact,
    configRepresentation: z.enum(["resolved", "redacted"]).optional(),
    configCompatibility: record(id).optional(),
    scoringConfig: artifact.optional(),
    methodSha256: id,
    collectionMethodSha256: id.optional(),
    visual: record(artifact).optional(),
    textCases: record(id).optional(),
    specMethods: record(id),
    textCandidates: record(artifact).optional(),
    textReferences: record(artifact).optional(),
    collectorSources: record(artifact).optional(),
    collectorMethods: record(artifact).optional(),
    graderMethods: record(artifact).optional(),
    specs: record(artifact.extend({ file: id })),
    fixtures: z
      .object({ manifest: artifact, files: record(artifact.extend({ configuredPath: text })) })
      .optional(),
    selection: z.object({
      areas: strings,
      textCases: strings.optional(),
      scenarios: strings.optional(),
      split: z.enum(["development", "evaluation", "all"]).optional(),
    }),
  }),
  target: receiptTarget,
  providers: z.object({ agent: receiptProvider, judge: receiptProvider }),
  runtime: z.object({
    judging: z
      .object({ node: id, kitVersion: id, platform: id, arch: id, sharp: record(text) })
      .optional(),
    kitVersion: id,
    node: id,
    platform: id,
    arch: id,
    evidence: z
      .object({ chromium: text.optional(), playwright: id, sharp: record(text) })
      .optional(),
  }),
});
const scenarioOutput = z.object({
  value: z.union([text, z.number().finite(), z.boolean()]),
  evidenceRefs: strings,
});
const evidence = z.object({
  files: z.array(evidenceFileSchema).optional(),
  checkpoints: record(checkpointEvidenceSchema).optional(),
  dependencyEvidence: record(id).optional(),
  outputs: record(scenarioOutput).optional(),
  inputs: record(
    scenarioOutput.extend({ scenarioId: id, output: id, file: evidenceFileSchema.optional() }),
  ).optional(),
  scenarioId: id,
  scenarioName: text,
  kind: z.enum(["browser", "workspace", "command"]),
  persona: text.optional(),
  sourceScenarioId: text.optional(),
  caseId: text.optional(),
  strata: strings.optional(),
  split: split.optional(),
  outcome: z.enum(["completed", "blocked", "feature_not_found", "agent_error"]),
  summary: text,
  observations: strings,
  evidenceRefs: strings,
  collector: z.enum(["controlled", "command"]).optional(),
  captureChecks: z
    .array(
      z.object({
        name: id,
        pass: z.boolean(),
        actual: z.number().optional(),
        expected: z.unknown().optional(),
      }),
    )
    .optional(),
  diagnostics: z.array(browserDiagnosticSchema).optional(),
  transcript: z.array(
    z.object({
      persona: text.optional(),
      step: count,
      at: text,
      tool: text,
      input: record(z.unknown()),
      result: text,
      isError: z.boolean().optional(),
    }),
  ),
  screenshots: z.array(
    z.object({
      persona: text.optional(),
      path: text,
      label: text,
      step: count,
      url: text.optional(),
      timeSeconds: z.number().nonnegative().optional(),
      source: text.optional(),
      extraction: text.optional(),
    }),
  ),
  artifacts: record(text),
  provider,
  model: text.optional(),
  providerSessionId: text.optional(),
  usage: record(z.unknown()).optional(),
  startedAt: text,
  finishedAt: text,
  durationMs: z.number().nonnegative(),
  finalUrl: text.optional(),
  error: text.optional(),
});
const judgedCase = z
  .object({
    ...judgement,
    areaId: id,
    rubricId: id,
    caseId: id,
    scenarioIds: strings,
    strata: strings,
    split: split.optional(),
    source: z.enum(["llm", "pairwise", "text-pairwise", "text-rubric"]),
    points: fraction.nullable(),
    votes: judgedVotesSchema.optional(),
  })
  .refine(validCasePoints, casePointsMessage);
export const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: id,
  project: text,
  target: z.object({ kind: targetKind, root: text, url: text.optional() }),
  startedAt: text,
  finishedAt: text,
  kitVersion: id,
  providers: z.object({ agent: providerModel, judge: providerModel }),
  areas: z.array(
    z
      .object({
        ...sliceShape,
        id,
        title: text,
        weight: z.number().positive(),
        optional: z.boolean(),
        exclusions: z.array(z.object({ id, weight: z.number().positive(), reason: id })).optional(),
        items: uniqueItems,
        defects: z.array(
          z.object({
            severity: z.enum(["critical", "major", "minor"]),
            description: text,
            evidenceRefs: strings,
            region: cropSchema.optional(),
          }),
        ),
        notes: text,
        scenarios: z.array(evidence),
        pendingManual: strings,
        unproven: strings,
        byTag: record(scoreSliceSchema),
        byStratum: record(stratum),
        gates: z.array(gate),
        caseResults: z
          .array(judgedCase)
          .refine(
            (values) =>
              new Set(values.map((value) => JSON.stringify([value.rubricId, value.caseId])))
                .size === values.length,
            "Duplicate case measurements",
          ),
      })
      .superRefine(validateScoreSlice),
  ),
  overallScorePct: percent.nullable(),
  overallCoveragePct: percent,
  scoreWithheld: z.boolean(),
  byTag: record(scoreSliceSchema),
  byStratum: record(stratum),
  manualPending: count,
  receipt,
  gates: z.object({
    passed: z.boolean(),
    blocking: z.array(z.object({ ...gateShape, areaId: id })),
  }),
});

const distribution = z.object({
  mean: percent,
  median: percent,
  minimum: percent,
  maximum: percent,
  standardDeviation: z.number().nonnegative(),
  confidenceInterval95: z
    .object({
      lower: percent,
      upper: percent,
      method: z.literal("deterministic_percentile_run_bootstrap"),
      resamplingUnit: z.literal("complete evaluation run"),
      resamples: z.literal(2000),
    })
    .nullable(),
});
const measurement = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("state", [
    z.object({
      state: z.literal("observed"),
      value,
      evidence: z.object({ availableRuns: count, totalRuns: count }),
    }),
    z.object({ state: z.literal("unavailable"), value: z.null(), reason: text }),
  ]);
const verdictCounts = z.object({
  pass: count,
  partial: count,
  fail: count,
  not_found: count,
  cannot_judge: count,
});
const caseIdentity = {
  areaId: id,
  rubricId: id,
  caseId: id,
  strata: strings,
  split: split.optional(),
};
export const campaignRunSchema = z.discriminatedUnion("status", [
  z.object({
    ordinal: z.number().int().positive(),
    status: z.literal("failed"),
    runDir: id.optional(),
    error: text.refine((value) => Boolean(value.trim()), "Failed runs require an error message"),
  }),
  z.object({
    ordinal: z.number().int().positive(),
    status: z.literal("complete"),
    runId: id,
    runDir: id,
    evaluationFingerprint: id,
    inputFingerprint: id,
    scorePct: percent.nullable(),
    coveragePct: percent,
    scoreWithheld: z.boolean(),
    gatesPassed: z.boolean().optional(),
    items: z.array(z.object({ areaId: id, itemId: id, verdict })),
    cases: z.array(
      z
        .object({ ...caseIdentity, verdict, points: fraction.nullable() })
        .refine(validCasePoints, casePointsMessage),
    ),
  }),
]);
export const campaignReportSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: id,
  project: text,
  status: z.enum(["running", "complete"]),
  startedAt: text,
  updatedAt: text,
  plannedRepetitions: z.number().int().positive(),
  compatibility: z.object({
    status: z.enum(["compatible", "incompatible", "unknown"]),
    evaluationFingerprint: text.optional(),
    fingerprints: strings,
    inputFingerprint: text.optional(),
    inputFingerprints: strings,
  }),
  coverage: z.object({ completedRuns: count, failedRuns: count, pendingRuns: count }),
  scorePct: measurement(distribution),
  evidenceCoveragePct: measurement(distribution),
  criticalGatePassRate: measurement(fraction),
  itemStability: z.array(
    z.object({
      areaId: id,
      itemId: id,
      observedRuns: count,
      verdicts: verdictCounts,
      fullPassRate: fraction,
    }),
  ),
  caseStability: z.array(
    z.object({
      ...caseIdentity,
      observedRuns: count,
      verdicts: verdictCounts,
      fullPassRate: fraction,
    }),
  ),
  stratumStability: z.array(
    z.object({
      stratum: text,
      observations: count,
      verdicts: verdictCounts,
      fullPassRate: fraction,
    }),
  ),
  runs: z.array(campaignRunSchema),
  limitations: strings,
});

export { receipt as runReceiptSchema, evidence as scenarioEvidenceSchema };
