import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import YAML from "yaml";
import { z } from "zod";
import { loadResolvedConfig } from "../config.js";
import { throwIfCancelled } from "../cancellation.js";
import { evaluateCiThresholds } from "../ci.js";
import { createTimestampedDirectory, sha256, writeJson } from "../io.js";
import { assertEvaluationPlatform } from "../platform.js";
import { runEvaluation } from "../runner.js";
import { loadSpecs } from "../specs.js";
import { panelSchema, votingSchema } from "./contracts.js";
import { imageBytes, MAX_IMAGE_BYTES, sourceImage } from "./images.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const nonempty = z.string().trim().min(1);
// Whitespace can be part of a real filename. Validate paths without rewriting them.
const localPath = z.string().refine((value) => value.trim().length > 0, "Path must not be blank");
export const directImageOptionsSchema = z
  .object({
    candidate: localPath,
    reference: localPath,
    criterion: nonempty,
    absoluteCriterion: nonempty.optional(),
    policy: z.enum(["preference", "non_regression"]).default("non_regression"),
    judge: z.enum(["codex", "claude", "grok", "cursor", "mock"]).default("codex"),
    judgeModel: nonempty.optional(),
    judgeEffort: nonempty.optional(),
    timeoutSeconds: z.number().int().positive().default(900),
    capacityRetries: z.number().int().min(0).max(5).default(2),
    voting: votingSchema.default({
      minimumVotes: 5,
      maximumVotes: 9,
      agreement: 0.8,
      minimumConfidence: 0.55,
    }),
    panel: panelSchema.default({ width: 1280, height: 800, fit: "contain", background: "#ffffff" }),
    output: localPath.optional(),
    dryRun: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .strict()
  .refine((options) => !options.json || options.dryRun, "--json requires --dry-run");

// No project dependencies or user-provided shell fragments. Collection copies the
// sealed candidate bytes; normal command collection decodes them into image evidence.
export const DIRECT_IMAGE_COLLECTOR = `import fs from "node:fs";
import path from "node:path";
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
fs.copyFileSync(context.sources.candidate.path, path.join(context.outputDir, "candidate.image"));
console.log(JSON.stringify({
  version: 1, outcome: "completed",
  summary: "Collected the supplied image for direct comparison.",
  observations: ["The supplied image establishes visible content only, not application behavior or factual accuracy."],
  images: [{ label: "candidate", path: "candidate.image", source: "candidate",
    extraction: "Copied the original sealed image bytes; AEK applies orientation, white alpha flattening, and lossless PNG evidence decoding." }]
}));
`;

function hasPngAnimation(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return false;
  // The decoder can expose only the default APNG frame without reporting pages.
  // Inspect chunk boundaries, not arbitrary pixel data, for the animation control.
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    if (offset + 12 + length > bytes.length) break; // Decode reports truncation.
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") break;
    offset += length + 12;
  }
  return false;
}

async function readStaticImage(file: string, role: "candidate" | "reference") {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file))
    throw new Error(`${role} must be a local image file; download it before comparing`);
  try {
    const resolved = fs.realpathSync(path.resolve(file));
    const bytes = imageBytes(resolved);
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    }).metadata();
    if (
      !metadata.format ||
      !["png", "jpeg", "webp", "gif", "tiff", "avif", "heif", "svg"].includes(metadata.format)
    )
      throw new Error(
        "Unsupported image format; use PNG, JPEG, WebP, GIF, TIFF, AVIF/HEIF, or SVG",
      );
    if ((metadata.pages ?? 1) !== 1 || hasPngAnimation(bytes))
      throw new Error(
        "Animated and multi-page images are unsupported; extract one frame or page explicitly",
      );
    // Metadata alone can succeed on truncated images. Decode before creating output.
    const decoded = await sourceImage(bytes);
    // Collection retains the full candidate as PNG, and evidence readers enforce
    // the same byte limit as encoded inputs. References retain their source format.
    if (role === "candidate" && decoded.length > MAX_IMAGE_BYTES)
      throw new Error(
        "decoded PNG evidence exceeds 25 MiB; resize the candidate image before comparing",
      );
    return {
      bytes,
      info: {
        path: resolved,
        format: metadata.format,
        width: metadata.width!,
        height: metadata.height!,
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
  } catch (error) {
    throw new Error(
      `Invalid ${role} image ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function prepareImageComparison(input: z.input<typeof directImageOptionsSchema>) {
  assertEvaluationPlatform();
  const parsed = directImageOptionsSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(`Invalid image comparison options:\n${z.prettifyError(parsed.error)}`);
  const options = parsed.data;
  // Keep image decoding sequential to bound peak memory on large inputs.
  const candidate = await readStaticImage(options.candidate, "candidate");
  const reference = await readStaticImage(options.reference, "reference");
  if (options.output && fs.existsSync(path.resolve(options.output)))
    throw new Error(
      `Refusing to overwrite output directory: ${path.resolve(options.output)}. Choose a new directory.`,
    );
  const plan = {
    version: 1,
    candidate: candidate.info,
    reference: reference.info,
    criterion: options.criterion,
    absoluteCriterion: options.absoluteCriterion,
    policy: options.policy,
    judge: {
      provider: options.judge,
      model: options.judgeModel,
      effort: options.judgeEffort,
      timeoutSeconds: options.timeoutSeconds,
      capacityRetries: options.capacityRetries,
    },
    voting: options.voting,
    panel: options.panel,
    output: options.output
      ? path.resolve(options.output)
      : path.resolve(".agent-eval/image-comparisons/<comparison-id>"),
  };
  return { options, plan, candidate, reference };
}

export async function compareImageFiles(input: z.input<typeof directImageOptionsSchema>) {
  const prepared = await prepareImageComparison(input);
  const { options, plan, candidate, reference } = prepared;
  if (options.dryRun) {
    console.log(
      options.json
        ? JSON.stringify(plan, null, 2)
        : `Image comparison (${options.policy})\nCandidate: ${candidate.info.path} (${candidate.info.width}×${candidate.info.height})\nReference: ${reference.info.path} (${reference.info.width}×${reference.info.height})\nCriterion: ${options.criterion}\nJudge: ${options.judge}; ${options.voting.minimumVotes}–${options.voting.maximumVotes} votes\nNo output or provider calls created.`,
    );
    return { plan };
  }
  throwIfCancelled();
  let directory: string;
  if (options.output) {
    directory = path.resolve(options.output);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.mkdirSync(directory); // Exclusive reservation; never reuse an existing directory.
  } else {
    const parent = path.resolve(".agent-eval/image-comparisons");
    fs.mkdirSync(parent, { recursive: true });
    directory = createTimestampedDirectory(parent);
  }
  console.log(`Comparison: ${directory}`);
  const configFile = stageImageComparison(prepared, directory);
  const config = loadResolvedConfig(configFile);
  const specs = loadSpecs(config.paths.specs);
  const result = await runEvaluation({ config, configFile, specs, fixtures: {}, split: "all" });
  if (!result.report) throw new Error("Image comparison completed without a report");
  console.log(
    `Report: ${path.join(result.runDir, "report.html")}\nRun: ${result.runDir}\nResume: aek run --resume ${quote(result.runDir)}`,
  );
  console.log(
    `Comparison: ${result.report.areas[0]?.items.find((item) => item.id === "COMPARISON")?.verdict}; coverage ${result.report.overallCoveragePct}%`,
  );
  const failures = evaluateCiThresholds(result.report, {});
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length) process.exitCode = 2;
  return { plan, directory, ...result };
}

export function stageImageComparison(
  prepared: Awaited<ReturnType<typeof prepareImageComparison>>,
  directory: string,
): string {
  const { options, plan, candidate, reference } = prepared;
  // Files remain available for diagnosis and ordinary aek run --resume recovery.
  fs.mkdirSync(path.join(directory, "sources"));
  fs.mkdirSync(path.join(directory, "specs"));
  fs.writeFileSync(path.join(directory, "sources/candidate.image"), candidate.bytes, {
    flag: "wx",
  });
  fs.writeFileSync(path.join(directory, "sources/reference.image"), reference.bytes, {
    flag: "wx",
  });
  fs.writeFileSync(path.join(directory, "collect.mjs"), DIRECT_IMAGE_COLLECTOR, { flag: "wx" });
  writeJson(path.join(directory, "comparison-inputs.json"), plan);
  const configFile = path.join(directory, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Direct image comparison", root: "." },
      target: { kind: "repository" },
      agent: { provider: "mock" },
      judge: { ...plan.judge, ...(options.absoluteCriterion ? { voting: options.voting } : {}) },
      paths: { specs: "specs", runs: ".agent-eval/runs", auth: ".agent-eval/auth" },
      scoring: { partialCredit: 0.5, minimumCoverage: 100 },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "specs/image.yaml"),
    YAML.stringify({
      id: "image",
      title: "Image quality",
      weight: 100,
      description: "Evaluate supplied image quality against the stated criterion.",
      scenarios: [
        {
          id: "IMAGE",
          name: "Supplied image",
          kind: "command",
          instructions: "Collect the supplied candidate image as visual evidence.",
          collect: {
            command: `${quote(process.execPath)} collect.mjs`,
            methodFiles: ["collect.mjs"],
            timeoutSeconds: 60,
            sources: { candidate: "sources/candidate.image" },
            images: ["candidate"],
          },
        },
      ],
      rubric: [
        ...(options.absoluteCriterion
          ? [
              {
                id: "ACCEPTABLE",
                criterion: options.absoluteCriterion,
                passCriteria: options.absoluteCriterion,
                evidence:
                  "The supplied candidate image only; do not infer runtime behavior or factual accuracy.",
                weight: 1,
                gate: true,
                scenarios: ["IMAGE"],
                grader: { type: "llm" },
              },
            ]
          : []),
        {
          id: "COMPARISON",
          criterion: options.criterion,
          passCriteria:
            options.policy === "preference"
              ? "The candidate is preferred to the reference on the stated criterion; equivalence does not satisfy strict preference."
              : "The candidate is at least as good as the reference on the stated criterion; observed equivalence is acceptable.",
          weight: 1,
          gate: true,
          scenarios: ["IMAGE"],
          grader: {
            type: "pairwise",
            candidate: "candidate",
            policy: options.policy,
            references: [{ file: "sources/reference.image" }],
            panel: options.panel,
            voting: options.voting,
          },
        },
      ],
    }),
  );
  return configFile;
}

export async function imageCompareCommand(flags: Record<string, string | boolean>): Promise<void> {
  const string = (name: string, required = false): string | undefined => {
    const value = flags[name];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} requires a value`);
    return value;
  };
  const number = (name: string): number | undefined => {
    const value = string(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} requires a finite number`);
    return parsed;
  };
  const options = {
    candidate: string("candidate", true),
    reference: string("reference", true),
    criterion: string("criterion", true),
    absoluteCriterion: string("absolute-criterion"),
    policy: string("policy"),
    judge: string("judge"),
    judgeModel: string("judge-model"),
    judgeEffort: string("judge-effort"),
    timeoutSeconds: number("timeout-seconds"),
    capacityRetries: number("capacity-retries"),
    voting: {
      minimumVotes: number("minimum-votes"),
      maximumVotes: number("maximum-votes"),
      agreement: number("agreement"),
      minimumConfidence: number("minimum-confidence"),
    },
    panel: { width: number("width"), height: number("height") },
    output: string("output"),
    dryRun: Boolean(flags["dry-run"]),
    json: Boolean(flags.json),
  };
  // Validate enum/string values before entering the typed runtime API.
  const parsed = directImageOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Error(`Invalid image comparison options:\n${z.prettifyError(parsed.error)}`);
  await compareImageFiles(parsed.data);
}
