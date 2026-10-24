import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { throwIfCancelled } from "../cancellation.js";
import { evaluateCiThresholds } from "../ci.js";
import { loadResolvedConfig } from "../config.js";
import {
  assertArtifactIntegrity,
  createArtifactIndex,
  writeArtifactIndex,
  type ArtifactIndex,
} from "../integrity.js";
import {
  createTimestampedDirectory,
  isPortablePathComponent,
  isWithin,
  prospectiveRealPath,
  sha256,
  stableJson,
  writeJson,
} from "../io.js";
import { providerVersion } from "../receipts.js";
import { escapeHtml } from "../report-presentation.js";
import { runEvaluation } from "../runner.js";
import { loadRunState, withRunLock } from "../run/state.js";
import { loadSpecs } from "../specs.js";
import type { RunReport } from "../types.js";
import { KIT_VERSION } from "../version.js";
import { panelSchema, VISUAL_METHOD_VERSION, votingSchema } from "./contracts.js";
import {
  directImageOptionsSchema,
  prepareImageComparison,
  stageImageComparison,
} from "./direct.js";
import { mapConcurrent } from "./votes.js";

const text = z.string().trim().min(1);
const settings = {
  criterion: text.optional(),
  absoluteCriterion: text.optional(),
  policy: z.enum(["preference", "non_regression"]).optional(),
  judge: z.enum(["codex", "claude", "grok", "cursor", "mock"]).optional(),
  judgeModel: text.optional(),
  judgeEffort: text.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  capacityRetries: z.number().int().min(0).max(5).optional(),
  voting: votingSchema.optional(),
  panel: panelSchema.optional(),
};
const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
  .refine(isPortablePathComponent);
export const imageBatchManifestSchema = z
  .object({
    version: z.literal(1),
    defaults: z.object(settings).strict().default({}),
    comparisons: z
      .array(
        z
          .object({
            ...settings,
            id: idSchema,
            label: text.max(200).optional(),
            candidate: z.string().min(1),
            reference: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (v) => new Set(v.comparisons.map((c) => c.id.toLowerCase())).size === v.comparisons.length,
    "Comparison IDs must be unique, including case folding",
  );

type Prepared = Awaited<ReturnType<typeof prepareImageComparison>>;
type Plan = Prepared["plan"];
interface BatchCase {
  id: string;
  label: string;
  fingerprint: string;
  plan: Plan;
  reusedFrom?: string;
}
interface BatchInputs {
  version: 1;
  kitVersion: string;
  methodVersion: number;
  concurrency: number;
  cases: BatchCase[];
}
interface CaseResult {
  id: string;
  label: string;
  status: "pending" | "complete" | "error";
  reusedFrom?: string;
  criterion: string;
  absoluteCriterion?: string;
  run?: string;
  failures?: string[];
  report?: RunReport;
  error?: string;
}
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
const inputFile = "batch-inputs.json",
  inputIndex = "batch-input-index.json";
const caseDirectory = (root: string, id: string) => path.join(root, "pairs", id);

function fingerprint(plan: Plan, cliVersion: string): string {
  const { path: _candidatePath, ...candidate } = plan.candidate;
  const { path: _referencePath, ...reference } = plan.reference;
  const { output: _output, ...contract } = plan;
  return sha256(
    stableJson({
      ...contract,
      candidate,
      reference,
      cliVersion,
      kitVersion: KIT_VERSION,
      visualMethodVersion: VISUAL_METHOD_VERSION,
      batchMethodVersion: 1,
      node: process.version,
      sharp: sharp.versions,
    }),
  );
}

function loadBatch(root: string): BatchInputs {
  if (fs.existsSync(path.join(root, "artifact-index.json")))
    assertArtifactIntegrity(root, { require: true });
  const index = readJson(path.join(root, inputIndex)) as ArtifactIndex;
  assertArtifactIntegrity(root, { index, require: true, allowUnindexed: true });
  const inputs = readJson(path.join(root, inputFile)) as BatchInputs;
  if (
    inputs.version !== 1 ||
    inputs.kitVersion !== KIT_VERSION ||
    inputs.methodVersion !== VISUAL_METHOD_VERSION ||
    !Number.isInteger(inputs.concurrency) ||
    inputs.concurrency < 1 ||
    inputs.concurrency > 8 ||
    !Array.isArray(inputs.cases) ||
    !inputs.cases.length
  )
    throw new Error(`Invalid or incompatible image batch: ${root}`);
  const ids = new Set<string>();
  for (const item of inputs.cases) {
    idSchema.parse(item.id);
    if (ids.has(item.id.toLowerCase())) throw new Error("Duplicate saved comparison ID");
    ids.add(item.id.toLowerCase());
  }
  return inputs;
}

function runDirectory(root: string): string | undefined {
  const runs = path.join(root, ".agent-eval/runs");
  if (!fs.existsSync(runs)) return undefined;
  const entries = fs.readdirSync(runs);
  if (entries.length > 1) throw new Error(`Expected one retained run in ${runs}`);
  return entries[0] ? path.join(runs, entries[0]) : undefined;
}

function completed(root: string): { run: string; report: RunReport } | undefined {
  const run = runDirectory(root);
  if (!run) return undefined;
  if (!fs.existsSync(path.join(run, "run-state.json"))) {
    if (fs.readdirSync(run).length === 0) return undefined;
    throw new Error(
      `Image comparison run is missing run-state.json and contains artifacts: ${run}. Restore the original batch artifacts or start a new batch; retained files were not removed.`,
    );
  }
  if (loadRunState(run).status !== "complete") return undefined;
  assertArtifactIntegrity(run, { require: true });
  if (fs.existsSync(path.join(root, "artifact-index.json")))
    assertArtifactIntegrity(root, { require: true });
  else writeArtifactIndex(root); // Recover completion interrupted before the batch checkpoint.
  return { run, report: readJson(path.join(run, "report.json")) as RunReport };
}

function matchReusableCases(cases: BatchCase[], prior: BatchInputs, root: string) {
  const fingerprints = new Set(cases.map((item) => item.fingerprint));
  const available = new Map(
    prior.cases
      .filter(
        (item) => fingerprints.has(item.fingerprint) && completed(caseDirectory(root, item.id)),
      )
      .map((item) => [item.id.toLowerCase(), item]),
  );
  const matches = new Map<string, BatchCase>();
  // Reserve existing IDs first so a new or renamed row cannot take their results.
  for (const item of cases) {
    const match = available.get(item.id.toLowerCase());
    if (match?.fingerprint === item.fingerprint) {
      matches.set(item.id, match);
      available.delete(match.id.toLowerCase());
    }
  }
  // Each remaining result can satisfy only one row, even for identical contracts.
  for (const item of cases) {
    if (matches.has(item.id)) continue;
    const match = [...available.values()].find((prior) => prior.fingerprint === item.fingerprint);
    if (match) {
      matches.set(item.id, match);
      available.delete(match.id.toLowerCase());
    }
  }
  return matches;
}

async function stagePreviews(directory: string): Promise<void> {
  // Reporting previews are separate from original bytes and judging panels.
  // Browsers cannot display every decoder-supported source format or .image MIME.
  for (const role of ["candidate", "reference"]) {
    await sharp(path.join(directory, "sources", `${role}.image`))
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(path.join(directory, `${role}-preview.png`));
  }
}

export function writeImageBatchReport(root: string, results: CaseResult[]): void {
  const passed = results.filter((r) => r.status === "complete" && !r.failures?.length).length;
  const finished = results.filter((r) => r.status === "complete").length;
  const errors = results.filter((r) => r.status === "error").length;
  const summary = {
    version: 1,
    passed,
    completed: finished,
    total: results.length,
    failedOrInconclusive: finished - passed,
    errors,
    pending: results.length - finished - errors,
    accepted: passed === results.length,
    comparisons: results,
  };
  writeJson(path.join(root, "report.json"), summary);
  const e = escapeHtml;
  const href = (file: string) =>
    path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
  const cards = results
    .map((row) => {
      const child = caseDirectory(root, row.id);
      const report = row.run
        ? `<p><a href="${e(href(path.join(root, row.run, "report.html")))}">Full evidence, individual votes and reasoning</a></p>`
        : "";
      const items =
        row.report?.areas
          .flatMap((a) => a.items)
          .map(
            (item) =>
              `<li><strong>${e(item.id)}: ${e(item.verdict)}</strong><p>${e(item.reasoning)}</p>${
                item.votes
                  ? `<p>Votes: ${e(
                      Object.entries(item.votes.counts)
                        .map(([outcome, count]) => `${outcome}: ${count}`)
                        .join(" · "),
                    )} (${item.votes.judgeable}/${item.votes.attempted} judgeable)</p>`
                  : ""
              }</li>`,
          )
          .join("") ?? "";
      return `<article><h2>${e(row.label)}</h2><p>${e(row.status)}${row.status === "complete" ? (row.failures?.length ? " — failed or inconclusive" : " — passed") : ""}${row.reusedFrom ? " · retained from an identical prior comparison" : ""}</p>
      <p><strong>Criterion:</strong> ${e(row.criterion)}</p>${row.absoluteCriterion ? `<p><strong>Quality gate:</strong> ${e(row.absoluteCriterion)}</p>` : ""}
      ${row.error ? `<p role="alert">${e(row.error)}</p>` : ""}
      <div class="images">${["reference", "candidate"].map((role) => `<figure><figcaption>${role}</figcaption><img loading="lazy" src="${e(href(path.join(child, `${role}-preview.png`)))}" alt="${role}: ${e(row.label)}"><p><a href="${e(href(path.join(child, "sources", `${role}.image`)))}" download="${e(`${row.id}-${role}.image`)}">Download original</a></p></figure>`).join("")}</div>
      ${report}<ul>${items}</ul></article>`;
    })
    .join("\n");
  fs.writeFileSync(
    path.join(root, "report.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Image comparison batch</title><style>
  *{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;color:#182230;background:#f6f8fa;margin:0;padding:24px;overflow-wrap:break-word}main{max-width:1280px;margin:auto}article{background:white;border:1px solid #d0d7de;border-radius:12px;padding:20px;margin:24px 0}.images{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{min-width:0;margin:0}img{width:100%;height:auto;border:1px solid #d0d7de}figcaption{font-weight:600;margin-bottom:8px}a{color:#1257b0}li p{white-space:pre-wrap}@media(max-width:700px){body{padding:12px}.images{grid-template-columns:1fr}article{padding:14px}}</style></head><body><main><h1>Image comparison batch</h1><p>${passed}/${results.length} passed · ${finished - passed} failed or inconclusive · ${errors} execution errors · ${summary.pending} pending</p><p>${summary.accepted ? "All comparisons passed their configured gates." : "The batch has not passed all configured gates."} Visual votes assess the supplied pixels and criteria; they do not establish application behavior.</p><p><a href="report.json">JSON results</a></p>${cards}</main></body></html>`,
  );
}

export async function imageBatchCommand(flags: Record<string, string | boolean>): Promise<void> {
  const string = (name: string): string | undefined => {
    const value = flags[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} requires a value`);
    return value;
  };
  const resume = string("resume");
  if (resume && Object.keys(flags).some((key) => !["resume", "debug"].includes(key)))
    throw new Error("image batch --resume restores saved inputs; supply only --resume <directory>");
  if (flags.json && !flags["dry-run"]) throw new Error("--json requires --dry-run");
  let root: string, inputs: BatchInputs;
  if (resume) {
    root = path.resolve(resume);
    inputs = loadBatch(root);
  } else {
    const manifestFile = string("manifest");
    if (!manifestFile)
      throw new Error("image batch requires --manifest <file.json> or --resume <directory>");
    const manifest = imageBatchManifestSchema.parse(readJson(path.resolve(manifestFile)));
    const concurrency = Number(string("concurrency") ?? 2);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error("--concurrency must be an integer from 1 to 8");
    const base = path.dirname(path.resolve(manifestFile));
    // Preflight the entire manifest before writing output or starting model calls.
    const options = manifest.comparisons.map(({ id: _id, label: _label, ...row }) =>
      directImageOptionsSchema.parse({
        ...manifest.defaults,
        ...row,
        candidate: path.resolve(base, row.candidate),
        reference: path.resolve(base, row.reference),
      }),
    );
    const plans: Plan[] = [];
    for (const item of options) plans.push((await prepareImageComparison(item)).plan);
    const output = string("output");
    if (output && fs.existsSync(path.resolve(output)))
      throw new Error(`Refusing to overwrite output directory: ${output}`);
    if (flags["dry-run"]) {
      console.log(
        flags.json
          ? JSON.stringify({ version: 1, concurrency, comparisons: plans }, null, 2)
          : `${plans.length} image comparisons; concurrency ${concurrency}. No output or provider calls created.`,
      );
      return;
    }
    const versions = new Map<string, string>();
    const cases: BatchCase[] = plans.map((plan, i) => {
      let version = versions.get(plan.judge.provider);
      if (!version) {
        version = providerVersion(plan.judge.provider);
        versions.set(plan.judge.provider, version);
      }
      const row = manifest.comparisons[i]!;
      return {
        id: row.id,
        label: row.label ?? row.id,
        fingerprint: fingerprint(plan, version),
        plan,
      };
    });
    const reuse = string("reuse");
    const priorRoot = reuse ? path.resolve(reuse) : undefined;
    if (priorRoot && fs.existsSync(path.join(priorRoot, ".run.lock")))
      throw new Error(`Prior batch is locked: ${priorRoot}; wait for its writer to exit`);
    const prior = priorRoot ? loadBatch(priorRoot) : undefined;
    if (
      priorRoot &&
      isWithin(
        fs.realpathSync(priorRoot),
        prospectiveRealPath(output ?? path.resolve(".agent-eval/image-batches")),
      )
    )
      throw new Error(
        "Image batch output must be outside the reused batch; choose a sibling directory",
      );
    const matches =
      prior && priorRoot
        ? matchReusableCases(cases, prior, priorRoot)
        : new Map<string, BatchCase>();
    inputs = {
      version: 1,
      kitVersion: KIT_VERSION,
      methodVersion: VISUAL_METHOD_VERSION,
      concurrency,
      cases,
    };
    throwIfCancelled();
    if (output) {
      root = path.resolve(output);
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.mkdirSync(root);
    } else root = createTimestampedDirectory(path.resolve(".agent-eval/image-batches"));
    console.log(`Batch: ${root}`);
    for (let i = 0; i < cases.length; i++) {
      const item = cases[i]!,
        destination = caseDirectory(root, item.id);
      const match = matches.get(item.id);
      if (match) {
        const source = caseDirectory(priorRoot!, match.id);
        fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
        item.reusedFrom = source;
        // Add report previews without altering sealed evidence or verdicts.
        await stagePreviews(destination);
        writeArtifactIndex(destination);
      } else {
        const prepared = await prepareImageComparison(options[i]!);
        if (stableJson(prepared.plan) !== stableJson(item.plan))
          throw new Error(`Image inputs changed during preparation: ${item.id}`);
        fs.mkdirSync(destination, { recursive: true });
        stageImageComparison(prepared, destination);
        await stagePreviews(destination);
      }
    }
    writeJson(path.join(root, inputFile), inputs);
    writeJson(path.join(root, inputIndex), createArtifactIndex(root));
  }
  await withRunLock(
    root,
    async () => {
      // Matching versions/settings are part of the reuse and resume contract.
      const versions = new Map<string, string>();
      for (const item of inputs.cases) {
        const provider = item.plan.judge.provider;
        let version = versions.get(provider);
        if (!version) {
          version = providerVersion(provider);
          versions.set(provider, version);
        }
        if (fingerprint(item.plan, version) !== item.fingerprint)
          throw new Error(`Image comparison runtime changed: ${item.id}; start a new batch`);
      }
      // A live checkpoint is incomplete until the queue drains. Keep the input
      // index and completed vote seals authoritative through interrupted updates.
      fs.rmSync(path.join(root, "artifact-index.json"), { force: true });
      const results: CaseResult[] = inputs.cases.map((item) => ({
        id: item.id,
        label: item.label,
        status: "pending",
        criterion: item.plan.criterion,
        ...(item.plan.absoluteCriterion ? { absoluteCriterion: item.plan.absoluteCriterion } : {}),
        ...(item.reusedFrom ? { reusedFrom: item.reusedFrom } : {}),
      }));
      const save = () => writeImageBatchReport(root, results);
      const recordCompleted = (row: CaseResult, run: string, report: RunReport) => {
        row.status = "complete";
        row.run = path.relative(root, run);
        row.report = report;
        row.failures = evaluateCiThresholds(report, {});
      };
      try {
        const pending: Array<{ item: BatchCase; index: number }> = [];
        // Retained outcomes must remain visible even if the queue stops before their rows.
        for (const [index, item] of inputs.cases.entries()) {
          const row = results[index]!;
          try {
            const result = completed(caseDirectory(root, item.id));
            if (result) recordCompleted(row, result.run, result.report);
            else pending.push({ item, index });
          } catch (error) {
            row.status = "error";
            row.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        }
        save();
        await mapConcurrent(pending, inputs.concurrency, async ({ item, index }) => {
          const directory = caseDirectory(root, item.id),
            row = results[index]!;
          try {
            const configFile = path.join(directory, "evalkit.yaml"),
              config = loadResolvedConfig(configFile);
            let existing = runDirectory(directory);
            if (existing && !fs.existsSync(path.join(existing, "run-state.json"))) {
              // Reclaim only an empty reservation; rmdir refuses any unknown artifacts.
              fs.rmdirSync(existing);
              existing = undefined;
            }
            const run = await runEvaluation({
              config,
              configFile,
              specs: loadSpecs(config.paths.specs),
              fixtures: {},
              split: "all",
              ...(existing ? { resumeDir: existing } : {}),
            });
            if (!run.report) throw new Error(`No report for ${item.id}`);
            writeArtifactIndex(directory);
            recordCompleted(row, run.runDir, run.report);
          } catch (error) {
            row.status = "error";
            row.error = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            save();
          }
        });
      } finally {
        save();
        writeArtifactIndex(root);
        console.log(
          `Batch report: ${path.join(root, "report.html")}\nResume: aek image batch --resume '${root.replaceAll("'", "'\\''")}'`,
        );
      }
      if (results.some((r) => r.status !== "complete" || r.failures?.length)) process.exitCode = 2;
    },
    { recoverStale: false },
  );
}
