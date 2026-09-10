import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const check = process.argv[2];
if (!["BEST", "PENDING"].includes(check)) throw new Error("Specify BEST or PENDING");

const directory = path.join(process.env.AEK_RUN_DIR, "DEMO");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = evidence.files.find((entry) => entry.label === "states");
if (!file) throw new Error("DEMO is missing the states evidence file");
const resolved = path.resolve(directory, file.path);
if (!resolved.startsWith(`${directory}${path.sep}`))
  throw new Error("Evidence path escapes scenario directory");
const bytes = fs.readFileSync(resolved);
if (
  bytes.length !== file.bytes ||
  createHash("sha256").update(bytes).digest("hex") !== file.sha256
) {
  throw new Error("States evidence failed integrity verification");
}
const states = JSON.parse(bytes.toString("utf8"));
const expectations = {
  BEST: {
    rejected: { decision: "REJECT", score: "77", gates: "Fail", "best-score": "68" },
    unverified: {
      decision: "UNVERIFIED",
      score: "—",
      coverage: "58%",
      gates: "Unknown",
      "best-score": "82",
    },
  },
  PENDING: {
    preparing: {
      decision: "PREPARING",
      score: "…",
      coverage: "…",
      gates: "Pending",
      "best-score": "68",
    },
    paused: {
      decision: "PREPARING",
      score: "…",
      coverage: "…",
      gates: "Pending",
      "best-score": "68",
    },
    evaluating: {
      decision: "EVALUATING",
      score: "…",
      coverage: "…",
      gates: "Pending",
      "best-score": "68",
    },
    finished: {
      decision: "REJECT",
      score: "77",
      coverage: "100%",
      gates: "Fail",
      "best-score": "68",
    },
  },
};
const expected = expectations[check];
const differences = [];
for (const [name, fields] of Object.entries(expected)) {
  if (!states[name]) throw new Error(`Missing collected state: ${name}`);
  for (const [field, wanted] of Object.entries(fields)) {
    if (typeof states[name][field] !== "string")
      throw new Error(`Malformed collected field: ${name}.${field}`);
    if (states[name][field] !== wanted)
      differences.push(
        `${name}.${field}: expected ${JSON.stringify(wanted)}, observed ${JSON.stringify(states[name][field])}`,
      );
  }
}
console.log(
  JSON.stringify({
    verdict: differences.length ? "fail" : "pass",
    confidence: "high",
    reasoning: differences.length
      ? differences.join("; ")
      : `All ${check} observations match the independently specified demo contract.`,
    evidenceRefs: [`DEMO/${file.path}`],
  }),
);
