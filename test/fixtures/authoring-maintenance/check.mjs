import fs from "node:fs";
import path from "node:path";

const name = process.argv[2];
const expected = { quantity: 1000, empty: 0 };
if (!Object.hasOwn(expected, name)) throw new Error(`Unknown check: ${name}`);
// AEK verifies sealed artifacts; the fixture only reads this run's observations.
const directory = path.join(process.env.AEK_RUN_DIR, "OBSERVE");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = manifest.files.find((entry) => entry.label === "values");
if (!file) throw new Error("Missing collected values");
const values = JSON.parse(fs.readFileSync(path.join(directory, file.path), "utf8"));
if (!Number.isFinite(values[name])) throw new Error(`Missing numeric observation: ${name}`);
console.log(
  JSON.stringify({
    verdict: values[name] === expected[name] ? "pass" : "fail",
    reasoning: `Expected ${expected[name]}, observed ${values[name]}`,
    evidenceRefs: [`OBSERVE/${file.path}`],
  }),
);
