import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { loadTerrain } from "./terrain.mjs";
import { FORMATS, FPS, sampleTimes } from "./src/story.mjs";
import { assertToolchain, deliveryIssues, probe, decode } from "./media.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = path.join(root, ".agent-eval/marketing-video");
const args = process.argv.slice(2);
if (args.some((arg) => !["--stills", "--landscape", "--portrait"].includes(arg)))
  throw new Error("Usage: node render.mjs [--stills] [--landscape | --portrait]");
if (args.includes("--landscape") && args.includes("--portrait"))
  throw new Error("Choose one format or omit both for all formats.");
await assertToolchain();
await fs.mkdir(output, { recursive: true });
const lamp = `data:image/png;base64,${(await fs.readFile(path.join(here, "assets/arc-lamp.png"))).toString("base64")}`;
const font = `data:font/woff2;base64,${(await fs.readFile(path.join(here, "assets/InterVariable.woff2"))).toString("base64")}`;
const landscapeAssets = await loadTerrain(root);
const serveUrl = await bundle({
  entryPoint: path.join(here, "src/index.jsx"),
  outDir: path.join(output, args.includes("--portrait") ? "bundle-portrait" : "bundle-landscape"),
});
const browserExecutable = chromium.executablePath();
for (const [format, { id }] of Object.entries(FORMATS)) {
  if (
    (args.includes("--landscape") && format !== "landscape") ||
    (args.includes("--portrait") && format !== "portrait")
  )
    continue;
  const inputProps = { format, lamp, font, ...landscapeAssets };
  const composition = await selectComposition({ serveUrl, id, inputProps, browserExecutable });
  const options = { serveUrl, composition, inputProps, browserExecutable };
  await fs.mkdir(path.join(output, "stills", format), { recursive: true });
  for (const [index, time] of sampleTimes.entries()) {
    await renderStill({
      ...options,
      frame: Math.round(time * FPS),
      output: path.join(output, "stills", format, `${index + 1}.png`),
    });
  }
  console.log(`Rendered ${format} story stills.`);
  if (!args.includes("--stills")) {
    let last = -1;
    const temporary = path.join(output, `${format}.partial.mp4`);
    await renderMedia({
      ...options,
      codec: "h264",
      outputLocation: temporary,
      crf: 18,
      pixelFormat: "yuv420p",
      colorSpace: "bt709",
      muted: true,
      concurrency: 3,
      onProgress: ({ progress }) => {
        const tenth = Math.floor(progress * 10);
        if (tenth !== last) {
          last = tenth;
          console.log(`${format}: ${tenth * 10}%`);
        }
      },
    });
    const issues = deliveryIssues(probe(temporary), FORMATS[format]);
    if (issues.length)
      throw new Error(`${format} export failed delivery checks: ${issues.join(" ")}`);
    decode(temporary);
    await fs.rename(temporary, path.join(output, `${format}.mp4`));
  }
}
console.log(`Output: ${output}`);
if (!args.includes("--stills") && !args.includes("--landscape") && !args.includes("--portrait")) {
  const { preparePreview } = await import("./preview.mjs");
  await preparePreview();
}
