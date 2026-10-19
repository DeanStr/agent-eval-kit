import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Project-owned, append-only review notes. This does not select or apply changes.
export function recordDecision(experiment, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Decision input must be an object");
  const required = ["id", "hypothesis", "change", "outcome", "reason"];
  for (const key of required)
    if (typeof input[key] !== "string" || !input[key].trim())
      throw new Error(`Decision requires nonempty ${key}`);
  if (!/^[a-z][a-z0-9-]*$/.test(input.id)) throw new Error("Invalid decision id");
  if (!["accepted", "rejected", "unresolved"].includes(input.outcome))
    throw new Error("Outcome must be accepted, rejected, or unresolved");
  if (!Array.isArray(input.attempts) || !input.attempts.length)
    throw new Error("Link at least one journal attempt using its 1-based line number");
  if (!Array.isArray(input.comparisons)) throw new Error("comparisons must be an array");
  for (const key of Object.keys(input))
    if (![...required, "attempts", "comparisons"].includes(key))
      throw new Error(`Unknown decision field: ${key}`);
  const journal = fs
    .readFileSync(path.join(experiment, "journal.ndjson"), "utf8")
    .trimEnd()
    .split("\n");
  const attempts = input.attempts.map((line) => {
    if (!Number.isInteger(line) || line < 1 || line > journal.length)
      throw new Error(`Unknown journal attempt: ${line}`);
    const text = journal[line - 1];
    return { line, sha256: sha256(text), entry: JSON.parse(text) };
  });
  if (new Set(input.attempts).size !== input.attempts.length)
    throw new Error("Duplicate journal attempt");
  const comparisons = input.comparisons.map((file) => {
    if (typeof file !== "string" || !file) throw new Error("Invalid comparison path");
    const resolved = path.resolve(experiment, file);
    const bytes = fs.readFileSync(resolved);
    const report = JSON.parse(bytes);
    for (const side of ["baseline", "candidate"]) {
      const snapshot = report[side];
      const matches = attempts.filter(
        ({ entry }) => entry.run && path.basename(entry.run) === snapshot?.runId,
      );
      if (matches.length !== 1)
        throw new Error(
          `Comparison ${side} must reference a linked journal run exactly once: ${file}`,
        );
      const { entry } = matches[0];
      if (
        entry.error ||
        ![0, 2].includes(entry.exitCode) ||
        typeof entry.evaluator !== "string" ||
        !entry.evaluator ||
        !(entry.score === null || Number.isFinite(entry.score)) ||
        !Number.isFinite(entry.coverage) ||
        snapshot.evaluationFingerprint !== entry.evaluator ||
        snapshot.scorePct !== entry.score ||
        snapshot.coveragePct !== entry.coverage ||
        typeof snapshot.scoreWithheld !== "boolean" ||
        (entry.scoreWithheld !== undefined && snapshot.scoreWithheld !== entry.scoreWithheld)
      )
        throw new Error(
          `Comparison ${side} does not match journal execution and provenance: ${file}`,
        );
    }
    return { path: resolved, sha256: sha256(bytes), report };
  });
  if (input.outcome === "accepted") {
    if (
      !comparisons.length ||
      comparisons.some(
        ({ report }) =>
          report.compatibility?.status !== "compatible" ||
          report.compatibility.overridden !== false,
      )
    )
      throw new Error("Acceptance requires a compatible linked comparison");
    for (const { report } of comparisons) {
      const { entry } = attempts.find(
        ({ entry }) => entry.run && path.basename(entry.run) === report.candidate.runId,
      );
      if (
        entry.exitCode !== 0 ||
        entry.coverage !== 100 ||
        entry.gatesPassed !== true ||
        report.candidate.scoreWithheld ||
        !Number.isFinite(entry.score)
      )
        throw new Error(
          "Acceptance candidate must complete successfully with full coverage, a visible score, and passed gates; rerun if the journal lacks this evidence",
        );
    }
  }
  const destination = path.join(experiment, "decisions.ndjson");
  const previous = fs.existsSync(destination)
    ? fs
        .readFileSync(destination, "utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ line, record: JSON.parse(line) }))
        .findLast(({ record }) => record.id === input.id)
    : undefined;
  const record = {
    ...input,
    eventId: randomUUID(),
    recordedAt: new Date().toISOString(),
    previousSha256: previous ? sha256(previous.line) : null,
    attempts,
    comparisons,
  };
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node record-decision.mjs <experiment> <decision.json>");
  console.log(
    JSON.stringify(
      recordDecision(
        path.resolve(process.argv[2]),
        JSON.parse(fs.readFileSync(process.argv[3], "utf8")),
      ),
      null,
      2,
    ),
  );
}
