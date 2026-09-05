import fs from "node:fs";
let engine: typeof import("sharp").default;
async function imageEngine() { return engine ??= (await import("sharp")).default; }
import type { z } from "zod";
import { imageMetricNames, type ImageMetric, type cropSchema, type panelSchema } from "./contracts.js";

// Bound decoded images as well as encoded bytes. Reference inputs are local,
// explicitly configured evaluator assets, never paths chosen by an agent.
export function imageBytes(file: string): Buffer {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error(`Image must be a regular file <= 25 MiB: ${file}`);
  return fs.readFileSync(file);
}
const decode = (input: Buffer | string) => engine(typeof input === "string" ? imageBytes(input) : input, {
  failOn: "error", limitInputPixels: 40_000_000,
});

export async function normalizeImage(input: Buffer | string, panel: z.infer<typeof panelSchema>, crop?: z.infer<typeof cropSchema>): Promise<Buffer> {
  await imageEngine();
  const oriented = await decode(input).rotate().png().toBuffer();
  const metadata = await decode(oriented).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image has no dimensions");
  let pipeline = decode(oriented);
  if (crop) {
    if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)
      throw new Error("Crop must fit within image");
    const left = Math.floor(crop.x * metadata.width), top = Math.floor(crop.y * metadata.height);
    pipeline = pipeline.extract({ left, top, width: Math.max(1, Math.min(metadata.width - left, Math.round(crop.width * metadata.width))), height: Math.max(1, Math.min(metadata.height - top, Math.round(crop.height * metadata.height))) });
  }
  return pipeline.flatten({ background: panel.background }).toColourspace("srgb")
    .resize(panel.width, panel.height, { fit: panel.fit, background: panel.background }).png().toBuffer();
}

export type ImageCrop = z.infer<typeof cropSchema>;

/** Orient and crop source pixels without resizing or adding comparison-panel padding. */
export async function sourceImage(input: Buffer | string, crop?: ImageCrop): Promise<Buffer> {
  await imageEngine();
  const oriented = await decode(input).rotate().png().toBuffer();
  let pipeline = decode(oriented);
  if (crop) {
    const { width, height } = await pipeline.metadata();
    if (!width || !height || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)
      throw new Error("Crop must fit within image");
    const left = Math.floor(crop.x * width), top = Math.floor(crop.y * height);
    pipeline = pipeline.extract({ left, top, width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))), height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))) });
  }
  return pipeline.flatten({ background: "#ffffff" }).toColourspace("srgb").removeAlpha().png().toBuffer();
}

export type ImageStatistics = { width: number; height: number } & Record<ImageMetric, number>;

function regionFractions(data: Buffer, width: number, darkLevel: number, highlightLevel: number) {
  const mask = new Uint8Array(data.length), stack = new Uint32Array(data.length);
  const counts = [0, 0, 0], largest = [0, 0, 0];
  for (let i = 0; i < data.length; i++) { const kind = data[i] <= darkLevel ? 1 : data[i] >= highlightLevel ? 2 : 0; mask[i] = kind; counts[kind]++; }
  for (let start = 0; start < data.length; start++) {
    const kind = mask[start];
    if (!kind) continue;
    let length = 1, size = 0; stack[0] = start; mask[start] = 0;
    const visit = (i: number) => { if (mask[i] === kind) { mask[i] = 0; stack[length++] = i; } };
    while (length) {
      const i = stack[--length]; size++;
      if (i % width) visit(i - 1);
      if (i % width < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i + width < data.length) visit(i + width);
    }
    largest[kind] = Math.max(largest[kind], size);
  }
  return { darkPixelFraction: counts[1] / data.length, highlightPixelFraction: counts[2] / data.length, largestDarkRegionFraction: largest[1] / data.length, largestHighlightRegionFraction: largest[2] / data.length };
}

export async function inspectImage(file: Buffer | string, options: { crop?: ImageCrop; darkLevel?: number; highlightLevel?: number } = {}): Promise<ImageStatistics> {
  await imageEngine();
  const darkLevel = options.darkLevel ?? 8, highlightLevel = options.highlightLevel ?? 247;
  if (!Number.isInteger(darkLevel) || !Number.isInteger(highlightLevel) || darkLevel < 0 || highlightLevel > 255 || darkLevel >= highlightLevel) throw new Error("Image levels require 0 <= darkLevel < highlightLevel <= 255");
  const { data, info } = await decode(await sourceImage(file, options.crop)).greyscale().raw().toBuffer({ resolveWithObject: true });
  const histogram = new Uint32Array(256);
  let sum = 0, squares = 0, edges = 0, samples = 0;
  for (let i = 0; i < data.length; i++) {
    const value = data[i]; histogram[value]++; sum += value; squares += value * value;
    if (i % info.width) { edges += Math.abs(value - data[i - 1]); samples++; }
    if (i >= info.width) { edges += Math.abs(value - data[i - info.width]); samples++; }
  }
  let entropy = 0;
  for (const count of histogram) if (count) { const p = count / data.length; entropy -= p * Math.log2(p); }
  return { width: info.width, height: info.height, entropy, stdev: Math.sqrt(Math.max(0, squares / data.length - (sum / data.length) ** 2)), gradientEnergy: edges / Math.max(1, samples), ...regionFractions(data, info.width, darkLevel, highlightLevel) };
}

export async function compareImages(left: string, right: string, channelTolerance = 0, crop?: ImageCrop) {
  const sharp = await imageEngine();
  if (!Number.isInteger(channelTolerance) || channelTolerance < 0 || channelTolerance > 255) throw new Error("Invalid channel tolerance");
  const buffers = await Promise.all([left, right].map(async file => decode(await sourceImage(file, crop)).raw().toBuffer({ resolveWithObject: true })));
  const [a, b] = buffers;
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error("Image dimensions differ; comparison is unavailable");
  let changed = 0, delta = 0;
  const diff = Buffer.alloc(a.data.length);
  for (let i = 0; i < a.data.length; i += 3) {
    let pixelChanged = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      diff[i + c] = d; delta += d; pixelChanged ||= d > channelTolerance;
    }
    if (pixelChanged) changed++;
  }
  return {
    changedPixelRatio: changed / (a.info.width * a.info.height),
    meanAbsoluteChannelDelta: delta / a.data.length,
    difference: await sharp(diff, { raw: { width: a.info.width, height: a.info.height, channels: 3 } }).png().toBuffer(),
  };
}

/** RGB thumbnail distance in [0,1]; color is retained, fine details are not. */
export async function imageSignature(input: Buffer | string, crop?: ImageCrop): Promise<Buffer> {
  await imageEngine();
  return decode(await sourceImage(input, crop)).resize(32, 32, { fit: "fill" }).raw().toBuffer();
}

export function signatureDistance(left: Buffer, right: Buffer): number {
  if (left.length !== 32 * 32 * 3 || right.length !== left.length) throw new Error("Expected two 32×32 RGB image signatures");
  let delta = 0;
  for (let i = 0; i < left.length; i++) delta += Math.abs(left[i] - right[i]);
  return delta / (left.length * 255);
}

export function statisticChanges(before: ImageStatistics, after: ImageStatistics) {
  return Object.fromEntries(imageMetricNames.map(metric => [metric, {
    before: before[metric], after: after[metric], absolute: after[metric] - before[metric],
    relative: before[metric] >= 0.000001 ? (after[metric] - before[metric]) / before[metric] : null,
  }])) as Record<ImageMetric, { before: number; after: number; absolute: number; relative: number | null }>;
}

export async function contactSheet(frames: string[], output: string): Promise<void> {
  const sharp = await imageEngine();
  if (!frames.length || frames.length > 30) throw new Error("Contact sheet requires 1–30 frames");
  const columns = Math.min(4, frames.length), rows = Math.ceil(frames.length / columns);
  const width = Math.floor(1600 / columns), height = Math.min(300, Math.floor(1900 / rows));
  const inputs = await Promise.all(frames.map(file => normalizeImage(file, { width, height, fit: "contain", background: "#ffffff" })));
  await sharp({ create: { width: columns * width, height: rows * height, channels: 3, background: "#ffffff" } })
    .composite(inputs.map((input, i) => ({ input, left: (i % columns) * width, top: Math.floor(i / columns) * height }))).png().toFile(output);
}
