import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

// Read the sealed artifact supplied by AEK, not the mutable project original.
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
await sharp(context.sources.chart.path).png().toFile(path.join(context.outputDir, "chart.png"));
console.log(JSON.stringify({
  version: 1,
  outcome: "completed",
  summary: "Rasterized the exported chart at its authored dimensions.",
  observations: ["This is evidence of the exported chart only; it does not establish dashboard interaction or data correctness."],
  images: [{ label: "export", path: "chart.png", source: "chart", extraction: "Decoded the snapshotted SVG with Sharp at its intrinsic 640×360 dimensions." }],
}));
