import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const criterion = process.argv[2];
if (!["DATA", "MOBILE"].includes(criterion)) throw Error("Specify DATA or MOBILE");
const directory = path.join(process.env.AEK_RUN_DIR, "DASHBOARD");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
const file = evidence.files.find((f) => f.label === "observations");
if (!file) throw Error("Missing observations");
const resolved = path.resolve(directory, file.path);
if (!resolved.startsWith(directory + path.sep)) throw Error("Evidence escapes scenario");
const bytes = fs.readFileSync(resolved);
if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256)
  throw Error("Observation integrity mismatch");
const states = JSON.parse(bytes);
const issues = [];
const expectations = {
  Weekly: [140, 180, 110],
  Monthly: [70, 100, 160],
  Advanced: [150, 190, 120],
  Reset: [140, 180, 110],
};
for (const size of ["desktop", "mobile"])
  for (const [step, expected] of Object.entries(expectations)) {
    const key = size + step,
      state = states[key];
    if (!state || !Array.isArray(state.rows) || !Number.isFinite(state.scrollWidth))
      throw Error(`Missing or invalid ${key} observation`);
    if (criterion === "DATA") {
      if (state.rows.length !== 3)
        issues.push(`${key}: expected three regions, observed ${state.rows.length}`);
      state.rows.forEach((row, i) => {
        if (row.label !== ["North", "Central", "South"][i] || row.value !== expected[i])
          issues.push(`${key}: ${row.label} displays ${row.value}; expected ${expected[i]}`);
        const ratio = row.barRect.width / state.rows[0].barRect.width;
        if (!Number.isFinite(ratio) || Math.abs(ratio - expected[i] / expected[0]) > 0.025)
          issues.push(`${key}: ${row.label} bar is not proportional to its value`);
      });
    }
    if (criterion === "MOBILE" && size === "mobile" && ["Weekly", "Monthly"].includes(step)) {
      if (state.scrollWidth > state.width + 1)
        issues.push(`${key}: page is ${state.scrollWidth}px wide in a ${state.width}px viewport`);
      if (state.rows.length !== 3) issues.push(`${key}: expected all three regions`);
      for (const row of state.rows)
        for (const part of ["label", "bar", "value"]) {
          const box = row[part + "Rect"];
          if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.width))
            throw Error(`Invalid ${key} ${part} geometry`);
          if (
            box.x < 0 ||
            box.x + box.width > state.width + 1 ||
            box.width <= 0 ||
            box.height <= 0 ||
            !box.visible
          )
            issues.push(`${key}: ${row.label} ${part} does not fit visibly on screen`);
          if (part !== "bar" && box.fontSize < 14)
            issues.push(`${key}: ${row.label} ${part} is below 14px`);
        }
    }
  }
console.log(
  JSON.stringify({
    verdict: issues.length ? "fail" : "pass",
    confidence: "high",
    reasoning: issues.length
      ? issues.join("; ")
      : criterion === "DATA"
        ? "Both datasets, advance and reset preserve every region value and proportional bar on desktop and phone."
        : "All region labels, values and bars fit a 375px phone without horizontal scrolling in both datasets.",
    evidenceRefs: [`DASHBOARD/${file.path}`],
  }),
);
