import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { loadTerrain } from "./terrain.mjs";
import { loadEvidence } from "./evidence.mjs";
import { loadWorkflow } from "./workflow.mjs";
import {
  FORMATS,
  FPS,
  CUTS,
  sampleTimes,
  compositionId,
  exportName,
  captionVtt,
} from "./src/story.mjs";
import { assertToolchain, deliveryIssues, probe, decode } from "./media.mjs";
import { renderInputs, sealExport, publishExport } from "./release.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = path.join(root, ".agent-eval/marketing-video");
const args = process.argv.slice(2);
const allowed = ["--stills", "--landscape", "--portrait", "--main", "--social", "--walkthrough"];
if (args.some((arg) => !allowed.includes(arg)))
  throw new Error(`Usage: node render.mjs [${allowed.join(" | ")}]`);
if (args.includes("--landscape") && args.includes("--portrait"))
  throw new Error("Choose one format or omit both.");
const selectedCuts = Object.keys(CUTS).filter((cut) => args.includes(`--${cut}`));
if (selectedCuts.length > 1) throw new Error("Choose one cut or omit all cut flags.");
await assertToolchain();
await fs.mkdir(output, { recursive: true });
const inputs = await renderInputs(root);
const proof = await loadEvidence();
const workflow = await loadWorkflow();
const font = `data:font/woff2;base64,${(await fs.readFile(path.join(here, "assets/InterVariable.woff2"))).toString("base64")}`;
const { terrain } = await loadTerrain(root);
// Each process bundles into its own directory, removed once rendering finishes.
const bundleDir = path.join(output, `bundle-${process.pid}`);
const serveUrl = await bundle({ entryPoint: path.join(here, "src/index.jsx"), outDir: bundleDir });
const browserExecutable = chromium.executablePath();
try {
  for (const cut of selectedCuts.length ? selectedCuts : Object.keys(CUTS)) {
    for (const [format, dimensions] of Object.entries(FORMATS)) {
      if (
        (args.includes("--landscape") && format !== "landscape") ||
        (args.includes("--portrait") && format !== "portrait")
      )
        continue;
      const name = exportName(cut, format);
      const parent = path.join(output, args.includes("--stills") ? "drafts" : "releases");
      await fs.mkdir(parent, { recursive: true });
      const staging = await fs.mkdtemp(path.join(parent, `${name}-`));
      const inputProps = { format, cut, font, terrain, proof, workflow };
      const composition = await selectComposition({
        serveUrl,
        id: compositionId(cut, format),
        inputProps,
        browserExecutable,
      });
      const options = { serveUrl, composition, inputProps, browserExecutable };
      const samples =
        cut === "main"
          ? sampleTimes
          : CUTS[cut].scenes.map((scene) => scene.start + (scene.end - scene.start) * 0.75);
      await fs.mkdir(path.join(staging, "stills"));
      for (const [index, time] of samples.entries())
        await renderStill({
          ...options,
          frame: Math.round(time * FPS),
          output: path.join(staging, "stills", `${index + 1}.png`),
        });
      console.log(`Rendered ${name} story stills: ${staging}`);
      await fs.copyFile(path.join(staging, "stills/1.png"), path.join(staging, "poster.png"));
      await fs.writeFile(path.join(staging, "captions.vtt"), captionVtt(cut));
      if (args.includes("--stills")) continue;
      let last = -1;
      const temporary = path.join(staging, "video.mp4");
      await renderMedia({
        ...options,
        codec: "h264",
        outputLocation: temporary,
        crf: 18,
        pixelFormat: "yuv420p",
        colorSpace: "bt709",
        muted: true,
        concurrency: 4,
        onProgress: ({ progress }) => {
          const tenth = Math.floor(progress * 10);
          if (tenth !== last) {
            last = tenth;
            console.log(`${name}: ${tenth * 10}%`);
          }
        },
      });
      const issues = deliveryIssues(probe(temporary), dimensions, CUTS[cut].duration);
      if (issues.length) throw new Error(`${name} delivery checks failed: ${issues.join(" ")}`);
      decode(temporary);
      await loadEvidence();
      await loadWorkflow();
      if (JSON.stringify(await renderInputs(root)) !== JSON.stringify(inputs))
        throw new Error(
          "Composition or evidence changed during rendering. Render again with stable inputs.",
        );
      const expected = { cut, format, duration: CUTS[cut].duration, ...inputs };
      await sealExport(staging, expected);
      await publishExport(output, name, staging, expected);
    }
  }
} finally {
  await fs.rm(bundleDir, { recursive: true, force: true });
}
console.log(`Output: ${output}`);
if (
  !args.includes("--stills") &&
  !selectedCuts.length &&
  !args.includes("--landscape") &&
  !args.includes("--portrait")
) {
  const { preparePreview } = await import("./preview.mjs");
  await preparePreview();
}
