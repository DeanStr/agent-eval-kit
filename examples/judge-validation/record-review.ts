import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadJudgeValidationReview } from "../../src/judge-validation-review.js";

// Reuse the existing project-owned append-only decision journal, with no report edits.
const { recordDecision } = await import("../improvement-exercise/record-decision.mjs");
if (process.argv.length !== 4)
  throw new Error("Usage: tsx record-review.ts EXPERIMENT COMPARISON_DIRECTORY");
const experiment = fs.realpathSync(process.argv[2]!);
for (let ancestor = experiment; ; ancestor = path.dirname(ancestor)) {
  if (fs.existsSync(path.join(ancestor, "artifact-index.json")))
    throw new Error("Decision journals must be outside sealed run and collection bundles");
  if (path.dirname(ancestor) === ancestor) break;
}
const comparison = fs.realpathSync(process.argv[3]!);
const verified = loadJudgeValidationReview(comparison);
const { report, dataset } = verified;
const destination = path.join(experiment, "journal.ndjson");
const existing = fs.existsSync(destination)
  ? fs.readFileSync(destination, "utf8").trim().split("\n").filter(Boolean)
  : [];
const entries = report.observations.map((observation) => {
  const item = dataset.cases.find((item) => item.id === observation.caseId)!;
  return {
    attemptId: randomUUID(),
    recordedAt: new Date().toISOString(),
    variant: `${observation.configuration}/${observation.caseId}`,
    run: observation.runDir ?? null,
    ...(observation.status !== "execution_error"
      ? { evaluator: observation.evaluationFingerprint }
      : {}),
    validation: { path: verified.file, sha256: verified.sha256 },
    evidenceRootSha256: observation.evidenceRootSha256,
    status: observation.status,
    exitCode: observation.status === "execution_error" ? 1 : 0,
    ...(observation.status === "execution_error"
      ? { error: observation.error }
      : { verdicts: { [item.rubric]: observation.actual } }),
  };
});
fs.appendFileSync(
  destination,
  entries.map((entry: unknown) => JSON.stringify(entry)).join("\n") + "\n",
);
const record = recordDecision(experiment, {
  id: "judge-validation",
  hypothesis:
    "Judge decisions should agree with evidence-supported reviewer labels while preserving unavailable evidence and execution errors.",
  change:
    "Compare fixed judge configurations over identical sealed collections; no application change is selected.",
  attempts: entries.map((_: unknown, i: number) => existing.length + i + 1),
  comparisons: [],
  outcome: "unresolved",
  reason: `Bounded judge comparison recorded at ${comparison}. Reviewer identities and kinds are retained with the labels. Broader independent validation would strengthen confidence; this comparison does not establish general judge accuracy or accept an application revision.`,
});
console.log(`Recorded ${entries.length} attempts in ${destination}; decision ${record.eventId}`);
