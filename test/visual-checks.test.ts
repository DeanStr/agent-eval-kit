import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import YAML from "yaml";
import {
  captureSchema,
  distinctnessSchema,
  imageHealthSchema,
  imageRegressionSchema,
} from "../src/visual/contracts.js";
import {
  compareImages,
  imageSignature,
  inspectImage,
  signatureDistance,
  type ImageStatistics,
} from "../src/visual/images.js";
import { evaluateStatistics } from "../src/visual/statistics.js";
import { judgeVisualChecks } from "../src/visual/deterministic.js";
import { writeArtifactIndex } from "../src/integrity.js";
import { sha256, writeJson } from "../src/io.js";
import { visualInputPath } from "../src/visual/inputs.js";
import { loadSpecs, materializeSpec } from "../src/specs.js";
import type { EvalSpec, ScenarioEvidence } from "../src/types.js";

const pixels = (values: number[], width: number) =>
  sharp(Buffer.from(values), { raw: { width, height: values.length / width, channels: 1 } })
    .png()
    .toBuffer();
const stats = (value: number): ImageStatistics => ({
  width: 10,
  height: 10,
  entropy: value,
  stdev: value,
  gradientEnergy: value,
  darkPixelFraction: 0,
  highlightPixelFraction: 0,
  largestDarkRegionFraction: 0,
  largestHighlightRegionFraction: 0,
});

test("image health measures connected regions, not just dark/highlight totals, and crops source pixels", async () => {
  const joined = await inspectImage(await pixels([0, 0, 255, 255, 0, 0, 255, 255], 4));
  const scattered = await inspectImage(await pixels([0, 255, 0, 255, 255, 0, 255, 0], 4));
  assert.equal(joined.darkPixelFraction, 0.5);
  assert.equal(scattered.darkPixelFraction, 0.5);
  assert.equal(joined.largestDarkRegionFraction, 0.5);
  assert.equal(scattered.largestDarkRegionFraction, 0.125, "diagonal neighbors are not connected");
  assert.equal(joined.largestHighlightRegionFraction, 0.5);
  assert.equal(scattered.largestHighlightRegionFraction, 0.125);
  const cropped = await inspectImage(await pixels([0, 0, 255, 255], 4), {
    crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
  });
  assert.equal(cropped.width, 2);
  assert.equal(cropped.highlightPixelFraction, 1);
  assert.equal(cropped.darkPixelFraction, 0);
  const boundary = await inspectImage(await pixels([8, 9, 246, 247], 4));
  assert.equal(boundary.darkPixelFraction, 0.25);
  assert.equal(boundary.highlightPixelFraction, 0.25);
  await assert.rejects(
    inspectImage(await pixels([0], 1), { darkLevel: 250, highlightLevel: 240 }),
    /Image levels/,
  );
});

test("RGB distinctness retains color and configured crop controls the comparison", async () => {
  const red = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ff0000" } })
    .png()
    .toBuffer();
  const green = await sharp({
    create: { width: 20, height: 10, channels: 3, background: "#00ff00" },
  })
    .png()
    .toBuffer();
  assert.equal(signatureDistance(await imageSignature(red), await imageSignature(red)), 0);
  assert.ok(signatureDistance(await imageSignature(red), await imageSignature(green)) > 0.6);
  const left = await pixels([0, 255], 2),
    right = await pixels([0, 0], 2);
  assert.ok(signatureDistance(await imageSignature(left), await imageSignature(right)) > 0.4);
  const crop = { x: 0, y: 0, width: 0.5, height: 1 };
  assert.equal(
    signatureDistance(await imageSignature(left, crop), await imageSignature(right, crop)),
    0,
  );
  assert.throws(() => signatureDistance(Buffer.alloc(1), Buffer.alloc(1)), /32×32/);
});

test("repeatability and movement tolerances are independent and small pixel deltas can be ignored", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-tolerances-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const left = path.join(root, "left.png"),
    right = path.join(root, "right.png");
  fs.writeFileSync(left, await pixels([100, 100], 2));
  fs.writeFileSync(right, await pixels([101, 100], 2));
  const capture = captureSchema.parse({
    frames: 2,
    channelTolerance: 0,
    movementChannelTolerance: 2,
  });
  assert.equal((await compareImages(left, right, capture.channelTolerance)).changedPixelRatio, 0.5);
  assert.equal(
    (await compareImages(left, right, capture.movementChannelTolerance)).changedPixelRatio,
    0,
  );
  assert.equal(
    captureSchema.parse({ channelTolerance: 5 }).movementChannelTolerance,
    0,
    "no fallback to repeatability tolerance",
  );
});

test("statistic bounds retain individual regressions, complete cohorts, and near-zero uncertainty", () => {
  const grader = imageRegressionSchema.parse({
    type: "image-regression",
    candidate: "frame-001",
    baseline: "approved",
    metrics: { entropy: { mean: { min: -0.08 }, perScene: { min: -0.2 } } },
  });
  const samples = [
    { id: "bad", before: stats(4), after: stats(2) },
    { id: "good", before: stats(4), after: stats(6) },
  ];
  const evaluated = evaluateStatistics(samples, grader.metrics);
  assert.equal(evaluated.verdict, "fail");
  assert.equal(requireDefined(evaluated.axes.entropy, "evaluated.axes.entropy").mean, 0);
  assert.equal(evaluated.checks.find((check) => check.scope === "bad")?.actual, -0.5);
  const missing = evaluateStatistics(
    [requireDefined(samples[0], "samples[0]"), { id: "missing", before: stats(4) }],
    grader.metrics,
  );
  assert.equal(missing.verdict, "cannot_judge");
  assert.equal(requireDefined(missing.axes.entropy, "missing.axes.entropy").mean, null);
  assert.equal(requireDefined(missing.axes.entropy, "missing.axes.entropy").samples, 1);
  assert.equal(requireDefined(missing.axes.entropy, "missing.axes.entropy").expectedSamples, 2);
  const zero = evaluateStatistics(
    [{ id: "zero", before: stats(0), after: stats(0) }],
    grader.metrics,
  );
  assert.equal(zero.verdict, "cannot_judge");
  assert.match(
    requireDefined(
      requireDefined(zero.axes.entropy, "zero.axes.entropy").scenes[0],
      "zero.axes.entropy.scenes[0]",
    ).unavailable!,
    /minimumBaseline/,
  );
  const near = evaluateStatistics(
    [{ id: "near", before: stats(0.00000001), after: stats(0.00000002) }],
    grader.metrics,
  );
  assert.equal(near.verdict, "cannot_judge");
  const absolute = imageRegressionSchema.parse({
    ...grader,
    metrics: { entropy: { change: "absolute", perScene: { min: -0.1, max: 0.1 } } },
  });
  assert.equal(
    evaluateStatistics([{ id: "zero", before: stats(0), after: stats(0) }], absolute.metrics)
      .verdict,
    "pass",
  );
  assert.equal(
    evaluateStatistics([{ id: "up", before: stats(0), after: stats(1) }], absolute.metrics).verdict,
    "fail",
  );
  assert.throws(
    () => evaluateStatistics([{ id: "broken", before: stats(NaN), after: stats(1) }]),
    /Invalid image statistics/,
  );
});

test("visual contracts require explicit bounds, distinct groups and valid image policies", async (t) => {
  assert.throws(() => imageHealthSchema.parse({ metrics: {} }));
  assert.throws(() =>
    imageHealthSchema.parse({
      darkLevel: 250,
      highlightLevel: 240,
      metrics: { entropy: { min: 1 } },
    }),
  );
  assert.throws(() => imageHealthSchema.parse({ metrics: { invented: { max: 1 } } }));
  assert.throws(() =>
    distinctnessSchema.parse({
      type: "image-distinctness",
      candidate: "frame",
      minimumDistance: 0,
    }),
  );
  assert.throws(
    () =>
      imageRegressionSchema.parse({
        type: "image-regression",
        candidate: "frame",
        baseline: "base",
        metrics: { entropy: {} },
      }),
    /explicit/,
  );
  assert.throws(() =>
    imageRegressionSchema.parse({
      type: "image-regression",
      candidate: "frame",
      baseline: "base",
      metrics: { entropy: { perScene: { min: 2, max: 1 } } },
    }),
  );
  assert.throws(() => captureSchema.parse({ movementCrop: { x: 0, y: 0, width: 1, height: 1 } }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-distinct-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "spec.yaml");
  const raw = {
    id: "area",
    title: "Area",
    description: "Image checks",
    weight: 100,
    scenarios: [{ id: "scene", name: "Scene", instructions: "Capture" }],
    rubric: [
      {
        id: "DISTINCT",
        criterion: "Views differ",
        weight: 1,
        scenarios: ["scene"],
        passCriteria: "Different",
        grader: { type: "image-distinctness", candidate: "frame", minimumDistance: 0.01 },
      },
    ],
  };
  fs.writeFileSync(file, YAML.stringify(raw));
  assert.throws(() => loadSpecs(file), /2–100/);
  fs.writeFileSync(
    file,
    YAML.stringify({
      ...raw,
      scenarios: [
        {
          ...requireDefined(raw.scenarios[0], "raw.scenarios[0]"),
          cases: [
            { id: "a", split: "development" },
            { id: "b", split: "evaluation" },
          ],
        },
      ],
    }),
  );
  const spec = requireDefined(loadSpecs(file)[0], "loadSpecs(file)[0]");
  assert.deepEqual(
    requireDefined(materializeSpec(spec).rubric[0], "materializeSpec(spec).rubric[0]").scenarios,
    ["scene--a", "scene--b"],
  );
  assert.deepEqual(
    requireDefined(
      materializeSpec(spec, "evaluation").rubric[0],
      'materializeSpec(spec, "evaluation").rubric[0]',
    ).scenarios,
    ["scene--b"],
  );
});

test("deterministic visual graders use sealed inputs, preserve missing coverage and report offending pairs", async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "aek-deterministic-"));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const bytes = await pixels([0, 255, 0, 255], 2);
  const evidence = ["a", "b"].map((id) => {
    fs.mkdirSync(path.join(runDir, id));
    fs.writeFileSync(path.join(runDir, id, "frame.png"), bytes);
    return {
      scenarioId: id,
      outcome: "completed",
      screenshots: [{ label: "frame", path: "frame.png", step: 0 }],
    } as ScenarioEvidence;
  });
  const visual: Record<string, { sha256: string; bytes: number }> = {};
  for (const id of ["a", "b"]) {
    const key = `STATS/${id}/0`,
      file = visualInputPath(runDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    visual[key] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  writeJson(path.join(runDir, "receipt.json"), { inputs: { visual } });
  writeArtifactIndex(runDir);
  const spec = {
    id: "area",
    rubric: [
      {
        id: "DISTINCT",
        scenarios: ["a", "b"],
        grader: distinctnessSchema.parse({
          type: "image-distinctness",
          candidate: "frame",
          minimumDistance: 0.001,
        }),
      },
      {
        id: "STATS",
        scenarios: ["a", "b"],
        grader: imageRegressionSchema.parse({
          type: "image-regression",
          candidate: "frame",
          baseline: "approved",
          metrics: { entropy: { perScene: { min: -0.1 }, mean: { min: -0.1 } } },
        }),
      },
    ],
  } as EvalSpec;
  const options = { spec, evidence, runDir, areaDirectory: path.join(runDir, "areas/area") };
  const result = await judgeVisualChecks(options);
  assert.deepEqual(
    result.map((item) => item.verdict),
    ["fail", "pass"],
  );
  const report = fs.readFileSync(
    path.join(
      runDir,
      requireDefined(
        requireDefined(result[0], "result[0]").comparisons![0],
        "result[0].comparisons![0]",
      ),
    ),
    "utf8",
  );
  assert.match(report, /candidate-1.png/);
  assert.match(report, /minimumDistance/);
  const distinct = JSON.parse(
    fs.readFileSync(
      path.join(options.areaDirectory, "image-distinctness/DISTINCT/diagnostics.json"),
      "utf8",
    ),
  );
  assert.deepEqual(distinct.pairs[0], {
    left: "a",
    right: "b",
    distance: 0,
    minimumDistance: 0.001,
    pass: false,
  });
  const blocked = await judgeVisualChecks({
    ...options,
    evidence: [
      requireDefined(evidence[0], "evidence[0]"),
      { ...requireDefined(evidence[1], "evidence[1]"), outcome: "blocked" },
    ],
  });
  assert.deepEqual(
    blocked.map((item) => item.verdict),
    ["cannot_judge", "cannot_judge"],
  );
  const one = await judgeVisualChecks({
    ...options,
    spec: {
      ...spec,
      rubric: [{ ...requireDefined(spec.rubric[0], "spec.rubric[0]"), scenarios: ["a"] }],
    },
  });
  assert.equal(
    requireDefined(one[0], "one[0]").verdict,
    "cannot_judge",
    "a split leaving one capture must not pass distinctness vacuously",
  );
  await assert.rejects(
    judgeVisualChecks({
      ...options,
      evidence: [
        {
          ...requireDefined(evidence[0], "evidence[0]"),
          screenshots: [
            ...requireDefined(evidence[0], "evidence[0]").screenshots,
            ...requireDefined(evidence[0], "evidence[0]").screenshots,
          ],
        },
        requireDefined(evidence[1], "evidence[1]"),
      ],
    }),
    /Ambiguous/,
  );
  fs.writeFileSync(visualInputPath(runDir, "STATS/a/0"), await pixels([255, 0, 255, 0], 2));
  await assert.rejects(judgeVisualChecks(options), /receipt mismatch/);
  fs.writeFileSync(path.join(runDir, "a/frame.png"), await pixels([255, 255, 255, 255], 2));
  await assert.rejects(judgeVisualChecks(options), /not intact sealed evidence/);
});
