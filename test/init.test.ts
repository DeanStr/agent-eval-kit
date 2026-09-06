import { requireDefined } from "../src/invariants.js";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import sharp from "sharp";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, STARTER_KINDS } from "../src/templates.js";

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "aek-init-test-"));

test("project initialization publishes the complete starter kit without staging debris", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = initializeProject(root);
  assert.deepEqual(files, [
    path.join(root, "evalkit.yaml"),
    path.join(root, "evals", "specs", "core.yaml"),
    path.join(root, "evals", "fixtures.yaml"),
    path.join(root, "evals", "ONBOARDING.md"),
  ]);
  assert(files.every((file) => fs.statSync(file).isFile()));
  assert.deepEqual(
    fs.readdirSync(path.join(root, "evals", "specs")).filter((name) => name.includes(".aek-init-")),
    [],
  );
});

test("project initialization preflights every conflict before writing anything", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const conflict = path.join(root, "evals", "specs", "core.yaml");
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.writeFileSync(conflict, "user-owned\n");
  assert.throws(() => initializeProject(root), /Refusing to overwrite existing files/);
  assert.equal(fs.existsSync(path.join(root, "evalkit.yaml")), false);
  assert.equal(fs.existsSync(path.join(root, "evals", "fixtures.yaml")), false);
  assert.equal(fs.readFileSync(conflict, "utf8"), "user-owned\n");
});

const kit = path.resolve(import.meta.dirname, "..");
function cli(root: string, args: string[], expected = 0) {
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
  return result;
}

for (const kind of STARTER_KINDS) {
  test(`${kind} starter validates and previews through the CLI after supplying its target inputs`, async (t) => {
    const root = temporary();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = cli(root, ["init", "--kind", kind]);
    assert.match(result.stdout, /ONBOARDING.md/);
    if (kind === "artifact") {
      const missing = cli(root, ["validate"], 1);
      assert.match(missing.stderr, /result.png/);
      fs.mkdirSync(path.join(root, "exports"));
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } })
        .png()
        .toFile(path.join(root, "exports/result.png"));
    }
    cli(root, ["validate"]);
    const preview = cli(root, ["run", "--dry-run"]);
    assert.match(
      preview.stdout,
      new RegExp(
        `\\[${kind === "web" ? "browser" : kind === "artifact" ? "command" : "workspace"}\\]`,
      ),
    );
    assert.equal(fs.existsSync(path.join(root, ".agent-eval/runs")), false);

    if (kind === "command") {
      cli(root, ["doctor"]); // No real provider or browser is required.
      cli(root, ["run"], 1);
      const runs = path.join(root, ".agent-eval/runs");
      const run = path.join(
        runs,
        requireDefined(fs.readdirSync(runs)[0], "fs.readdirSync(runs)[0]"),
      );
      assert.match(
        fs.readFileSync(path.join(run, "areas/core/graders/CORE-01.stderr.txt"), "utf8"),
        /Configure evals\/check.mjs/,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(run, "run-state.json"), "utf8")).status,
        "failed",
      );
    }
    if (kind === "artifact") {
      // Exercise the generated collector with sealed sources and no model quota.
      cli(root, ["run", "--agent", "mock", "--judge", "mock"], 2);
      const runs = path.join(root, ".agent-eval/runs");
      const run = path.join(
        runs,
        requireDefined(fs.readdirSync(runs)[0], "fs.readdirSync(runs)[0]"),
      );
      cli(root, ["verify", "--run", run]);
      const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
      assert.equal(report.overallCoveragePct, 0); // A mock judge must abstain.
      assert.equal(report.gates.passed, false);
      assert.deepEqual(
        fs.readFileSync(path.join(run, "CORE-S1/collector-output/export.png")),
        fs.readFileSync(path.join(root, "exports/result.png")),
      );
    }
  });
}

test("init rejects invalid or missing kinds without publishing files", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(
    cli(root, ["init", "--kind", "unknown"], 1).stderr,
    /expected web, repository, command, artifact/,
  );
  assert.match(cli(root, ["init", "--kind"], 1).stderr, /requires a value/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("init preflights guide and helper conflicts for every starter", (t) => {
  for (const [kind, relative] of [
    ["web", "evals/ONBOARDING.md"],
    ["command", "evals/check.mjs"],
    ["artifact", "evals/collect.mjs"],
  ] as const) {
    const root = temporary();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const conflict = path.join(root, relative);
    fs.mkdirSync(path.dirname(conflict), { recursive: true });
    fs.writeFileSync(conflict, "user-owned\n");
    assert.throws(() => initializeProject(root, kind), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(conflict, "utf8"), "user-owned\n");
    assert.equal(fs.existsSync(path.join(root, "evalkit.yaml")), false);
    assert.equal(fs.existsSync(path.join(root, "evals/specs")), false);
  }
});

test("configured command starter detects a target defect with compatible evidence coverage", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject(root, "command");
  const config = YAML.parse(fs.readFileSync(path.join(root, "evalkit.yaml"), "utf8"));
  assert.equal(config.agent.provider, "mock");
  assert.equal(config.judge.provider, "mock");
  const specFile = path.join(root, "evals/specs/core.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.rubric[0].criterion = "Quantity contributes to the total";
  spec.rubric[0].passCriteria = "node cart.mjs prints 1000 and exits zero";
  fs.writeFileSync(specFile, YAML.stringify(spec));
  fs.writeFileSync(
    path.join(root, "evals/check.mjs"),
    `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["cart.mjs"], { encoding: "utf8" });
if (result.error || result.signal) throw result.error ?? new Error(result.signal);
console.log(JSON.stringify({ verdict: result.status === 0 && result.stdout.trim() === "1000" ? "pass" : "fail", confidence: "high", reasoning: "Expected 1000 and exit 0; received " + result.stdout.trim() + " and exit " + result.status }));
`,
  );
  const runs = path.join(root, ".agent-eval/runs");
  function evaluate(total: number, expectedExit: number) {
    fs.writeFileSync(path.join(root, "cart.mjs"), `console.log(${total});\n`);
    const before = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    cli(root, ["run", "--split", "all"], expectedExit);
    const added = fs.readdirSync(runs).filter((id) => !before.includes(id));
    assert.equal(added.length, 1);
    const run = path.join(runs, requireDefined(added[0], "added[0]"));
    const report = JSON.parse(fs.readFileSync(path.join(run, "report.json"), "utf8"));
    assert.equal(report.overallCoveragePct, 100);
    assert.equal(report.overallScorePct, total === 1000 ? 100 : 0);
    assert.equal(report.gates.passed, total === 1000);
    return run;
  }
  const good = evaluate(1000, 0);
  const broken = evaluate(500, 2);
  const output = path.join(root, "comparison");
  cli(
    root,
    [
      "compare",
      "--baseline",
      good,
      "--candidate",
      broken,
      "--fail-on-regression",
      "--output",
      output,
    ],
    2,
  );
  const comparison = JSON.parse(fs.readFileSync(path.join(output, "comparison.json"), "utf8"));
  assert.equal(comparison.compatibility.status, "compatible");
  assert.equal(comparison.overall.scorePct.delta, -100);
  assert.equal(comparison.overall.coveragePct.delta, 0);
  const restored = evaluate(1000, 0);
  cli(root, [
    "baseline",
    "promote",
    "--run",
    restored,
    "--name",
    "main",
    "--reviewer",
    "calibration-test",
  ]);
});

test("artifact starter rejects non-PNG sources without claiming successful collection", async (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject(root, "artifact");
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(output);
  const context = path.join(root, "context.json");
  fs.writeFileSync(
    context,
    JSON.stringify({ sources: { artifact: { path: source } }, outputDir: output }),
  );
  const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();
  for (const bytes of [Buffer.alloc(0), Buffer.from([137, 80, 78]), jpeg]) {
    fs.writeFileSync(source, bytes);
    const result = spawnSync(process.execPath, ["evals/collect.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AEK_COLLECT_CONTEXT: context },
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected a delivered PNG/);
    assert.equal(result.stdout, "");
    assert.deepEqual(fs.readdirSync(output), []);
  }
});
