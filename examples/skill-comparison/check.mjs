import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const directory = path.join(process.env.AEK_RUN_DIR, "OBSERVE");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = manifest.files.find((entry) => entry.label === "values");
if (!file) throw new Error("Missing collected values");
const resolved = path.resolve(directory, file.path);
if (!resolved.startsWith(`${directory}${path.sep}`))
  throw new Error("Evidence path escapes scenario");
const bytes = fs.readFileSync(resolved);
if (file.bytes !== bytes.length || file.sha256 !== createHash("sha256").update(bytes).digest("hex"))
  throw new Error("Values evidence failed integrity verification");
const expected = {
  quantity: 1000,
  empty: 0,
  discount: 900,
  "round-once": 5,
  "round-across-lines": 5,
  free: 0,
  zero: 1593,
};
const values = JSON.parse(bytes);
if (
  !Array.isArray(values) ||
  values.length !== Object.keys(expected).length ||
  new Set(values.map((value) => value.id)).size !== values.length ||
  values.some((value) => !Object.hasOwn(expected, value.id) || !Number.isFinite(value.actual))
)
  throw new Error("Incomplete or malformed evidence is an execution error");
const differences = values.filter(({ id, actual }) => actual !== expected[id]);
console.log(
  JSON.stringify({
    verdict: differences.length ? "fail" : "pass",
    confidence: "high",
    reasoning: differences.length
      ? JSON.stringify(differences)
      : "All independently expected totals match.",
    evidenceRefs: [`OBSERVE/${file.path}`],
  }),
);
