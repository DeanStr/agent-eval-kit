import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const relative = z
  .string()
  .min(1)
  .refine(
    (s) =>
      !s.startsWith("/") && !s.includes("\\") && !s.split("/").includes("..") && !s.includes("\0"),
    "Expected a contained relative path",
  );
const repetitionsError =
  "--repetitions must be an integer from 2 to 20; omit it for single-run acceptance";
export const startSchema = z
  .object({
    config: z.string().min(1),
    output: z.string().min(1),
    goal: z.string().trim().min(1),
    suite: z.string().min(1).optional(),
    maxAttempts: z.number().int().min(1).max(100).default(3),
    maxStalls: z.number().int().min(1).max(100).default(2),
    budgetSeconds: z.number().int().min(1).max(86400).default(3600),
    minimumGain: z.number().min(0).max(100).default(0),
    // Omitted: one run per evaluation. Otherwise every evaluation is a campaign.
    repetitions: z
      .number({ error: repetitionsError })
      .int(repetitionsError)
      .min(2, repetitionsError)
      .max(20, repetitionsError)
      .optional(),
  })
  .strict();
export type StartOptions = z.input<typeof startSchema>;

export const stopReasonSchema = z.enum([
  "budget_exhausted",
  "attempt_limit",
  "no_improvement",
  "insufficient_evidence",
  "execution_error",
  "user_stopped",
]);
const runSchema = z.object({ directory: relative, reportHash: hash }).strict();
// Anchor the campaign summary and every complete report used by acceptance.
const campaignSchema = z
  .object({ directory: relative, reportHash: hash, runs: z.array(runSchema).min(2).max(20) })
  .strict()
  .refine(
    (campaign) => new Set(campaign.runs.map((run) => run.directory)).size === campaign.runs.length,
    "Campaign repetition report references must have unique directories",
  );
const bestSchema = z.union([
  z.object({ checkpoint: commit, run: runSchema, accepted: z.boolean() }).strict(),
  z.object({ checkpoint: commit, campaign: campaignSchema, accepted: z.boolean() }).strict(),
]);
export const attemptSchema = z
  .object({
    number: z.number().int().positive(),
    hypothesis: z.string().trim().min(1),
    startedAt: z.string().datetime(),
    status: z.enum([
      "editing",
      "evaluating",
      "accepted",
      "rejected",
      "inconclusive",
      "execution_error",
      "stopped",
    ]),
    checkpoint: commit.optional(),
    recoveryCheckpoint: commit.optional(),
    evaluationDirectory: relative.optional(),
    run: runSchema.optional(),
    campaign: campaignSchema.optional(),
    comparison: relative.optional(),
    scoreGain: z.number().optional(),
    guidance: z
      .object({ text: z.string().min(1), sha256: hash })
      .strict()
      .optional(),
    reasons: z.array(z.string()),
  })
  .strict();
export type Attempt = z.infer<typeof attemptSchema>;
export const sessionSchema = z
  .object({
    version: z.literal(2),
    id: z.string().uuid(),
    source: z.string().min(1),
    gitCommonDir: z.string().min(1),
    workspaceGitDir: z.string().min(1),
    config: relative,
    suite: z.string().min(1).optional(),
    goal: z.string().min(1),
    startedAt: z.string().datetime(),
    deadline: z.string().datetime(),
    maxAttempts: z.number().int().positive(),
    maxStalls: z.number().int().positive(),
    minimumGain: z.number().min(0).max(100),
    /** 1 is single-run acceptance; 2–20 evaluates every checkpoint as a campaign. */
    repetitions: z.number().int().min(1).max(20),
    status: z.enum(["initializing", "ready", "editing", "evaluating", "stopped"]),
    stopReason: stopReasonSchema.optional(),
    initial: commit,
    best: bestSchema.optional(),
    pinnedFiles: z.record(relative, hash),
    attempts: z.array(attemptSchema),
    error: z.string().optional(),
    stopDetail: z.string().optional(),
    stoppedCheckpoint: commit.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const repeated = session.repetitions > 1;
    const expected = repeated ? "campaign" : "run";
    if (session.best && !(expected in session.best))
      context.addIssue({
        code: "custom",
        path: ["best"],
        message: `A ${session.repetitions}-repetition session must record its best ${expected}`,
      });
    session.attempts.forEach((attempt, index) => {
      if (repeated ? attempt.run : attempt.campaign)
        context.addIssue({
          code: "custom",
          path: ["attempts", index],
          message: `A ${session.repetitions}-repetition session records only ${expected} evaluations`,
        });
    });
  });
export type Session = z.infer<typeof sessionSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;

export interface ImprovementSessionContext {
  status: Session["status"];
  stopReason: StopReason | null;
  attemptStatus: Attempt["status"] | null;
}
