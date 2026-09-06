import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../io.js";
import { throwIfCancelled } from "../cancellation.js";
import type { EvalSpec, JudgedItem, ScenarioEvidence } from "../types.js";
import { visualEvidenceReader } from "./inputs.js";
import { imageSignature, inspectImage, signatureDistance, sourceImage } from "./images.js";
import { evaluateStatistics, type StatisticSample } from "./statistics.js";
import { diagnosticHtml, type DiagnosticTable } from "./report.js";

export async function judgeVisualChecks(options: {
  spec: EvalSpec;
  evidence: ScenarioEvidence[];
  runDir: string;
  areaDirectory: string;
  onProgress?: (message: string) => void;
}): Promise<JudgedItem[]> {
  const items = options.spec.rubric.filter(
    (item) => item.grader.type === "image-distinctness" || item.grader.type === "image-regression",
  );
  if (!items.length) return [];
  const reader = visualEvidenceReader(options.runDir),
    results: JudgedItem[] = [];
  for (const item of items) {
    throwIfCancelled();
    const grader = item.grader;
    if (grader.type !== "image-distinctness" && grader.type !== "image-regression")
      throw new Error(`Unexpected deterministic visual grader: ${grader.type}`);
    options.onProgress?.(`${grader.type} ${item.id}`);
    if (grader.type === "image-distinctness" && item.scenarios.length > 100)
      throw new Error(`${item.id}: image-distinctness is limited to 100 scenarios per group`);
    const directory = path.join(options.areaDirectory, grader.type, item.id);
    fs.mkdirSync(directory, { recursive: true });
    const candidates = item.scenarios.map((id) => ({ id }));
    const evidenceRefs: string[] = [],
      missing: string[] = [];
    // Retain only small signatures, not every full-resolution source image.
    const readCandidate = (id: string) => {
      throwIfCancelled();
      const image = reader.candidate(
        options.evidence.find((scenario) => scenario.scenarioId === id),
        grader.candidate,
      );
      if (image) evidenceRefs.push(image.ref);
      else missing.push(id);
      return image;
    };
    const pictures: Array<{ label: string; file: string }> = [];
    const tables: DiagnosticTable[] = [];
    let verdict: JudgedItem["verdict"], reasoning: string, diagnostics: unknown;
    if (grader.type === "image-distinctness") {
      const signatures = new Map<string, Buffer>();
      for (const [index, candidate] of candidates.entries()) {
        const image = readCandidate(candidate.id);
        if (!image) continue;
        const source = await sourceImage(image.bytes, grader.crop);
        const file = `candidate-${index + 1}.png`;
        fs.writeFileSync(path.join(directory, file), source);
        pictures.push({ label: candidate.id, file });
        signatures.set(candidate.id, await imageSignature(source));
      }
      const pairs: Array<{
        left: string;
        right: string;
        distance: number | null;
        minimumDistance: number;
        pass: boolean | null;
      }> = [];
      for (let i = 0; i < candidates.length; i++)
        for (let j = i + 1; j < candidates.length; j++) {
          const left = signatures.get(candidates[i].id),
            right = signatures.get(candidates[j].id);
          const distance = left && right ? signatureDistance(left, right) : null;
          pairs.push({
            left: candidates[i].id,
            right: candidates[j].id,
            distance,
            minimumDistance: grader.minimumDistance,
            pass: distance === null ? null : distance >= grader.minimumDistance,
          });
        }
      tables.push({
        caption: "Distinctness comparisons",
        columns: ["Left", "Right", "RGB distance", "Minimum", "Result"],
        rows: pairs.map((pair) => [
          pair.left,
          pair.right,
          pair.distance,
          pair.minimumDistance,
          pair.pass === null ? "unavailable" : pair.pass ? "pass" : "fail",
        ]),
      });
      verdict =
        !pairs.length || missing.length
          ? "cannot_judge"
          : pairs.every((pair) => pair.pass)
            ? "pass"
            : "fail";
      reasoning = `${pairs.filter((pair) => pair.pass !== null).length}/${pairs.length} distinctness comparisons available; ${pairs.filter((pair) => pair.pass === false).length} below minimumDistance ${grader.minimumDistance}.${missing.length ? ` Missing evidence: ${missing.join(", ")}.` : ""}${!pairs.length ? " At least two selected captures are needed." : ""}`;
      diagnostics = {
        method: "mean_absolute_rgb_32x32",
        crop: grader.crop,
        expectedScenarios: item.scenarios,
        missing,
        pairs,
        verdict,
        note: "RGB thumbnails retain color but discard fine details and resize aspect ratios. Distinctness does not prove correct setup.",
      };
    } else {
      const samples: StatisticSample[] = [];
      for (const [index, candidate] of candidates.entries()) {
        const image = readCandidate(candidate.id);
        const reference = reader.reference(`${item.id}/${candidate.id}/0`);
        const before = await inspectImage(reference.bytes, grader);
        if (!image) {
          samples.push({
            id: candidate.id,
            before,
            unavailable: "Candidate screenshot missing or scenario not completed",
          });
          continue;
        }
        const after = await inspectImage(image.bytes, grader);
        if (before.width !== after.width || before.height !== after.height)
          throw new Error(
            `${item.id}/${candidate.id}: baseline and candidate crop dimensions differ; use matching capture geometry`,
          );
        samples.push({ id: candidate.id, before, after });
        for (const [label, bytes] of [
          ["candidate", image.bytes],
          ["baseline", reference.bytes],
        ] as const) {
          const file = `${label}-${index + 1}.png`;
          fs.writeFileSync(path.join(directory, file), await sourceImage(bytes, grader.crop));
          pictures.push({ label: `${candidate.id} ${label}`, file });
        }
      }
      const evaluated = evaluateStatistics(samples, grader.metrics);
      tables.push({
        caption: "Configured statistic checks",
        columns: ["Metric", "Scene / aggregate", "Change", "Bounds", "Result"],
        rows: evaluated.checks.map((check) => [
          check.metric,
          check.scope,
          check.actual,
          JSON.stringify(check.expected),
          check.pass === null ? "unavailable" : check.pass ? "pass" : "fail",
        ]),
      });
      tables.push({
        caption: "Complete cohort summaries",
        columns: ["Metric", "Change type", "Available / expected", "Mean", "Minimum", "Maximum"],
        rows: Object.entries(evaluated.axes).map(([metric, axis]) => [
          metric,
          axis.change,
          `${axis.samples}/${axis.expectedSamples}`,
          axis.mean,
          axis.minimum,
          axis.maximum,
        ]),
      });
      tables.push({
        caption: "Per-scene measurements",
        columns: [
          "Metric",
          "Scene",
          "Baseline",
          "Candidate",
          "Absolute change",
          "Relative change",
          "Unavailable reason",
        ],
        rows: Object.entries(evaluated.axes).flatMap(([metric, axis]) =>
          axis.scenes.map((scene) => [
            metric,
            scene.id,
            scene.before,
            scene.after,
            scene.absolute,
            scene.relative,
            scene.unavailable ?? "",
          ]),
        ),
      });
      verdict = evaluated.verdict;
      reasoning = `${evaluated.availableImages}/${evaluated.expectedSamples} matched baseline images; ${evaluated.checks.filter((check) => check.pass === false).length} statistic bounds failed, ${evaluated.checks.filter((check) => check.pass === null).length} unavailable. Statistics are project-defined assertions, not general quality scores.`;
      diagnostics = {
        ...evaluated,
        baseline: grader.baseline,
        crop: grader.crop,
        darkLevel: grader.darkLevel,
        highlightLevel: grader.highlightLevel,
      };
    }
    writeJson(path.join(directory, "diagnostics.json"), diagnostics);
    fs.writeFileSync(
      path.join(directory, "comparison.html"),
      diagnosticHtml({ id: item.id, verdict, reasoning, diagnostics, pictures, tables }),
    );
    results.push({
      id: item.id,
      source: grader.type,
      verdict,
      confidence: verdict === "cannot_judge" ? "low" : "high",
      reasoning,
      evidenceRefs,
      comparisons: [
        path
          .relative(options.runDir, path.join(directory, "comparison.html"))
          .split(path.sep)
          .join("/"),
      ],
    });
  }
  return results;
}
