import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
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
const browser = await chromium.launch({ headless: true });
let assets;
try {
  const page = await browser.newPage();
  await page.setContent(
    await fs.readFile(path.join(root, "docs/marketing/hill-climbing.svg"), "utf8"),
  );
  assets = await page.evaluate(() => {
    const svg = document.querySelector("svg");
    const routes = [...svg.querySelectorAll(".route, [data-branch]")].map((el) => ({
      step: Number(el.getAttribute("data-route") ?? el.getAttribute("data-branch")),
      d: (el.querySelector(".trail") ?? el).getAttribute("d"),
    }));
    if (routes.length !== 5 || routes.some((r) => !r.d))
      throw new Error(
        "Terrain must contain exactly five named routes. Regenerate the marketing SVG.",
      );
    const points = Object.fromEntries(
      [...svg.querySelectorAll(".point")].map((el) => {
        const halo = el.querySelector(".halo");
        return [
          el.getAttribute("data-step"),
          [Number(halo.getAttribute("cx")), Number(halo.getAttribute("cy"))],
        ];
      }),
    );
    if (
      Object.keys(points).join(",") !== "0,1,2,3,4,5" ||
      Object.values(points)
        .flat()
        .some((value) => !Number.isFinite(value))
    )
      throw new Error("Terrain must contain six checkpoints with numeric coordinates.");
    svg
      .querySelectorAll("text, .point, .route, [data-branch], title, desc")
      .forEach((el) => el.remove());
    [...svg.children]
      .filter(
        (el) =>
          el.tagName === "circle" ||
          el.tagName === "ellipse" ||
          el.getAttribute("d") === "M0 0h1600v1040H0z" ||
          (el.tagName === "g" && el.getAttribute("stroke") === "#283542"),
      )
      .forEach((el) => el.remove());
    svg.setAttribute("viewBox", "0 255 1600 580");
    svg.setAttribute("width", "2400");
    svg.setAttribute("height", "870");
    return { svg: new XMLSerializer().serializeToString(svg), routes, points };
  });
} finally {
  await browser.close();
}
const png = await sharp(Buffer.from(assets.svg)).png().toBuffer();
const terrain = `data:image/png;base64,${png.toString("base64")}`;
const serveUrl = await bundle({
  entryPoint: path.join(here, "src/index.jsx"),
  outDir: path.join(output, "bundle"),
});
const browserExecutable = chromium.executablePath();
for (const [format, { id }] of Object.entries(FORMATS)) {
  if (
    (args.includes("--landscape") && format !== "landscape") ||
    (args.includes("--portrait") && format !== "portrait")
  )
    continue;
  const inputProps = { format, terrain, routes: assets.routes, points: assets.points };
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
