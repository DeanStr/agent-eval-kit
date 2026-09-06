import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunReport } from "../src/types.js";
import type { ComparisonReport } from "../src/compare.js";

test("first-run walkthrough produces its documented scores, gates, and comparison", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-first-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kit = path.resolve(import.meta.dirname, "..");
  fs.cpSync(path.join(kit, "examples/first-run"), root, { recursive: true });
  const cli = (args: string[], expected: number) => {
    const result = spawnSync(
      process.execPath,
      [path.join(kit, "node_modules/tsx/dist/cli.mjs"), path.join(kit, "src/cli.ts"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  };
  cli(["validate"], 0);
  const runs = path.join(root, ".agent-eval/runs");
  const evaluate = (expectedExit: number, expectedScore: number, gatesPassed: boolean) => {
    const previous = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    cli(["run"], expectedExit);
    const added = fs.readdirSync(runs).filter((id) => !previous.includes(id));
    assert.equal(added.length, 1);
    const run = path.join(runs, requireDefined(added[0], "added[0]"));
    const report: RunReport = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    assert.equal(report.overallScorePct, expectedScore);
    assert.equal(report.overallCoveragePct, 80);
    assert.equal(report.scoreWithheld, false);
    assert.equal(report.manualPending, 1);
    assert.equal(report.gates.passed, gatesPassed);
    assert.ok(fs.existsSync(path.join(run, "report.html")));
    cli(["verify", "--run", run], 0);
    return run;
  };
  const baseline = evaluate(0, 100, true);
  assert.match(
    fs.readFileSync(path.join(baseline, "areas/cart/graders/QUANTITY.stdout.txt"), "utf8"),
    /Expected 1000 cents; received 1000 cents/,
  );
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    `export function total(lines) {
  return lines.reduce((sum, line) => sum + line.priceCents, 0);
}
`,
  );
  const candidate = evaluate(2, 25, false);
  assert.match(
    fs.readFileSync(path.join(candidate, "areas/cart/graders/QUANTITY.stdout.txt"), "utf8"),
    /Expected 1000 cents; received 500 cents/,
  );
  const output = path.join(root, "comparison");
  cli(
    [
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--output",
      output,
      "--fail-on-regression",
    ],
    2,
  );
  const comparison: ComparisonReport = JSON.parse(
    fs.readFileSync(path.join(output, "comparison.json"), "utf8"),
  );
  assert.equal(comparison.compatibility.status, "compatible");
  assert.equal(comparison.overall.scorePct.delta, -75);
  assert.equal(comparison.overall.coveragePct.delta, 0);
  assert.equal(comparison.items.find((item) => item.id === "QUANTITY")?.change, "regressed");
  assert.ok(fs.existsSync(path.join(output, "comparison.html")));

  // Keeping the product defect but weakening its checker must not look like
  // a comparable product improvement.
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    `console.log(JSON.stringify({verdict:"pass",reasoning:"Always passes"}));\n`,
  );
  const weakened = evaluate(0, 100, true);
  const changedOutput = path.join(root, "changed-checker-comparison");
  cli(["compare", "--baseline", candidate, "--candidate", weakened, "--output", changedOutput], 2);
  const incompatible: ComparisonReport = JSON.parse(
    fs.readFileSync(path.join(changedOutput, "comparison.json"), "utf8"),
  );
  assert.equal(incompatible.compatibility.status, "incompatible");
  assert.equal(incompatible.overall.scorePct.delta, null);

  // Offline scoring must retain the checker actually used, even after the
  // current checker has changed or disappeared.
  const originalReceipt = JSON.parse(fs.readFileSync(path.join(candidate, "receipt.json"), "utf8"));
  fs.unlinkSync(path.join(root, "check.mjs"));
  cli(["rescore", "--run", candidate], 2);
  const rescoredReceipt = JSON.parse(fs.readFileSync(path.join(candidate, "receipt.json"), "utf8"));
  assert.deepEqual(rescoredReceipt.inputs.graderMethods, originalReceipt.inputs.graderMethods);
  cli(["verify", "--run", candidate], 0);
});
