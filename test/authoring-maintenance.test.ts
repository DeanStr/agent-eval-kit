import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { initializeAuthoring, loadAuthoringPlan } from "../src/authoring/plan.js";
import { authoringStatus } from "../src/authoring/status.js";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(repository, "test/fixtures/authoring-maintenance");

test("maintenance preserves contracts and history across new coverage, broken collection, and a real regression", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-maintenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.cpSync(path.join(repository, "examples/authoring"), root, { recursive: true });
  initializeAuthoring(root, "project", "Maintenance fixture");
  fs.copyFileSync(path.join(root, "plan.json"), path.join(root, ".aek-authoring/plan.json"));
  for (const file of ["collect.mjs", "check.mjs"])
    fs.copyFileSync(path.join(fixture, file), path.join(root, file));
  const specFile = path.join(root, "specs/cart.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.scenarios = [
    {
      id: "OBSERVE",
      name: "Observe cart",
      kind: "command",
      instructions: "Execute the sealed cart.",
      collect: {
        command: "node collect.mjs",
        methodFiles: ["collect.mjs"],
        sources: { cart: "cart.mjs" },
        files: ["values"],
      },
    },
  ];
  for (const item of spec.rubric) item.scenarios = ["OBSERVE"];
  fs.writeFileSync(specFile, YAML.stringify(spec));
  fs.writeFileSync(path.join(root, ".gitignore"), ".agent-eval/\n");
  fs.writeFileSync(path.join(root, "receipts.mjs"), "export const receiptFormats = ['json'];\n");
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Initial fixture",
  );
  const revision = git("rev-parse", "HEAD");
  const reviewRoot = path.join(root, ".aek-authoring/reviews");
  fs.mkdirSync(reviewRoot);
  fs.writeFileSync(
    path.join(reviewRoot, "baseline.md"),
    `# Initial baseline\nRevision: ${revision}\nScope: cart; receipts not yet surveyed.\nOutstanding: survey receipt failure/recovery intent.\n`,
  );
  const run = (expected: number) => {
    const runs = path.join(root, ".agent-eval/runs");
    const previous = new Set(fs.existsSync(runs) ? fs.readdirSync(runs) : []);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repository, "src/cli.ts"),
        "run",
        "--config",
        path.join(root, "evalkit.yaml"),
      ],
      { cwd: repository, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    const added = fs.readdirSync(runs).filter((id) => !previous.has(id));
    assert.equal(added.length, 1);
    return { directory: path.join(runs, added[0]!), diagnostic: result.stderr };
  };
  const original = fs.readFileSync(path.join(root, "cart.mjs"), "utf8");
  const good = run(0);
  fs.copyFileSync(path.join(fixture, "updated-cart.mjs"), path.join(root, "cart.mjs"));
  const defect = run(2);
  fs.writeFileSync(path.join(root, "cart.mjs"), original);
  const plan = loadAuthoringPlan(root);
  const contracts = plan.requirements.map(({ id, acceptance }) => ({ id, acceptance }));
  for (const requirement of plan.requirements)
    requirement.trials = [
      { kind: "good", run: good.directory, rationale: "Original quantity-aware implementation." },
      {
        kind: "defect",
        run: defect.directory,
        rationale: "Quantity regression; same collector and checker.",
      },
    ];
  const save = () =>
    fs.writeFileSync(path.join(root, ".aek-authoring/plan.json"), JSON.stringify(plan));
  save();
  assert.equal((await authoringStatus(root)).requirements[0]!.stage, "calibrated");
  fs.copyFileSync(path.join(fixture, "updated-cart.mjs"), path.join(root, "cart.mjs"));
  fs.writeFileSync(
    path.join(root, "feature.md"),
    "Product decision: discountTotal applies a percentage once to the subtotal, rounding final cents.\n",
  );
  const collector = fs.readFileSync(path.join(root, "collect.mjs"), "utf8");
  fs.writeFileSync(
    path.join(root, "collect.mjs"),
    collector.replace("context.sources.cart.path", "context.sources.missing.path"),
  );
  const broken = run(1);
  assert.equal(fs.existsSync(path.join(broken.directory, "report.json")), false);
  await assert.rejects(authoringStatus(root), /different evaluation method/);
  fs.writeFileSync(path.join(root, "collect.mjs"), collector);
  const regression = run(2);
  const report = JSON.parse(
    fs.readFileSync(path.join(regression.directory, "report.json"), "utf8"),
  );
  assert.equal(report.overallCoveragePct, 100);
  assert.equal(
    report.areas[0].items.find((item: { id: string }) => item.id === "QUANTITY").verdict,
    "fail",
  );
  // Historical calibration survives a new product failure; it is not freshness.
  assert.equal((await authoringStatus(root)).requirements[0]!.stage, "calibrated");
  const evidence = path.join(reviewRoot, "update-evidence");
  fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(evidence, "status.txt"), git("status", "--short"));
  fs.writeFileSync(path.join(evidence, "working.patch"), git("diff", "HEAD"));
  fs.writeFileSync(path.join(evidence, "staged.patch"), git("diff", "--cached"));
  fs.copyFileSync(path.join(root, "feature.md"), path.join(evidence, "feature.md"));
  assert.match(fs.readFileSync(path.join(evidence, "status.txt"), "utf8"), /feature.md/);
  fs.mkdirSync(path.join(root, ".aek-authoring/history"));
  fs.writeFileSync(
    path.join(root, ".aek-authoring/history/update.json"),
    JSON.stringify({
      method: report.receipt.evaluationFingerprint,
      reason: "Observe and check the new discount API",
      requirements: plan.requirements,
    }),
  );
  for (const requirement of plan.requirements) requirement.trials = [];
  delete plan.scope.reviewedBy;
  plan.discovery.remaining = ["Survey receipt failure/recovery intent (carried from baseline.md)"];
  plan.decisions.push({
    id: "RECEIPT-INTENT",
    question: "Which receipt recovery behavior is intended?",
    dependsOn: [],
  });
  const source = { kind: "document" as const, ref: "feature.md: product decision" };
  plan.requirements.push({
    ...structuredClone(plan.requirements[1]!),
    id: "DISCOUNT",
    statement: "Apply discount once to subtotal.",
    acceptance: "Two 5-cent items discounted 50% total 5 cents.",
    sources: [source],
    confirmedBy: "Fixture product decision",
    checks: [{ area: "cart", rubric: "DISCOUNT" }],
  });
  spec.rubric.push({
    ...structuredClone(spec.rubric[1]),
    id: "DISCOUNT",
    criterion: "Apply discount once",
    passCriteria: "Two 5-cent items at 50% total 5 cents",
    grader: {
      type: "command",
      command: "node check.mjs discount",
      output: "json",
      methodFiles: ["check.mjs"],
    },
  });
  fs.writeFileSync(specFile, YAML.stringify(spec));
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    fs
      .readFileSync(path.join(root, "check.mjs"), "utf8")
      .replace("{ quantity: 1000, empty: 0 }", "{ quantity: 1000, empty: 0, discount: 5 }"),
  );
  fs.writeFileSync(
    path.join(root, "collect.mjs"),
    collector.replace(
      "empty: cart.total([])",
      "empty: cart.total([]), discount: cart.discountTotal([{priceCents:5,quantity:2}],50)",
    ),
  );
  save();
  assert.deepEqual(
    (await authoringStatus(root)).requirements.map(({ stage }) => stage),
    ["configured", "configured", "configured"],
  );
  const newGood =
    original +
    "\nexport function discountTotal(lines, percent) { return Math.round(total(lines)*(100-percent)/100); }\n";
  fs.writeFileSync(path.join(root, "cart.mjs"), newGood);
  const freshGood = run(0);
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    "export const total = () => 1; export const discountTotal = () => 1;\n",
  );
  const freshDefect = run(2);
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    "export function total(lines) { let cents = 0; for (const line of lines) cents += line.priceCents * line.quantity; return cents; }\nexport function discountTotal(lines, percent) { return Math.round(total(lines) * (100-percent)/100); }\n",
  );
  const validVariation = run(0);
  fs.writeFileSync(path.join(root, "cart.mjs"), newGood);
  for (const requirement of plan.requirements)
    requirement.trials = [
      {
        kind: "good",
        run: freshGood.directory,
        rationale: "Known-good discount and original totals.",
      },
      {
        kind: "defect",
        run: freshDefect.directory,
        rationale: "All APIs return a wrong constant; evaluator fixed across pair.",
      },
      {
        kind: "good",
        run: validVariation.directory,
        rationale: "Equivalent loop implementation; same agreed outputs and evaluator.",
      },
    ];
  save();
  const status = await authoringStatus(root);
  assert.deepEqual(
    status.requirements.map(({ stage }) => stage),
    ["calibrated", "calibrated", "calibrated"],
  );
  assert.equal(status.ready, false);
  assert.deepEqual(
    plan.requirements.slice(0, 2).map(({ id, acceptance }) => ({ id, acceptance })),
    contracts,
  );
  assert.ok(fs.existsSync(path.join(good.directory, "report.json")));
  const template = fs.readFileSync(
    path.join(repository, "skills/aek-author/templates/review-note.md"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(reviewRoot, "update.md"),
    `${template}\nFixture assessment, not user approval.\nPrevious: baseline.md at ${revision}\nReviewed HEAD: ${revision}, dirty: update-evidence/working.patch, feature.md\nCurrent interfaces: total, discountTotal, receiptFormats (unchanged; unmapped).\nDISCOUNT: new coverage gap, authority feature.md.\nCollection problem: ${broken.directory}; execution error, no score.\nQUANTITY: product regression, ${regression.directory}, coverage 100%.\nSuperseded trials: ../history/update.json; originals retained.\nFresh calibration: ${freshGood.directory}, ${freshDefect.directory}.\nOutstanding: ${plan.discovery.remaining[0]}; open RECEIPT-INTENT.\nFreshness: cart surveyed; receipts incomplete. Historical calibration: three fixed-method examples.\n`,
  );
  assert.match(
    fs.readFileSync(path.join(reviewRoot, "update.md"), "utf8"),
    /carried from baseline/,
  );
});
