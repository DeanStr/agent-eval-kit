import fs from "node:fs/promises";
import path from "node:path";
import { assertToolchain, toolchain, hash, probe, decode, frame, board } from "../media.mjs";
const context = JSON.parse(await fs.readFile(process.env.AEK_COLLECT_CONTEXT, "utf8"));
if (context.version !== 1 || context.scenarioId !== "EXPORT")
  throw new Error("Expected the EXPORT version-1 collector context.");
await assertToolchain();
const references = JSON.parse(
  await fs.readFile(new URL("../references.json", import.meta.url), "utf8"),
).references;
const times = [2, 6, 10.5, 15.5, 20.5, 25.5, 30.5, 37];
const images = [],
  report = { version: 1, toolchain: toolchain(), candidates: {} };
for (const name of ["landscape", "portrait", ...references.map((r) => r.id)]) {
  const source = context.sources[name];
  if (!source) throw new Error(`Missing sealed source: ${name}`);
  const bytes = await fs.readFile(source.path);
  if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes)
    throw new Error(`Sealed source mismatch: ${name}`);
  const ref = references.find((r) => r.id === name);
  if (ref && (ref.sha256 !== source.sha256 || ref.bytes !== source.bytes))
    throw new Error(`Unapproved reference bytes: ${name}`);
  if (!ref) {
    const metadata = probe(source.path);
    decode(source.path);
    report.candidates[name] = { sourceSha256: source.sha256, metadata, fullDecodeCompleted: true };
  }
  const label = `${name}-board`;
  await fs.writeFile(
    path.join(context.outputDir, `${label}.png`),
    await board(source.path, ref ? ref.times : times, name, name === "portrait" ? 360 : 640),
  );
  images.push({
    label,
    path: `${label}.png`,
    source: name,
    extraction: `${report.toolchain.ffmpeg}; contact sheet, timestamps ${(ref ? ref.times : times).join(", ")} seconds; 2 columns in chronological reading order. ${ref ? ref.target : "Candidate export; illustrative scores."}`,
  });
  if (!ref) {
    for (const [i, time] of times.entries()) {
      const label = `${name}-${i + 1}`;
      // These are actual feed-width images: evaluate at native size for legibility.
      await fs.writeFile(
        path.join(context.outputDir, `${label}.png`),
        await frame(source.path, time, name === "portrait" ? 540 : 960),
      );
      images.push({
        label,
        path: `${label}.png`,
        source: name,
        timeSeconds: time,
        extraction: `${report.toolchain.ffmpeg}; exact sample at ${time}s; scaled to ${name === "portrait" ? 540 : 960}px wide for feed-legibility assessment.`,
      });
    }
  }
}
if (
  JSON.stringify(images.map((i) => i.label).sort()) !== JSON.stringify([...context.images].sort())
)
  throw new Error("Declared image labels do not match the fixed evaluation sampling plan.");
await fs.writeFile(
  path.join(context.outputDir, "media-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary:
      "Collected two silent social video exports and three pinned official motion references.",
    observations: [
      "These are sampled stills. They establish composition, sampled narrative progression, and text legibility only. Do not infer smoothness, timing between samples, absence of all transient glitches, or audio quality.",
      "Candidate scores and terrain are illustrative. The coding agent edits and selects; AEK evaluates and compares. Unverified evidence must not become a measured score.",
      "References are quality targets for specific dimensions, not mandatory art styles. Compare framing against Linear Agent, workflow clarity against Cursor × Linear, and search/selection continuity against AlphaEvolve.",
      "Technical stream metadata and successful full decoding are recorded separately in collector-output/media-report.json. Original reference audio is excluded from visual assessment.",
    ],
    images,
  }),
);
