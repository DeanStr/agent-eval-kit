import fs from "node:fs/promises";
import path from "node:path";
import { deliveryIssues } from "../media.mjs";
import { CUTS } from "../src/story.mjs";
const report = JSON.parse(
  await fs.readFile(
    path.join(process.env.AEK_RUN_DIR, "EXPORT/collector-output/media-report.json"),
    "utf8",
  ),
);
if (report.version !== 1) throw new Error("Expected version-1 collected media metadata.");
const failures = [];
for (const [name, dimensions] of Object.entries({
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1350 },
})) {
  const candidate = report.candidates[name];
  if (!candidate?.fullDecodeCompleted || !candidate.metadata || !candidate.evidenceBound)
    throw new Error(`Missing completed decode evidence for ${name}.`);
  failures.push(
    ...deliveryIssues(candidate.metadata, dimensions, CUTS.main.duration).map(
      (issue) => `${name}: ${issue}`,
    ),
  );
}
console.log(
  JSON.stringify({
    verdict: failures.length ? "fail" : "pass",
    confidence: "high",
    reasoning: failures.length
      ? failures.join(" ")
      : "Both exports decode completely: 60 seconds, 1,800 frames at 30 fps, H.264/yuv420p, expected dimensions, and no audio stream.",
    evidenceRefs: ["EXPORT/collector-output/media-report.json"],
  }),
);
