import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const scope = fs.readFileSync(context.sources.scope.path, "utf8").trim();
if (scope === "withheld") {
  console.log(
    JSON.stringify({
      version: 1,
      outcome: "blocked",
      summary: "The Revision 04 recommendation was withheld from this evidence package.",
      observations: [
        "No recommendation or inspector screenshot is available. The application outcome cannot be inferred from this package.",
      ],
      images: [],
      files: [],
    }),
  );
} else if (scope === "observed") {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "collect-browser.mjs")],
    {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Browser collection failed (${result.status}): ${result.stderr}`);
  // Delegate the existing browser workflow without changing its observations.
  process.stdout.write(result.stdout);
} else {
  throw new Error(`Unknown evidence scope: ${scope}`);
}
