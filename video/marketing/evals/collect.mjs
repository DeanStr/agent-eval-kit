import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { sampleTimes as times, sampleGroups } from "../src/story.mjs";
import { assertToolchain, toolchain, hash, probe, decode, board } from "../media.mjs";
const context = JSON.parse(await fs.readFile(process.env.AEK_COLLECT_CONTEXT, "utf8"));
if (context.version !== 1 || context.scenarioId !== "EXPORT")
  throw new Error("Expected the EXPORT version-1 collector context.");
await assertToolchain();
const references = JSON.parse(
  await fs.readFile(new URL("../references.json", import.meta.url), "utf8"),
).references;
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
    await board(
      source.path,
      ref ? ref.times : times,
      name,
      ref ? 640 : name === "portrait" ? 270 : 400,
      ref ? 2 : 5,
    ),
  );
  images.push({
    label,
    path: `${label}.png`,
    source: name,
    extraction: `${report.toolchain.ffmpeg}; contact sheet, timestamps ${(ref ? ref.times : times).join(", ")} seconds; ${ref ? 2 : 5} columns in chronological reading order. ${ref ? ref.target : "Candidate export; one dispatch prototype, two agent revisions and the same frozen AEK suite."}`,
  });
  if (!ref) {
    for (const [i, group] of sampleGroups.entries()) {
      const label = `${name}-${i + 1}`;
      // These are actual feed-width images: evaluate at native size for legibility.
      await fs.writeFile(
        path.join(context.outputDir, `${label}.png`),
        await board(source.path, group, name, name === "portrait" ? 540 : 960, 1),
      );
      images.push({
        label,
        path: `${label}.png`,
        source: name,

        extraction: `${report.toolchain.ffmpeg}; samples at ${group.join(", ")}s stacked vertically in chronological order, each at native feed width; scaled to ${name === "portrait" ? 540 : 960}px wide for feed-legibility assessment.`,
      });
    }
  }
}
if (
  JSON.stringify(images.map((i) => i.label).sort()) !== JSON.stringify([...context.images].sort())
)
  throw new Error("Declared image labels do not match the fixed evaluation sampling plan.");
for (const image of images) {
  const metadata = await sharp(path.join(context.outputDir, image.path)).metadata();
  if (!metadata.width || !metadata.height || metadata.width > 2000 || metadata.height > 2000)
    throw new Error(
      `Judge attachment ${image.label} exceeds the 2,000-pixel limit. Reduce the sample grouping or board dimensions.`,
    );
}
const proofSource = context.sources["film-evidence"];
if (!proofSource) throw new Error("Missing sealed film evidence.");
const proofBytes = await fs.readFile(proofSource.path);
if (hash(proofBytes) !== proofSource.sha256) throw new Error("Film evidence snapshot changed.");
report.filmEvidence = JSON.parse(proofBytes);
const workflowSource = context.sources["workflow-evidence"];
if (!workflowSource) throw new Error("Missing workflow capture provenance.");
const workflowBytes = await fs.readFile(workflowSource.path);
if (hash(workflowBytes) !== workflowSource.sha256)
  throw new Error("Workflow capture manifest changed.");
report.workflowEvidence = JSON.parse(workflowBytes);
for (const name of ["landscape", "portrait"]) {
  const source = context.sources[`${name}-receipt`];
  if (!source) throw new Error(`Missing ${name} render receipt.`);
  const bytes = await fs.readFile(source.path);
  if (hash(bytes) !== source.sha256) throw new Error(`Changed ${name} receipt.`);
  const receipt = JSON.parse(bytes);
  if (
    receipt.evidenceSha256 !== proofSource.sha256 ||
    receipt.workflowSha256 !== workflowSource.sha256 ||
    receipt.files?.["video.mp4"] !== report.candidates[name].sourceSha256
  )
    throw new Error(`${name} does not match the captured evidence.`);
  if (receipt.version !== 1 || !receipt.compositionSha256)
    throw new Error(`${name} receipt is missing composition provenance.`);
  report.candidates[name].compositionSha256 = receipt.compositionSha256;
  report.candidates[name].evidenceBound = true;
}
if (report.candidates.landscape.compositionSha256 !== report.candidates.portrait.compositionSha256)
  throw new Error("Candidate formats were rendered from different compositions.");
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
      "The main film follows one human-directed dispatch prototype evaluated by five frozen criteria: data integrity, working task, phone usability, decision quality and craft. The agent makes revisions; AEK evaluates them. Synthetic records and selected criteria do not establish general product quality or customer outcomes.",
      "The baseline phone queue hides deliveries in a nested scroll region and has text down to 9px. The first agent revision fixes page scrolling and option text; the second improves typography, contrast and map labels. Both revisions use the same evaluator. Browser captures of the evaluated final revision show eligibility and a saved reassignment; reload and undo were checked. This is an edited capture sequence, not a continuous screen recording.",
      "The dashboard evidence is retained for the walkthrough only. The walkthrough's regression and missing-evidence examples are explicitly illustrative policy explanations, not observed dispatch outcomes; they are outside this main-film assessment.",
      `Observed dispatch suite progression: ${report.workflowEvidence.evaluation.results.map((r) => `${r.label} ${Math.round(r.score)}%`).join("; ")}. All reports have 100% evidence coverage and share one evaluator fingerprint.`,
      "References are quality targets for specific dimensions, not mandatory art styles. Compare framing against Linear Agent, workflow clarity against Cursor × Linear, and continuity across successive revisions against AlphaEvolve.",
      "Technical stream metadata and successful full decoding are recorded separately in collector-output/media-report.json. Original reference audio is excluded from visual assessment.",
    ],
    images,
  }),
);
