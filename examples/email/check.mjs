import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectEvidenceFile } from "agent-eval-kit/evidence/files";
const directory = path.join(process.env.AEK_RUN_DIR, "INSPECT-MAIL");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
if (evidence.outcome === "blocked") {
  console.log(
    JSON.stringify({
      verdict: "cannot_judge",
      confidence: "high",
      reasoning: "The send or mailbox observation was blocked",
      evidenceRefs: [],
    }),
  );
} else {
  const file = evidence.files.find((file) => file.label === "receipt");
  if (!file) throw new Error("Missing email receipt after collection");
  const receipt = inspectEvidenceFile(directory, file, "json");
  const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
  if (
    receipt.version !== 1 ||
    typeof receipt.received !== "boolean" ||
    !Array.isArray(receipt.checks) ||
    !isDeepStrictEqual(
      receipt.checks.map((check) => check.expected),
      expected.bodyIncludes,
    ) ||
    receipt.checks.some((check) => typeof check.present !== "boolean")
  )
    throw new Error("Invalid email receipt contract");
  const pass = receipt.received && receipt.checks.every((check) => check.present);
  console.log(
    JSON.stringify({
      verdict: pass ? "pass" : "fail",
      confidence: "high",
      reasoning: pass
        ? "The matching email arrived with every required passage"
        : "The matching email or required passages were absent",
      evidenceRefs: [`INSPECT-MAIL/${file.path}`],
    }),
  );
}
