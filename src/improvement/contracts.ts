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
    version: z.literal(1),
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
    status: z.enum(["initializing", "ready", "editing", "evaluating", "stopped"]),
    stopReason: stopReasonSchema.optional(),
    initial: commit,
    best: z
      .object({ checkpoint: commit, run: runSchema, accepted: z.boolean() })
      .strict()
      .optional(),
    pinnedFiles: z.record(relative, hash),
    attempts: z.array(attemptSchema),
    error: z.string().optional(),
    stopDetail: z.string().optional(),
    stoppedCheckpoint: commit.optional(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;

export interface ImprovementSessionContext {
  status: Session["status"];
  stopReason: StopReason | null;
  attemptStatus: Attempt["status"] | null;
}
