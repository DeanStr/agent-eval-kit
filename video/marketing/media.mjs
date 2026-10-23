import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { FPS } from "./src/story.mjs";
export const hash = (data) => createHash("sha256").update(data).digest("hex");
export function toolchain() {
  return {
    ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
    ffprobe: execFileSync("ffprobe", ["-version"], { encoding: "utf8" }).split("\n")[0],
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
  };
}
export async function assertToolchain() {
  const expected = JSON.parse(
    await fs.readFile(new URL("./toolchain.json", import.meta.url), "utf8"),
  );
  const actual = toolchain();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Media toolchain changed. Review extraction compatibility and update toolchain.json intentionally. Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
    );
}
export function probe(file) {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
}
export function deliveryIssues(metadata, { width, height }, duration) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Specify the expected duration.");
  const issues = [],
    video = metadata.streams.filter((s) => s.codec_type === "video");
  if (metadata.streams.length !== 1 || video.length !== 1)
    issues.push("Expected exactly one video stream and no audio or other streams.");
  if (
    Math.abs(Number(metadata.format.duration) - duration) > 1 / FPS ||
    !Number.isFinite(Number(metadata.format.duration))
  )
    issues.push(`Expected a ${duration}-second video.`);
  if (video.length === 1) {
    const s = video[0];
    if (s.width !== width || s.height !== height) issues.push(`Expected ${width}×${height}.`);
    if (s.codec_name !== "h264" || s.pix_fmt !== "yuv420p")
      issues.push("Expected H.264 with yuv420p.");
    if (
      s.r_frame_rate !== `${FPS}/1` ||
      s.avg_frame_rate !== `${FPS}/1` ||
      Number(s.nb_frames) !== duration * FPS
    )
      issues.push(
        `Expected ${(duration * FPS).toLocaleString("en-US")} frames at a constant ${FPS} fps.`,
      );
  }
  return issues;
}
export function decode(file) {
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-f", "null", "-"],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 },
  );
}
export async function frame(file, seconds, width) {
  const buffer = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-1`,
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-threads",
      "1",
      "pipe:1",
    ],
    { maxBuffer: 25 * 1024 * 1024, timeout: 30000 },
  );
  if (!buffer.length) throw new Error(`No frame at ${seconds}s in ${file}`);
  return sharp(buffer).png().toBuffer();
}
export async function board(file, times, title, width = 640, columns = 2) {
  const items = [];
  let height;
  for (const [i, time] of times.entries()) {
    const png = await frame(file, time, width);
    const meta = await sharp(png).metadata();
    if (height === undefined) height = meta.height;
    if (meta.height !== height) throw new Error("Frame dimensions changed inside a video.");
    const top = Math.floor(i / columns) * (height + 32) + 42;
    items.push({ input: png, left: (i % columns) * width, top });
    const label = `<svg width="${width}" height="32"><rect width="100%" height="100%" fill="#101923"/><text x="12" y="22" fill="#fff" font-family="DejaVu Sans" font-size="16">${i + 1} · ${time.toFixed(1)}s</text></svg>`;
    items.push({ input: Buffer.from(label), left: (i % columns) * width, top: top + height });
  }
  // Titles are local manifest IDs, never copied from untrusted metadata.
  if (!/^[a-z0-9 -]+$/i.test(title)) throw new Error("Invalid board title.");
  items.push({
    input: Buffer.from(
      `<svg width="${columns * width}" height="42"><text x="12" y="28" fill="#fff" font-family="DejaVu Sans" font-size="20">${title} · sampled frames in reading order</text></svg>`,
    ),
    left: 0,
    top: 0,
  });
  return sharp({
    create: {
      width: columns * width,
      height: Math.ceil(times.length / columns) * (height + 32) + 42,
      channels: 3,
      background: "#101923",
    },
  })
    .composite(items)
    .png()
    .toBuffer();
}
