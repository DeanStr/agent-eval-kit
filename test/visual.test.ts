import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { captureSchema, captureSchedule, controlledScreenshotLabels, pairwiseSchema, votingSchema } from "../src/visual/contracts.js";
import { compareImages, contactSheet, inspectImage, normalizeImage, sourceImage } from "../src/visual/images.js";
import { decideVotes, journalVote, mapConcurrent } from "../src/visual/votes.js";
import { pairOutcome } from "../src/visual/pairwise.js";
import { metricChecks } from "../src/visual/capture.js";
import { comparisonHtml } from "../src/visual/report.js";

test("pairwise abstention cannot pass non-regression; observed equivalence can", () => {
  const policy = votingSchema.parse({});
  const raw = { preferred: "B" as const, confidence: 0.1, reasoning: "uncertain", findings: [] };
  assert.equal(pairOutcome(raw, true, policy.minimumConfidence), "abstain");
  assert.equal(pairOutcome({ ...raw, confidence: 0.9 }, true, 0.55), "loss");
  assert.equal(pairOutcome({ ...raw, confidence: 0.9 }, false, 0.55), "win");
  assert.equal(decideVotes(Array(5).fill("abstain"), policy, ["win", "equivalent"]).decision, "continue");
  const exhausted = decideVotes(Array(9).fill("abstain"), policy, ["win", "equivalent"]);
  assert.equal(exhausted.decision, "inconclusive"); assert.equal(exhausted.judgeable, 0);
  assert.equal(decideVotes(Array(5).fill("equivalent"), policy, ["win", "equivalent"]).decision, "pass");
  assert.equal(decideVotes(["win", "win", "win", "abstain", "abstain"], policy, ["win"]).decision, "continue");
  assert.equal(decideVotes(["win", "win", "win", "win", "loss"], policy, ["win"]).decision, "pass");
  assert.equal(decideVotes(Array(5).fill("equivalent"), policy, ["win"]).decision, "equivalent");
});

test("invalid voting, capture and reference contracts fail validation", () => {
  assert.throws(() => votingSchema.parse({ minimumVotes: 5, maximumVotes: 3 }));
  assert.throws(() => votingSchema.parse({ agreement: 0.5 }));
  assert.throws(() => captureSchema.parse({ minimumMovement: 0.1 }));
  assert.throws(() => captureSchema.parse({ rendererPattern: "[" }));
  assert.throws(() => pairwiseSchema.parse({ type: "pairwise", candidate: "frame-001", policy: "non_regression", references: [{ file: "a", baseline: "b" }] }));
  assert.throws(() => pairwiseSchema.parse({ type: "pairwise", candidate: "frame-001", policy: "non_regression", references: [{ baseline: "b" }] }));
  assert.throws(() => metricChecks({ queue: null }, { queue: { max: 0 } }), /missing or non-numeric/);
  assert.equal(metricChecks({ queue: 5 }, { queue: { max: 0 } })[0].pass, false);
  assert.equal(metricChecks({ queue: 0 }, { queue: { max: 0 } })[0].pass, true);
});

test("named capture checkpoints validate ordered times and stable image labels", () => {
  const checkpoints = [{ label: "before", timeSeconds: 0.9 }, { label: "at", timeSeconds: 1 }, { label: "after", timeSeconds: 1.01 }];
  const capture = captureSchema.parse({ checkpoints, minimumMovement: 0 });
  assert.deepEqual(captureSchedule(capture), checkpoints);
  assert.deepEqual(controlledScreenshotLabels(capture), ["before", "at", "after", "contact-sheet", "pass-02/before", "pass-02/at", "pass-02/after", "pass-02/contact-sheet"]);
  assert.deepEqual(captureSchedule(captureSchema.parse({})), [{ label: "frame-001", timeSeconds: 0 }]);
  for (const invalid of [
    { checkpoints, frames: 1 }, { checkpoints, stepSeconds: 1 },
    { checkpoints: [...checkpoints].reverse() },
    { checkpoints: [{ label: "a", timeSeconds: 0 }, { label: "b", timeSeconds: 0 }] },
    { checkpoints: [{ label: "a", timeSeconds: 0 }, { label: "A", timeSeconds: 1 }] },
    { checkpoints: [{ label: "contact-sheet", timeSeconds: 0 }] },
    { checkpoints: [{ label: "../escape", timeSeconds: 0 }] },
    { checkpoints: [{ label: "a", timeSeconds: -1 }] },
  ]) assert.throws(() => captureSchema.parse(invalid));
});

test("image normalization handles alpha and crops, retains deterministic pixels and exposes diagnostics", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-images-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "image.png"), normalized = path.join(root, "normalized.png");
  await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff000080" } }).png().toFile(file);
  const panel = { width: 32, height: 32, fit: "contain" as const, background: "#ffffff" };
  fs.writeFileSync(normalized, await normalizeImage(file, panel, { x: 0.25, y: 0, width: 0.5, height: 1 }));
  assert.equal((await compareImages(normalized, normalized)).changedPixelRatio, 0);
  assert.equal((await inspectImage(normalized)).entropy, 0);
  assert.equal((await sharp(normalized).metadata()).hasAlpha, false);
  await assert.rejects(compareImages(file, normalized), /dimensions differ/);
  await assert.rejects(normalizeImage(file, panel, { x: 0.8, y: 0, width: 0.5, height: 1 }), /Crop/);
  await contactSheet([normalized, normalized], path.join(root, "sheet.png"));
  assert.ok((await sharp(path.join(root, "sheet.png")).metadata()).width! <= 2000);
});

test("JPEG source preparation preserves decoded pixels without a second lossy encode", async () => {
  const raw = Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 37 + Math.floor(i / 11) * 53) % 256));
  const jpeg = await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const expected = await sharp(jpeg).toColourspace("srgb").raw().toBuffer();
  const source = await sharp(await sourceImage(jpeg)).raw().toBuffer();
  const panel = await sharp(await normalizeImage(jpeg, { width: 32, height: 32, fit: "contain", background: "#ffffff" })).raw().toBuffer();
  assert.deepEqual(source, expected);
  assert.deepEqual(panel, expected);
});

test("vote journals resume completed work and reject changed inputs or bytes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-vote-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let runs = 0, seals = 0;
  const options = { directory: path.join(root, "vote"), identity: { pixels: "same" }, validate: (v: unknown) => { assert.equal(typeof v, "string"); return v as string; }, seal: () => seals++, run: async (directory: string) => { runs++; fs.writeFileSync(path.join(directory, "panel.png"), "pixels"); return "equivalent"; } };
  assert.equal(await journalVote(options), "equivalent"); assert.equal(await journalVote(options), "equivalent");
  assert.equal(runs, 1); assert.equal(seals, 1);
  await assert.rejects(journalVote({ ...options, identity: { pixels: "different" } }), /inputs changed/);
  fs.writeFileSync(path.join(options.directory, "panel.png"), "changed");
  await assert.rejects(journalVote(options), /checksum changed/);
});

test("concurrent judges stop queued work and drain active work on failure", async () => {
  const started: number[] = [], finished: number[] = [];
  await assert.rejects(mapConcurrent([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (!value) throw new Error("failed");
    await new Promise(resolve => setTimeout(resolve, 20)); finished.push(value);
  }), /failed/);
  assert.deepEqual(started, [0, 1]); assert.deepEqual(finished, [1]);
});

test("comparison reports escape judge text and overlay normalized candidate defect regions", () => {
  const html = comparisonHtml({
    id: "DESIGN", policy: "non_regression", decision: { attempted: 5, judgeable: 5, counts: { loss: 5 }, decision: "loss" },
    votes: [{ outcome: "loss", reasoning: "<script>alert(1)</script>" }],
    findings: [{ image: "A", severity: "major", description: "Unreadable label", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<rect x="0.1" y="0.2" width="0.3" height="0.4"/);
});
