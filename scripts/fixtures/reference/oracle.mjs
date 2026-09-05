import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [moduleFile, examplesFile] = process.argv.slice(2);
const { total } = await import(pathToFileURL(moduleFile).href);
const { examples } = JSON.parse(fs.readFileSync(examplesFile, "utf8"));
if (typeof total !== "function") {
  console.log(JSON.stringify({ verdict: "not_found", reasoning: "No total export exists." }));
} else {
  const mismatches = examples.flatMap(({ items, expected }) => {
    const actual = total(items);
    return actual === expected ? [] : [{ items, expected, actual }];
  });
  console.log(JSON.stringify({
    verdict: mismatches.length ? "fail" : "pass",
    reasoning: mismatches.length ? JSON.stringify(mismatches) : "All independently specified example totals matched.",
  }));
}
