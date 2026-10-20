import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withCancellation } from "./cancellation.js";
import { spawnCaptured } from "./providers/process.js";
import { withRunLock } from "./run/state.js";
import { buildCampaignReport, writeCampaignArtifacts, type CampaignRunRecord } from "./campaign.js";
import { compareBenchmarkCampaigns, writeBenchmarkComparison } from "./benchmark.js";
import { escapeHtml } from "./report-presentation.js";
import { writeJson } from "./io.js";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const benchmarkExperimentSchema = z
  .object({
    version: z.literal(1),
    candidates: z
      .record(name, z.string().min(1))
      .refine((value) => Object.keys(value).length >= 2, "Declare at least two candidates"),
    baseline: name,
    blocks: z.array(z.array(name).min(2)).min(2),
    resource: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(86400),
    measurement: z.object({ scenarioId: z.string().min(1), fileLabel: z.string().min(1) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = Object.keys(value.candidates).sort();
    if (!ids.includes(value.baseline))
      context.addIssue({ code: "custom", message: "Baseline must name a candidate" });
    for (const block of value.blocks) {
      if (JSON.stringify([...block].sort()) !== JSON.stringify(ids))
        context.addIssue({
          code: "custom",
          message: "Each block must visit every candidate exactly once",
        });
    }
  });
export type BenchmarkExperiment = z.infer<typeof benchmarkExperimentSchema>;

/** Explicit alternating forward/reverse blocks; acquisition remains serial. */
export function counterbalancedBlocks(candidates: string[], repetitions: number): string[][] {
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 2 ||
    candidates.length < 2 ||
    new Set(candidates).size !== candidates.length
  )
    throw new Error("Use at least two distinct candidates and two repetitions");
  return Array.from({ length: repetitions }, (_, i) =>
    i % 2 ? [...candidates].reverse() : [...candidates],
  );
}

interface Visit {
  block: number;
  candidate: string;
  status: "running" | "complete" | "error";
  runDir?: string;
  error?: string;
}

/**
 * Run an explicit multi-candidate experiment using ordinary AEK evaluations.
 * The shared resource lock spans acquisition and cleanup, across output paths.
 * Interrupted/failed visits stay visible; later visits never start on error.
 */
export async function runBenchmarkExperiment(
  output: string,
  definition: unknown,
  options: { baseDirectory?: string; signal?: AbortSignal } = {},
) {
  const recipe = benchmarkExperimentSchema.parse(definition);
  const base = path.resolve(options.baseDirectory ?? process.cwd());
  let resource = path.resolve(base, recipe.resource);
  output = path.resolve(output);
  fs.mkdirSync(resource, { recursive: true });
  resource = fs.realpathSync(resource);
  const environment = { ...process.env };
  // Resolve the packaged worker even when a development TS loader imports this
  // module from src/. Tests build the same distribution before execution.
  const worker = fileURLToPath(
    new URL(
      "./benchmark-experiment-worker.js",
      import.meta.resolve("agent-eval-kit/benchmark/experiment"),
    ),
  );
  const request = (id: string, file: string) => ({
    configFile: path.resolve(base, file),
    output,
    candidate: id,
    measurement: recipe.measurement,
  });
  return withRunLock(resource, async () => {
    options.signal?.throwIfAborted();
    if (fs.existsSync(output))
      throw new Error(`EEXIST: experiment output already exists: ${output}`);
    const startedAt = new Date().toISOString();
    const visits: Visit[] = [];
    const records: Record<string, CampaignRunRecord[]> = Object.fromEntries(
      Object.keys(recipe.candidates).map((id) => [id, []]),
    );
    const preflight = fs.mkdtempSync(path.join(os.tmpdir(), "aek-experiment-preflight-"));
    const prepared: Record<
      string,
      {
        invocation: ReturnType<typeof request>;
        fingerprint: string;
        project: string;
      }
    > = {};
    try {
      for (const [id, file] of Object.entries(recipe.candidates)) {
        options.signal?.throwIfAborted();
        const invocation = request(id, file);
        const result = await withCancellation(options.signal ?? new AbortController().signal, () =>
          spawnCaptured({
            command: process.execPath,
            args: [worker, JSON.stringify(invocation)],
            cwd: base,
            env: environment,
            timeoutSeconds: 60,
            stdoutFile: path.join(preflight, `${id}.stdout`),
            stderrFile: path.join(preflight, `${id}.stderr`),
          }),
        );
        if (result.exitCode !== 0 || result.signal || result.timedOut)
          throw new Error(result.stderr.trim() || `Candidate preflight failed: ${id}`);
        const candidate = JSON.parse(result.stdout) as { fingerprint: string; project: string };
        prepared[id] = { invocation, ...candidate };
      }
    } finally {
      fs.rmSync(preflight, { recursive: true, force: true });
    }
    options.signal?.throwIfAborted();
    fs.mkdirSync(output); // Preflight never occupies the requested output path.
    writeJson(path.join(output, "recipe.json"), {
      ...recipe,
      resource,
      candidates: Object.fromEntries(
        Object.entries(prepared).map(([id, entry]) => [id, entry.invocation.configFile]),
      ),
    });
    let error: string | undefined;
    const checkpoint = () =>
      writeJson(path.join(output, "experiment.json"), {
        version: 1,
        startedAt,
        blocks: recipe.blocks,
        resource,
        visits,
        ...(error ? { error } : {}),
      });
    checkpoint();
    acquisition: for (const [index, block] of recipe.blocks.entries()) {
      for (const id of block) {
        const visit: Visit = { block: index + 1, candidate: id, status: "running" };
        visits.push(visit);
        checkpoint();
        const entry = prepared[id]!;
        const timeout = AbortSignal.timeout(recipe.timeoutSeconds * 1000);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        try {
          signal.throwIfAborted();
          const resultFile = path.join(output, "visits", `${index + 1}-${id}.json`);
          const child = await withCancellation(signal, () =>
            spawnCaptured({
              command: process.execPath,
              args: [
                worker,
                JSON.stringify({
                  ...entry.invocation,
                  block: index + 1,
                  fingerprint: entry.fingerprint,
                  resultFile,
                }),
              ],
              cwd: base,
              env: environment,
              timeoutSeconds: recipe.timeoutSeconds,
              stdoutFile: resultFile + ".stdout",
              stderrFile: resultFile + ".stderr",
              onLine(stream, line) {
                if (stream === "stdout" && line.startsWith("AEK_EXPERIMENT_RUN:")) {
                  const created = JSON.parse(line.slice("AEK_EXPERIMENT_RUN:".length)) as {
                    runDir: string;
                  };
                  visit.runDir = created.runDir;
                  checkpoint();
                }
              },
            }),
          );
          signal.throwIfAborted();
          const result = fs.existsSync(resultFile)
            ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
                record?: CampaignRunRecord;
                error?: string;
              })
            : undefined;
          if (child.exitCode !== 0 || child.signal || child.timedOut || !result?.record)
            throw new Error(
              result?.error ?? `Candidate process failed: ${id}; see ${resultFile}.stderr`,
            );
          records[id]!.push(result.record);
          visit.status = "complete";
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          visit.status = "error";
          visit.error = error;
          records[id]!.push({
            ordinal: index + 1,
            status: "failed",
            error,
            ...(visit.runDir ? { runDir: visit.runDir } : {}),
          });
        }
        checkpoint();
        if (error) break acquisition;
      }
    }
    for (const [id, runs] of Object.entries(records)) {
      writeCampaignArtifacts(
        path.join(output, "campaigns", id),
        buildCampaignReport({
          campaignId: id,
          project: prepared[id]!.project,
          startedAt,
          plannedRepetitions: recipe.blocks.length,
          runs,
        }),
      );
    }
    const comparisons = Object.keys(prepared)
      .filter((id) => id !== recipe.baseline)
      .map((id) => {
        const directory = path.join(output, "comparisons", id);
        const comparison = compareBenchmarkCampaigns(
          path.join(output, "campaigns", recipe.baseline),
          path.join(output, "campaigns", id),
          recipe.measurement,
        );
        writeBenchmarkComparison(directory, comparison);
        const pairs = comparison.measurements.map((metric) => ({
          id: metric.id,
          unit: metric.unit,
          scope: metric.scope,
          blocks: recipe.blocks.map((_, index) => {
            const before = metric.baseline.runs.find((run) => run.ordinal === index + 1);
            const after = metric.candidate.runs.find((run) => run.ordinal === index + 1);
            const delta =
              comparison.validity.status === "compatible" && before && after
                ? after.mean - before.mean
                : null;
            return {
              block: index + 1,
              baseline: before?.mean ?? null,
              candidate: after?.mean ?? null,
              delta,
            };
          }),
        }));
        writeJson(path.join(directory, "paired-differences.json"), {
          pairs,
          limitation:
            "Descriptive within-block differences; no statistical confidence or automatic performance acceptance.",
        });
        return {
          candidate: id,
          outcome: comparison.outcome,
          report: path.relative(output, path.join(directory, "benchmark-comparison.html")),
        };
      });
    const outcome =
      error || comparisons.some((c) => c.outcome === "execution_error")
        ? "execution_error"
        : comparisons.some((c) => c.outcome === "requirement_failure")
          ? "requirement_failure"
          : comparisons.some((c) => c.outcome !== "compared")
            ? "inconclusive"
            : "compared";
    const unattempted = recipe.blocks.flatMap((block, index) =>
      block
        .filter((id) => !visits.some((v) => v.block === index + 1 && v.candidate === id))
        .map((candidate) => ({ block: index + 1, candidate })),
    );
    const summary = { outcome, visits, unattempted, comparisons, ...(error ? { error } : {}) };
    writeJson(path.join(output, "summary.json"), summary);
    fs.writeFileSync(
      path.join(output, "experiment.html"),
      `<!doctype html><meta charset="utf-8"><title>Benchmark experiment</title><h1>${escapeHtml(outcome)}</h1><p>Serial acquisition; one visit per candidate in each block. Application timings remain separate from AEK duration.</p><ol>${recipe.blocks.map((block) => `<li>${block.map(escapeHtml).join(" → ")}</li>`).join("")}</ol><p>${escapeHtml(error ?? "")}</p><ul>${comparisons.map((c) => `<li><a href="${escapeHtml(c.report)}">${escapeHtml(c.candidate)}</a>: ${escapeHtml(c.outcome)}</li>`).join("")}</ul><p>Unattempted visits: ${unattempted.length}. <a href="experiment.json">Acquisition ledger</a> · <a href="summary.json">Summary</a></p>`,
    );
    return summary;
  });
}
