import fs from "node:fs";
import path from "node:path";
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const records = JSON.parse(fs.readFileSync(context.sources.records.path, "utf8"));
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
fs.writeFileSync(
  path.join(context.outputDir, "table.csv"),
  "name,score\n" +
    records.map((record) => [record.name, record.score].map(quote).join(",")).join("\n") +
    "\n",
);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: "Exported records to CSV",
    observations: [],
    files: [{ label: "table", path: "table.csv", filename: "table.csv", mediaType: "text/csv" }],
    outputs: { table: { value: "table", evidenceRefs: ["step:1"] } },
    checkpoints: { exported: { evidenceRefs: ["step:1"] } },
  }),
);
