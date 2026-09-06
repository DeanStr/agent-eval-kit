import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectEvidenceFile } from "agent-eval-kit/evidence/files";
const directory = path.join(process.env.AEK_RUN_DIR, "EXPORT");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = evidence.files.find((file) => file.label === "table");
if (!file) throw new Error("EXPORT did not retain the required table file");
const actual = inspectEvidenceFile(directory, file, "csv");
const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
const pass = isDeepStrictEqual(actual, expected);
console.log(
  JSON.stringify({
    verdict: pass ? "pass" : "fail",
    confidence: "high",
    reasoning: pass
      ? "Every exported row matches the expected data."
      : "Exported rows differ from the expected data.",
    evidenceRefs: [`EXPORT/${file.path}`],
  }),
);
