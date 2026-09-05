import { z } from "zod";
import { isPortablePathComponent } from "../io.js";

// Bump when visual measurement/decision semantics change, including defaults.
export const VISUAL_METHOD_VERSION = 5;

const fraction = z.number().min(0).max(1);
export const votingSchema = z.object({
  minimumVotes: z.number().int().min(1).max(25).default(5),
  maximumVotes: z.number().int().min(1).max(25).default(9),
  agreement: z.number().min(0.5).max(1).default(0.8),
  minimumConfidence: fraction.default(0.55),
}).strict().refine(v => v.maximumVotes >= v.minimumVotes, "maximumVotes must be >= minimumVotes")
  .refine(v => v.agreement > 0.5, "agreement must be greater than 0.5");
export type VotingPolicy = z.infer<typeof votingSchema>;

export const cropSchema = z.object({ x: fraction, y: fraction, width: fraction.positive(), height: fraction.positive() })
  .strict().refine(v => v.x + v.width <= 1 && v.y + v.height <= 1, "crop must fit within the image");
export const panelSchema = z.object({
  width: z.number().int().positive().max(2000).default(1280),
  height: z.number().int().positive().max(2000).default(800),
  fit: z.enum(["contain", "cover"]).default("contain"),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
}).strict();
export const referenceSchema = z.object({
  file: z.string().min(1).optional(),
  baseline: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).optional(),
  scenario: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  crop: cropSchema.optional(),
  candidateCrop: cropSchema.optional(),
}).strict().refine(v => Boolean(v.file) !== Boolean(v.baseline), "reference needs exactly one of file or baseline")
  .refine(v => v.baseline ? Boolean(v.label) : !v.scenario && !v.label, "baseline references require a label; file references cannot specify scenario or label");
export const pairwiseSchema = z.object({
  type: z.literal("pairwise"),
  candidate: z.string().min(1),
  references: z.array(referenceSchema).min(1).max(20),
  policy: z.enum(["preference", "non_regression"]),
  panel: panelSchema.default({ width: 1280, height: 800, fit: "contain", background: "#ffffff" }),
  voting: votingSchema.default({ minimumVotes: 5, maximumVotes: 9, agreement: 0.8, minimumConfidence: 0.55 }),
}).strict();
export type PairwiseGrader = z.infer<typeof pairwiseSchema>;
export type VisualReference = z.infer<typeof referenceSchema>;

export const metricRequirementSchema = z.object({ min: z.number().optional(), max: z.number().optional(), equals: z.number().optional() }).strict()
  .refine(v => Object.keys(v).length > 0, "metric requires min, max, or equals")
  .refine(v => v.min === undefined || v.max === undefined || v.min <= v.max, "min must be <= max")
  .refine(v => v.equals === undefined || (v.min === undefined || v.equals >= v.min) && (v.max === undefined || v.equals <= v.max), "equals must be within min/max bounds");
export const imageMetricNames = ["entropy", "stdev", "gradientEnergy", "darkPixelFraction", "highlightPixelFraction", "largestDarkRegionFraction", "largestHighlightRegionFraction"] as const;
export type ImageMetric = typeof imageMetricNames[number];
const imageLevels = {
  darkLevel: z.number().int().min(0).max(254).default(8),
  highlightLevel: z.number().int().min(1).max(255).default(247),
};
export const imageHealthSchema = z.object({
  crop: cropSchema.optional(), ...imageLevels,
  metrics: z.partialRecord(z.enum(imageMetricNames), metricRequirementSchema)
    .refine(v => Object.keys(v).length > 0, "image health requires metric bounds"),
}).strict().refine(v => v.darkLevel < v.highlightLevel, "darkLevel must be below highlightLevel");
export type ImageHealth = z.infer<typeof imageHealthSchema>;

export const distinctnessSchema = z.object({
  type: z.literal("image-distinctness"),
  candidate: z.string().min(1),
  crop: cropSchema.optional(),
  minimumDistance: fraction.positive(),
}).strict();
export type DistinctnessGrader = z.infer<typeof distinctnessSchema>;

const statisticPolicySchema = z.object({
  change: z.enum(["relative", "absolute"]).default("relative"),
  minimumBaseline: z.number().positive().default(0.000001),
  mean: metricRequirementSchema.optional(),
  perScene: metricRequirementSchema.optional(),
}).strict();
export const imageRegressionSchema = z.object({
  type: z.literal("image-regression"),
  candidate: z.string().min(1),
  baseline: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  crop: cropSchema.optional(), ...imageLevels,
  metrics: z.partialRecord(z.enum(imageMetricNames), statisticPolicySchema)
    .refine(v => Object.values(v).some(policy => policy?.mean || policy?.perScene), "image-regression requires at least one explicit mean or perScene bound; use pairwise diagnostics for unscored statistics"),
}).strict().refine(v => v.darkLevel < v.highlightLevel, "darkLevel must be below highlightLevel");
export type ImageRegressionGrader = z.infer<typeof imageRegressionSchema>;

export const checkpointSchema = z.object({
  label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .refine(isPortablePathComponent, "must be a portable file name")
    .refine(v => v.toLowerCase() !== "contact-sheet", "contact-sheet is reserved"),
  timeSeconds: z.number().nonnegative(),
}).strict();

export const captureSchema = z.object({
  hook: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).default("__AEK_EVAL__"),
  seed: z.number().int().default(1337),
  setup: z.record(z.string(), z.unknown()).default({}),
  readySelector: z.string().min(1).optional(),
  timeoutSeconds: z.number().positive().max(600).default(60),
  passes: z.number().int().min(2).max(10).default(2),
  frames: z.number().int().min(1).max(30).optional(),
  checkpoints: z.array(checkpointSchema).min(1).max(30).optional(),
  stepSeconds: z.number().positive().optional(),
  channelTolerance: z.number().int().min(0).max(255).default(0),
  movementChannelTolerance: z.number().int().min(0).max(255).default(0),
  movementCrop: cropSchema.optional(),
  maximumChangedPixelRatio: fraction.default(0),
  minimumMovement: fraction.optional(),
  maximumMovement: fraction.optional(),
  minimumEntropy: z.number().nonnegative().max(8).optional(),
  minimumStdev: z.number().nonnegative().optional(),
  imageHealth: imageHealthSchema.optional(),
  rejectDuplicateFrames: z.boolean().default(false),
  metrics: z.record(z.string().min(1), metricRequirementSchema).default({}),
  renderer: z.enum(["default", "software"]).default("default"),
  rendererPattern: z.string().min(1).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.checkpoints) {
    if (v.frames !== undefined || v.stepSeconds !== undefined) ctx.addIssue({ code: "custom", message: "checkpoints cannot be combined with frames or stepSeconds" });
    if (new Set(v.checkpoints.map(p => p.label.toLowerCase())).size !== v.checkpoints.length) ctx.addIssue({ code: "custom", message: "checkpoint labels must be unique ignoring case" });
    if (v.checkpoints.some((p, i) => i > 0 && p.timeSeconds <= v.checkpoints![i - 1].timeSeconds)) ctx.addIssue({ code: "custom", message: "checkpoint times must be strictly increasing" });
  }
  if ((v.checkpoints?.length ?? v.frames ?? 1) === 1 && (v.minimumMovement !== undefined || v.maximumMovement !== undefined || v.rejectDuplicateFrames || v.movementCrop || v.movementChannelTolerance !== 0))
    ctx.addIssue({ code: "custom", message: "movement and duplicate checks require frames > 1" });
  if (v.minimumMovement !== undefined && v.maximumMovement !== undefined && v.minimumMovement > v.maximumMovement)
    ctx.addIssue({ code: "custom", message: "minimumMovement must be <= maximumMovement" });
  if (v.rendererPattern) { try { new RegExp(v.rendererPattern); } catch { ctx.addIssue({ code: "custom", message: "invalid rendererPattern" }); } }
});
export type CaptureConfig = z.infer<typeof captureSchema>;

export function captureSchedule(capture: Pick<CaptureConfig, "frames" | "stepSeconds" | "checkpoints">) {
  return capture.checkpoints ?? Array.from({ length: capture.frames ?? 1 }, (_, i) => ({
    label: `frame-${String(i + 1).padStart(3, "0")}`, timeSeconds: i * (capture.stepSeconds ?? 1),
  }));
}

export function controlledScreenshotLabels(capture: Pick<CaptureConfig, "frames" | "passes" | "checkpoints">): string[] {
  const frames = captureSchedule(capture).map(p => p.label);
  const labels = frames.length > 1 ? [...frames, "contact-sheet"] : frames;
  return Array.from({ length: capture.passes }, (_, pass) => labels.map(label => pass ? `pass-${String(pass + 1).padStart(2, "0")}/${label}` : label)).flat();
}

export const diagnosticPolicySchema = z.object({
  failOn: z.array(z.enum(["console", "pageerror", "requestfailed", "http"])).default([]),
  ignoreUrls: z.array(z.string().min(1)).default([]),
}).strict();
export type DiagnosticPolicy = z.infer<typeof diagnosticPolicySchema>;

export interface CaptureCheck { name: string; pass: boolean; actual?: number; expected?: unknown }
export const browserDiagnosticSchema = z.object({
  kind: z.enum(["console", "pageerror", "requestfailed", "http"]),
  at: z.iso.datetime(), message: z.string().max(2000), url: z.string().optional(),
  status: z.number().int().min(400).max(599).optional(),
}).strict().refine(v => v.kind === "http" ? v.status !== undefined : v.status === undefined, "Only HTTP events require a status code");
export type BrowserDiagnostic = z.infer<typeof browserDiagnosticSchema>;
export const pairResultSchema = z.object({
  preferred: z.enum(["A", "B", "equivalent", "abstain"]),
  confidence: fraction,
  reasoning: z.string().min(1),
  findings: z.array(z.object({
    image: z.enum(["A", "B"]), severity: z.enum(["critical", "major", "minor"]),
    description: z.string().min(1), region: cropSchema,
  }).strict()).max(12),
}).strict();
export type PairResult = z.infer<typeof pairResultSchema>;
export interface VoteSummary { attempted: number; judgeable: number; counts: Record<string, number>; decision: string }
