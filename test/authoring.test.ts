import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import {
  initializeAuthoring,
  loadAuthoringPlan,
  validateAuthoringPlan,
} from "../src/authoring/plan.js";
import { authoringStatus } from "../src/authoring/status.js";
import { installAuthoringSkill } from "../src/authoring/install.js";

const kit = path.resolve(import.meta.dirname, "..");
function temporary(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-authoring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(root: string, args: string[], expected = 0): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(kit, "src/cli.ts"), ...args],
    {
      cwd: kit,
      encoding: "utf8",
      timeout: 30_000,
      env: process.env,
    },
  );
  assert.equal(result.status, expected, `${root}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function example(root: string): void {
  fs.cpSync(path.join(kit, "examples/authoring"), root, { recursive: true });
  initializeAuthoring(root, "project", "Example project");
  fs.copyFileSync(path.join(root, "plan.json"), path.join(root, ".aek-authoring/plan.json"));
}
function save(root: string, value: unknown): void {
  fs.writeFileSync(path.join(root, ".aek-authoring/plan.json"), JSON.stringify(value));
}

test("authoring can start before config, preserves decisions, and never treats empty inventory as ready", async (t) => {
  const root = temporary(t);
  cli(root, ["author", "init", "--project", root]);
  const original = fs.readFileSync(path.join(root, ".aek-authoring/plan.json"));
  assert.throws(() => initializeAuthoring(root, "project", "replacement"), /already exists/);
  assert.deepEqual(fs.readFileSync(path.join(root, ".aek-authoring/plan.json")), original);
  const status = JSON.parse(
    cli(root, ["author", "validate", "--project", root, "--json", "--require-ready"], 2),
  );
  assert.equal(status.ready, false);
  assert.equal(status.requirements.length, 0);
  assert.equal(fs.existsSync(path.join(root, "evalkit.yaml")), false);
  assert.equal(fs.existsSync(path.join(root, ".agent-eval")), false);
  const plan = loadAuthoringPlan(root);
  plan.scope.reviewedBy = "reviewer";
  plan.discovery.remaining = [];
  save(root, plan);
  assert.equal((await authoringStatus(root)).ready, false);
  cli(root, ["author", "status", "--project", root, "--json=false"], 1);
  cli(root, ["author", "invent", "--project", root], 1);
  assert.match(cli(root, ["author", "--help"]), /author install/);
  cli(root, ["author", "install", "--project", root], 1);
});

test("map decisions reject invented resolutions, dangling links, and cycles", (t) => {
  const root = temporary(t);
  example(root);
  const base = loadAuthoringPlan(root);
  const inferred = structuredClone(base);
  inferred.decisions[0]!.resolution!.source.kind = "inference";
  assert.throws(() => validateAuthoringPlan(inferred), /inference cannot resolve/);
  const cycle = structuredClone(base);
  cycle.decisions[0]!.dependsOn = [cycle.decisions[0]!.id];
  assert.throws(() => validateAuthoringPlan(cycle), /cycle/);
  const unknown = structuredClone(base);
  unknown.requirements[0]!.decisionIds = ["NOT-THERE"];
  assert.throws(() => validateAuthoringPlan(unknown), /unknown decision/);
  const unresolved = structuredClone(base);
  delete unresolved.decisions[0]!.resolution;
  assert.throws(() => validateAuthoringPlan(unresolved), /resolve decisions/);
  const early = structuredClone(base);
  early.decisions.push({ id: "OPEN", question: "Which environment?", dependsOn: [] });
  early.decisions[0]!.dependsOn = ["OPEN"];
  assert.throws(() => validateAuthoringPlan(early), /prerequisite decisions first/);
  const duplicate = structuredClone(base);
  duplicate.requirements.push({ ...duplicate.requirements[0]!, id: "quantity" });
  assert.throws(() => validateAuthoringPlan(duplicate), /duplicate identity/);
  assert.throws(() => validateAuthoringPlan({ ...base, coverage: 100 }), /Invalid authoring plan/);
});

test("project status exposes open decision rounds, exclusions, unmapped checks, and prerequisites", async (t) => {
  const root = temporary(t);
  example(root);
  const plan = loadAuthoringPlan(root);
  assert.equal((await authoringStatus(root)).ready, true);
  plan.decisions.push({ id: "ENV", question: "Test environment?", dependsOn: [] });
  plan.decisions.push({ id: "AUTH", question: "Which test credentials?", dependsOn: ["ENV"] });
  plan.requirements[1]!.checks = [];
  plan.requirements[0]!.dependsOn = [plan.requirements[1]!.id];
  save(root, plan);
  const status = await authoringStatus(root);
  assert.equal(status.ready, false);
  assert.deepEqual(
    status.openDecisions.map((decision) => decision.readyToAsk),
    [true, false],
  );
  assert.equal(status.requirements[0]!.blockers.length, 1);
  assert.deepEqual(
    status.unlinkedChecks.map((check) => check.rubric),
    ["EMPTY"],
  );
  plan.requirements[1]!.exclusion = { reviewer: "owner", reason: "Excluded from this pilot" };
  save(root, plan);
  assert.equal((await authoringStatus(root)).requirements[1]!.stage, "excluded");
  plan.requirements[1]!.checks = [{ area: "cart", rubric: "EMPTY" }];
  assert.throws(() => validateAuthoringPlan(plan), /excluded requirements/);
});

test("linked checks fail fast for unknown rubrics, missing methods, and paths outside the project", async (t) => {
  const root = temporary(t);
  example(root);
  const plan = loadAuthoringPlan(root);
  plan.requirements[0]!.checks[0]!.rubric = "TYPO";
  save(root, plan);
  await assert.rejects(authoringStatus(root), /unknown check/);
  plan.requirements[0]!.checks[0]!.rubric = "QUANTITY";
  plan.config = "../elsewhere.yaml";
  save(root, plan);
  await assert.rejects(authoringStatus(root), /inside the project/);
  plan.config = "evalkit.yaml";
  save(root, plan);
  fs.unlinkSync(path.join(root, "check.mjs"));
  await assert.rejects(authoringStatus(root), /method|unavailable/i);
});

test("map path containment rejects symlinks instead of reading or overwriting another project's decisions", (t) => {
  const root = temporary(t);
  const other = temporary(t);
  fs.symlinkSync(other, path.join(root, ".aek-authoring"));
  assert.throws(() => initializeAuthoring(root, "project", "test"), /symlink/);
  assert.equal(fs.readdirSync(other).length, 0);
});

test("authoring readiness rejects scenario and email configuration that execution cannot use", async (t) => {
  const root = temporary(t);
  example(root);
  const file = path.join(root, "specs/cart.yaml");
  const spec = YAML.parse(fs.readFileSync(file, "utf8"));
  spec.scenarios = [
    { id: "PAGE", name: "Read page", kind: "browser", instructions: "Read the page" },
  ];
  fs.writeFileSync(file, YAML.stringify(spec));
  await assert.rejects(
    authoringStatus(root),
    /PAGE uses browser mode but target.url is not configured/,
  );

  const configFile = path.join(root, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.target = { kind: "web", url: "http://localhost:3000" };
  fs.writeFileSync(configFile, YAML.stringify(config));
  spec.scenarios[0].persona = "buyer";
  spec.scenarios[0].authenticateEmail = true;
  fs.writeFileSync(file, YAML.stringify(spec));
  await assert.rejects(
    authoringStatus(root),
    /configure emailAuth for persona buyer and its mailbox/,
  );
});

test("authoring skill installs with its resources and refuses overwrites", (t) => {
  const root = temporary(t);
  const installed = installAuthoringSkill(root);
  for (const file of [
    "SKILL.md",
    "agents/openai.yaml",
    "references/plan.md",
    "references/generation.md",
    "references/docs/authoring.md",
    "references/docs/existing-tests.md",
    "references/README.md",
    "references/examples/authoring/evalkit.yaml",
    "references/examples/authoring/cart.test.mjs",
    "references/examples/authoring/test-adapter.mjs",
  ])
    assert.ok(fs.statSync(path.join(installed, file)).isFile(), file);
  assert.match(
    fs.readFileSync(path.join(installed, "references/docs/authoring.md"), "utf8"),
    /\(\.\.\/plan\.md\)/,
  );
  fs.writeFileSync(path.join(installed, "local-notes.md"), "my customizations");
  assert.throws(() => installAuthoringSkill(root), /Refusing to overwrite/);
  assert.equal(
    fs.readFileSync(path.join(installed, "local-notes.md"), "utf8"),
    "my customizations",
  );
  assert.deepEqual(fs.readdirSync(root), ["aek-author"]);
});

test("recorded good/defect trials establish per-check calibration while preserving missing coverage and provenance", async (t) => {
  const root = temporary(t);
  example(root);
  assert.deepEqual(
    (await authoringStatus(root)).requirements.map((entry) => entry.stage),
    ["configured", "configured"],
  );
  const run = (expected: number): string => {
    const directory = path.join(root, ".agent-eval/runs");
    const before = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
    cli(root, ["run", "--config", path.join(root, "evalkit.yaml")], expected);
    const added = fs.readdirSync(directory).filter((id) => !before.includes(id));
    assert.equal(added.length, 1);
    return path.join(directory, added[0]!);
  };
  const good = run(0);
  const original = fs.readFileSync(path.join(root, "cart.mjs"));
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    "export function total(lines) { return lines.reduce((sum, line) => sum + line.priceCents, 0); }\n",
  );
  const defect = run(2);
  fs.writeFileSync(path.join(root, "cart.mjs"), original);
  const plan = loadAuthoringPlan(root);
  for (const requirement of plan.requirements)
    requirement.trials = [
      { kind: "good", run: good, rationale: "Known good calculation" },
      { kind: "defect", run: defect, rationale: "Target ignores quantity; checker unchanged" },
    ];
  save(root, plan);
  const status = await authoringStatus(root);
  assert.deepEqual(
    status.requirements.map((entry) => entry.stage),
    ["calibrated", "exercised"],
  );
  assert.equal(status.ready, true);
  // Claims depend on retained methods, not a hand-edited authoring status field.
  const checker = fs.readFileSync(path.join(root, "check.mjs"));
  fs.appendFileSync(path.join(root, "check.mjs"), "\n// changed evaluator\n");
  await assert.rejects(authoringStatus(root), /different evaluation method/);
  fs.writeFileSync(path.join(root, "check.mjs"), checker);
  const changedPlan = loadAuthoringPlan(root);
  changedPlan.requirements[0]!.trials[0]!.run = path.join(root, "missing-run");
  save(root, changedPlan);
  await assert.rejects(authoringStatus(root), /ENOENT/);
  save(root, plan);
  fs.appendFileSync(path.join(good, "report.json"), " ");
  await assert.rejects(authoringStatus(root), /integrity|changed|mismatch/i);
});

test("confirmed missing features count as detected calibration defects", async (t) => {
  const root = temporary(t);
  example(root);
  // Inspect the public export without turning an import or runtime error into not_found.
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    `import * as cart from "./cart.mjs";
const lines = process.argv[2] === "quantity" ? [{priceCents:500,quantity:2}] : [];
const expected = process.argv[2] === "quantity" ? 1000 : 0;
const missing = !Object.hasOwn(cart, "total");
const verdict = missing ? "not_found" : cart.total(lines) === expected ? "pass" : "fail";
console.log(JSON.stringify({verdict, reasoning: missing ? "The inspected module has no total export." : "Checked the independently expected total."}));
`,
  );
  const runs = path.join(root, ".agent-eval/runs");
  cli(root, ["run", "--config", path.join(root, "evalkit.yaml")]);
  const good = path.join(runs, fs.readdirSync(runs)[0]!);
  fs.writeFileSync(path.join(root, "cart.mjs"), "export const version = 1;\n");
  cli(root, ["run", "--config", path.join(root, "evalkit.yaml")], 2);
  const defect = path.join(runs, fs.readdirSync(runs).find((id) => id !== path.basename(good))!);
  const goodReport = JSON.parse(fs.readFileSync(path.join(good, "report.json"), "utf8"));
  const defectReport = JSON.parse(fs.readFileSync(path.join(defect, "report.json"), "utf8"));
  assert.equal(defectReport.overallCoveragePct, 100);
  assert.deepEqual(
    defectReport.areas[0].items.map((item: { verdict: string }) => item.verdict),
    ["not_found", "not_found"],
  );
  assert.equal(
    goodReport.receipt.evaluationFingerprint,
    defectReport.receipt.evaluationFingerprint,
  );
  assert.notDeepEqual(goodReport.receipt.target, defectReport.receipt.target);
  const plan = loadAuthoringPlan(root);
  for (const requirement of plan.requirements)
    requirement.trials = [
      { kind: "good", run: good, rationale: "Known-good public total function." },
      { kind: "defect", run: defect, rationale: "Deliberately removed the public total function." },
    ];
  save(root, plan);
  assert.deepEqual(
    (await authoringStatus(root)).requirements.map((entry) => entry.stage),
    ["calibrated", "calibrated"],
  );
});

test("completed command abstentions remain configured rather than exercised or calibrated", async (t) => {
  const root = temporary(t);
  example(root);
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    'console.log(JSON.stringify({verdict:"cannot_judge",reasoning:"Required observation is unavailable"}));\n',
  );
  cli(root, ["run", "--config", path.join(root, "evalkit.yaml")], 2);
  const runs = path.join(root, ".agent-eval/runs");
  const directory = path.join(runs, fs.readdirSync(runs)[0]!);
  const plan = loadAuthoringPlan(root);
  for (const requirement of plan.requirements)
    requirement.trials = [
      { kind: "good", run: directory, rationale: "Attempted pilot with unavailable observations" },
    ];
  save(root, plan);
  assert.deepEqual(
    (await authoringStatus(root)).requirements.map((entry) => entry.stage),
    ["configured", "configured"],
  );
});

test("named suites bind independently and explicit exclusions never make an empty project ready", async (t) => {
  const root = temporary(t);
  example(root);
  fs.appendFileSync(
    path.join(root, "evalkit.yaml"),
    "\nsuite: release\nsuites:\n  release: {}\n  diagnostic: {}\n",
  );
  const plan = loadAuthoringPlan(root);
  plan.requirements[0]!.checks[0]!.suite = "release";
  plan.requirements[1]!.checks[0]!.suite = "diagnostic";
  save(root, plan);
  const status = await authoringStatus(root);
  assert.equal(status.ready, true);
  assert.deepEqual(status.unlinkedChecks.map((entry) => `${entry.suite}/${entry.rubric}`).sort(), [
    "diagnostic/QUANTITY",
    "release/EMPTY",
  ]);
  for (const requirement of plan.requirements) {
    requirement.checks = [];
    requirement.exclusion = { reviewer: "owner", reason: "Scope deliberately deferred" };
  }
  save(root, plan);
  assert.equal((await authoringStatus(root)).ready, false);
});

test("hybrid calibration tolerates arithmetic roundoff but not missing manual coverage rounded to 100%", async (t) => {
  const root = temporary(t);
  example(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  const target = path.join(root, "cart.mjs");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex hybrid fixture 1'); process.exit(0); }
(async () => {
  const {total} = await import(require('node:url').pathToFileURL(${JSON.stringify(target)}).href);
  const result = {items: [
    {id:'QUANTITY', verdict:total([{priceCents:500,quantity:2}])===1000?'pass':'fail'},
    {id:'EMPTY', verdict:total([])===0?'pass':'fail'}
  ].map(item=>({...item,confidence:'high',reasoning:'Deterministic provider fixture.',evidenceRefs:['OBSERVE/evidence.json']})), cases:[], defects:[], notes:'Deterministic provider fixture.'};
  result.cases = result.items.map(({id,...item})=>({...item,rubricId:id,caseId:'default'}));
  const text = JSON.stringify(result);
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], text);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
})();
`,
    { mode: 0o755 },
  );
  const configFile = path.join(root, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.judge.provider = "codex";
  fs.writeFileSync(configFile, YAML.stringify(config));
  const specFile = path.join(root, "specs/cart.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.scenarios = [
    {
      id: "OBSERVE",
      name: "Fixture evidence",
      kind: "workspace",
      instructions: "Collect fixture evidence.",
    },
  ];
  for (const item of spec.rubric) {
    item.weight = 0.3;
    item.scenarios = ["OBSERVE"];
    item.grader = { type: "hybrid", autoShare: item.id === "QUANTITY" ? 0.1 : 0.9999999 };
    item.manualInstructions = "Review the known fixture result.";
  }
  fs.writeFileSync(specFile, YAML.stringify(spec));
  const plan = loadAuthoringPlan(root);
  const runs = path.join(root, ".agent-eval/runs");
  for (const kind of ["good", "defect"] as const) {
    if (kind === "defect") fs.writeFileSync(target, "export function total() { return 1; }\n");
    const before = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    cli(root, ["run", "--config", configFile], 2);
    const run = path.join(runs, fs.readdirSync(runs).find((id) => !before.includes(id))!);
    for (const requirement of plan.requirements)
      requirement.trials.push({ kind, run, rationale: "Known deterministic hybrid fixture." });
    save(root, plan);
    const pending = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    const tinyGap = pending.areas[0].items.find(
      (item: { id: string }) => item.id === "EMPTY",
    ).score;
    assert.equal(tinyGap.coveragePct, 100, "Display rounding hides a real uncovered share");
    assert.ok(tinyGap.judgeable < tinyGap.total);
    assert.deepEqual(
      (await authoringStatus(root)).requirements.map((entry) => entry.stage),
      kind === "good" ? ["configured", "configured"] : ["exercised", "exercised"],
    );
    const verdict = kind === "good" ? "pass" : "fail";
    fs.writeFileSync(
      path.join(run, "manual-results.json"),
      JSON.stringify({
        QUANTITY: { verdict, notes: "Reviewed fixture." },
        EMPTY: { verdict, notes: "Reviewed fixture." },
      }),
    );
    cli(
      root,
      ["finalize", "--run", run, "--reviewer", "fixture reviewer"],
      kind === "good" ? 0 : 2,
    );
    const complete = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    const score = complete.areas[0].items.find(
      (item: { id: string }) => item.id === "QUANTITY",
    ).score;
    assert.equal(score.judgeable, 0.30000000000000004);
    assert.equal(score.total, 0.3);
    assert.deepEqual(
      (await authoringStatus(root)).requirements.map((entry) => entry.stage),
      kind === "good" ? ["exercised", "exercised"] : ["calibrated", "calibrated"],
    );
  }
});
