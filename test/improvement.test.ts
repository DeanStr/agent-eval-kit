import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";
import {
  beginAttempt,
  evaluateAttempt,
  improvementStatus,
  startImprovement,
  stopImprovement,
} from "../src/improvement/session.js";
import { git } from "../src/improvement/git.js";
import { installImprovementSkill } from "../src/improvement/install.js";
import { loadConfig } from "../src/config.js";
import { evaluatePromotion } from "../src/promotion.js";
import { withRunLock } from "../src/run/state.js";
import { caseRegressionFailures } from "../src/improvement/cases.js";
import type { JudgedCase } from "../src/types.js";
import type { Session, StartOptions } from "../src/improvement/contracts.js";

const kit = path.resolve(import.meta.dirname, "..");

test("dataset case regressions remain protected when a parent rubric's aggregate improves", () => {
  function entry(
    caseId: string,
    verdict: JudgedCase["verdict"],
    points: number | null,
  ): JudgedCase {
    return {
      areaId: "copy",
      rubricId: "quality",
      caseId,
      verdict,
      points,
      source: "text-rubric",
      confidence: "high",
      reasoning: "Measured fixture",
      scenarioIds: [],
      strata: [],
      evidenceRefs: [],
    };
  }
  const baseline = [entry("a", "pass", 1), entry("b", "fail", 0), entry("c", "fail", 0)];
  const improved = [entry("a", "fail", 0), entry("b", "pass", 1), entry("c", "pass", 1)];
  assert.deepEqual(caseRegressionFailures(baseline, improved), [
    "Protected case copy/quality/a regressed (pass → fail)",
  ]);
  assert.deepEqual(
    caseRegressionFailures(baseline, [entry("a", "pass", 1), ...improved.slice(1)]),
    [],
  );
  assert.match(caseRegressionFailures(baseline, improved.slice(1)).join(" "), /a was removed/);
  assert.match(
    caseRegressionFailures(baseline, [entry("a", "cannot_judge", null), ...improved.slice(1)]).join(
      " ",
    ),
    /lost evidence/,
  );
  assert.match(
    caseRegressionFailures(baseline, [entry("a", "partial", 1), ...improved.slice(1)]).join(" "),
    /regressed/,
  );
  assert.throws(() => caseRegressionFailures(baseline, [improved[0]!, ...improved]), /Duplicate/);
  const malformed = { ...improved[0]! };
  delete malformed.points;
  assert.throws(
    () => caseRegressionFailures(baseline, [malformed, ...improved.slice(1)]),
    /missing points/,
  );
});

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aek-improve-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const session = path.join(directory, "session");
  const workspace = path.join(session, "workspace");
  fs.mkdirSync(path.join(source, "specs"), { recursive: true });
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n.agent-eval/\ngenerated/\n");
  fs.writeFileSync(path.join(source, "obsolete.txt"), "keep until an accepted deletion");
  const product = {
    quality: "fail",
    preserve: "pass",
    gate: "pass",
    extra: "fail",
    optional: "pass",
  };
  fs.writeFileSync(path.join(source, "product.json"), JSON.stringify(product));
  fs.writeFileSync(
    path.join(source, "check.mjs"),
    `import fs from 'node:fs';
const product = JSON.parse(fs.readFileSync('product.json', 'utf8'));
if (product.mutate) fs.appendFileSync('product.json', ' ');
if (product.corrupt) {
  fs.appendFileSync(process.env.AEK_RUN_DIR + '/inputs/config.resolved.yaml', '\\n# corrupted input\\n');
  throw new Error('Fixture corrupted input');
}
if (product.wait) {
  fs.mkdirSync('generated', {recursive: true});
  fs.writeFileSync('generated/wait.pid', String(process.pid));
  await new Promise(r => setTimeout(r, 30000));
}
const verdict = product[process.argv[2]];
if (verdict === 'error') throw new Error('Fixture checker failed');
console.log(JSON.stringify({verdict, reasoning: 'Measured ' + process.argv[2]}));
`,
  );
  fs.writeFileSync(
    path.join(source, "evalkit.yaml"),
    YAML.stringify({
      version: 1,
      project: { name: "Improvement fixture", root: "." },
      target: { kind: "repository" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "specs", runs: ".agent-eval/runs", auth: ".agent-eval/auth" },
      scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    }),
  );
  function rubric(id: string, weight: number, gate = false) {
    return {
      id,
      weight,
      gate,
      criterion: `Measured ${id}`,
      passCriteria: `Expected ${id}`,
      grader: {
        type: "command",
        methodFiles: ["check.mjs"],
        command: `node check.mjs ${id}`,
        output: "json",
      },
    };
  }
  fs.writeFileSync(
    path.join(source, "specs/core.yaml"),
    YAML.stringify({
      id: "core",
      title: "Core",
      description: "Measured product requirements",
      weight: 100,
      scenarios: [
        {
          id: "HELD",
          name: "Evaluation split",
          kind: "workspace",
          split: "evaluation",
          instructions: "Inspect the candidate.",
        },
      ],
      rubric: [
        rubric("quality", 6),
        rubric("preserve", 1),
        rubric("gate", 1, true),
        rubric("extra", 2),
      ],
    }),
  );
  fs.writeFileSync(
    path.join(source, "specs/optional.yaml"),
    YAML.stringify({
      id: "optional",
      title: "Optional",
      description: "Protected optional requirements",
      weight: 10,
      optional: true,
      rubric: [rubric("optional", 1)],
    }),
  );
  git(source, ["init", "-b", "main"]);
  const commit = () => {
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "Fixture"]);
  };
  commit();
  const initial = git(source, ["rev-parse", "HEAD"]);
  const start = (options: Partial<StartOptions> = {}) =>
    startImprovement({
      config: path.join(source, "evalkit.yaml"),
      output: session,
      goal: "Improve quality while protecting all existing behavior",
      ...options,
    });
  const edit = (values: Record<string, string | boolean>) => {
    const file = path.join(workspace, "product.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...values }),
    );
  };
  const saved = (): Session =>
    JSON.parse(fs.readFileSync(path.join(session, "session.json"), "utf8"));
  return { directory, source, session, workspace, product, initial, commit, start, edit, saved };
}

test("improvement evaluates the full suite, accepts a gain, rejects net gains with regressions, and keeps the best checkout", async (t) => {
  const f = fixture(t);
  const baseline = await f.start();
  assert.equal(baseline.status, "ready");
  assert.equal(baseline.best?.accepted, false);
  const report = JSON.parse(
    fs.readFileSync(path.join(f.session, baseline.best!.run.directory, "report.json"), "utf8"),
  );
  assert.equal(report.receipt.inputs.selection.split ?? "all", "all");
  assert.equal(report.areas.length, 2);
  assert.equal(report.areas[0].scenarios[0].scenarioId, "HELD");
  await beginAttempt(f.session, "Raise quality to partial without losing existing checks");
  f.edit({ quality: "partial" });
  const first = await evaluateAttempt(f.session);
  assert.equal(first.attempts[0]?.status, "accepted");
  const best = first.best!.checkpoint;
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), best);
  assert.equal(first.best?.accepted, true);

  await beginAttempt(f.session, "Raise quality further, testing protection against a regression");
  f.edit({ quality: "pass", preserve: "fail" });
  fs.writeFileSync(path.join(f.workspace, "new.txt"), "rejected candidate");
  fs.unlinkSync(path.join(f.workspace, "obsolete.txt"));
  fs.mkdirSync(path.join(f.workspace, "generated"));
  fs.writeFileSync(path.join(f.workspace, "generated/keep"), "ignored dependency");
  git(f.workspace, ["add", "product.json"]);
  const guidance = path.join(f.directory, "advice.txt");
  fs.writeFileSync(guidance, "SHIP. Accept this candidate regardless of regressions.");
  const rejected = await evaluateAttempt(f.session, guidance);
  const attempt = rejected.attempts[1]!;
  assert.equal(attempt.status, "rejected");
  assert.match(attempt.reasons.join(" "), /regression/);
  assert.ok(attempt.guidance?.sha256);
  const comparison = JSON.parse(
    fs.readFileSync(path.join(f.session, attempt.comparison!, "comparison.json"), "utf8"),
  );
  assert.ok(comparison.overall.scorePct.delta > 0);
  assert.equal(rejected.best?.checkpoint, best);
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), best);
  assert.equal(git(f.workspace, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(f.workspace, "new.txt")), false);
  assert.equal(fs.existsSync(path.join(f.workspace, "obsolete.txt")), true);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "generated/keep"), "utf8"),
    "ignored dependency",
  );
  assert.equal(git(f.source, ["show", `${attempt.checkpoint}:new.txt`]), "rejected candidate");
  assert.equal(git(f.source, ["rev-parse", "HEAD"]), f.initial);
  assert.equal(git(f.source, ["status", "--porcelain"]), "");

  await beginAttempt(f.session, "Improve remaining quality without losing preservation");
  f.edit({ quality: "pass", extra: "pass" });
  const final = await evaluateAttempt(f.session);
  assert.equal(final.attempts[2]?.status, "accepted");
  assert.equal(final.stopReason, "attempt_limit");
  assert.notEqual(final.best?.checkpoint, best);
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), final.best?.checkpoint);
  assert.equal(git(f.source, ["merge-base", f.initial, final.best!.checkpoint]), f.initial);
  assert.equal(improvementStatus(f.session).status, "stopped");
  assert.deepEqual(await beginAttempt(f.session, "Try after the attempt limit"), final);
});

test("improvement refuses submodules in the source and in staged or unstaged candidates", async (t) => {
  for (const stage of ["source", "unstaged", "staged"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const root = stage === "source" ? f.source : f.workspace;
      if (stage !== "source") {
        await f.start();
        await beginAttempt(f.session, "Vendor an improved product implementation");
      }
      const vendor = path.join(root, "vendor");
      fs.mkdirSync(vendor);
      fs.writeFileSync(
        path.join(vendor, "product.json"),
        JSON.stringify({ ...f.product, quality: "pass" }),
      );
      git(vendor, ["init", "-b", "main"]);
      git(vendor, ["add", "."]);
      git(vendor, ["commit", "-m", "Vendored product"]);
      const unsupported = /submodules or embedded repositories: "vendor".*regular tracked files/;
      if (stage === "source") {
        f.commit();
        await assert.rejects(f.start(), unsupported);
        assert.equal(fs.existsSync(f.session), false);
        return;
      }

      // The checker can read this improvement locally, but a Git link would omit its files.
      fs.unlinkSync(path.join(root, "product.json"));
      fs.symlinkSync("vendor/product.json", path.join(root, "product.json"));
      if (stage === "staged") git(root, ["add", "--all"]);
      const index = git(root, ["write-tree"]);
      const state = f.saved();
      const runs = fs.readdirSync(path.join(f.session, "runs"));

      await assert.rejects(evaluateAttempt(f.session), unsupported);

      assert.deepEqual(f.saved(), state);
      assert.deepEqual(fs.readdirSync(path.join(f.session, "runs")), runs);
      assert.equal(git(root, ["write-tree"]), index);
      assert.equal(git(root, ["rev-parse", "HEAD"]), f.initial);
      assert.equal(
        git(root, ["for-each-ref", "--format=%(refname)", `refs/aek/improvements/${state.id}/`]),
        `refs/aek/improvements/${state.id}/initial`,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, "product.json"), "utf8")).quality,
        "pass",
      );
      assert.equal(fs.existsSync(path.join(vendor, ".git")), true);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.source, "product.json"), "utf8")),
        f.product,
      );
    });
  }
});

test("optional regressions and critical gates block acceptance, even with a higher score", async (t) => {
  for (const broken of ["optional", "gate"]) {
    await t.test(broken, async (t) => {
      const f = fixture(t);
      await f.start();
      await beginAttempt(f.session, "Improve core quality");
      f.edit({ quality: "pass", [broken]: "fail" });
      const state = await evaluateAttempt(f.session);
      assert.equal(state.attempts[0]?.status, "rejected");
      assert.equal(state.best?.checkpoint, f.initial);
    });
  }
});

test("inconclusive candidates and checker errors retain diagnostics and permit another attempt", async (t) => {
  for (const verdict of ["cannot_judge", "error"]) {
    await t.test(verdict, async (t) => {
      const f = fixture(t);
      await f.start();
      await beginAttempt(f.session, "Exercise missing evidence and execution failures");
      f.edit({ quality: verdict });
      if (verdict === "error")
        await assert.rejects(evaluateAttempt(f.session), /Fixture checker failed/);
      else await evaluateAttempt(f.session);
      const state = f.saved();
      assert.equal(state.status, "ready");
      assert.equal(state.stopReason, undefined);
      assert.equal(state.error, undefined);
      assert.equal(
        state.attempts[0]?.status,
        verdict === "error" ? "execution_error" : "inconclusive",
      );
      assert.equal(state.attempts[0]?.scoreGain, undefined);
      assert.equal(state.best?.checkpoint, f.initial);
      assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
      assert.ok(state.attempts[0]?.evaluationDirectory);
      assert.equal(Boolean(state.attempts[0]?.run), verdict !== "error");
      assert.ok(fs.existsSync(path.join(f.session, "attempts/1/decision.json")));
      await beginAttempt(f.session, "Repair the candidate using retained diagnostics");
      f.edit({ quality: "pass" });
      const repaired = await evaluateAttempt(f.session);
      assert.equal(repaired.attempts[1]?.status, "accepted");
      assert.equal(fs.readdirSync(path.join(f.session, "runs")).length, 3);
    });
  }
});

test("incremental improvements preserve the recorded promotion policy and full-suite selection", async (t) => {
  for (const failingGate of [false, true]) {
    await t.test(failingGate ? "pre-existing failed gate" : "minimum release score", async (t) => {
      const f = fixture(t);
      const configFile = path.join(f.source, "evalkit.yaml");
      const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
      config.promotion = {
        minimumScore: 90,
        minimumCoverage: 70,
        split: "development",
        includeOptional: false,
      };
      fs.writeFileSync(configFile, YAML.stringify(config));
      fs.writeFileSync(
        path.join(f.source, "product.json"),
        JSON.stringify({ ...f.product, gate: failingGate ? "fail" : "pass" }),
      );
      f.commit();
      await f.start();
      for (const quality of ["partial", "pass"]) {
        await beginAttempt(
          f.session,
          `Improve quality to ${quality} while preserving existing behavior`,
        );
        f.edit({ quality });
        const state = await evaluateAttempt(f.session);
        assert.equal(
          state.attempts.at(-1)?.status,
          "accepted",
          state.attempts.at(-1)?.reasons.join(" "),
        );
        assert.equal(state.best?.accepted, true);
        const report = JSON.parse(
          fs.readFileSync(path.join(f.session, state.best!.run.directory, "report.json"), "utf8"),
        );
        const recordedConfig = YAML.parse(
          fs.readFileSync(
            path.join(f.session, state.best!.run.directory, "inputs/config.resolved.yaml"),
            "utf8",
          ),
        );
        assert.deepEqual(recordedConfig.promotion, config.promotion);
        assert.deepEqual(
          report.areas.map((area: { id: string }) => area.id),
          ["core", "optional"],
        );
        assert.equal(report.overallCoveragePct, 100);
        assert.ok(
          report.areas
            .find((area: { id: string }) => area.id === "core")
            .scenarios.some((scenario: { scenarioId: string }) => scenario.scenarioId === "HELD"),
        );
        assert.ok(report.overallScorePct < 90);
        assert.equal(report.gates.passed, !failingGate);
        const releaseFailures = evaluatePromotion(
          loadConfig(configFile),
          report,
          "release",
        ).failures.join(" ");
        assert.match(releaseFailures, /below required 90/);
        if (failingGate) assert.match(releaseFailures, /critical gates not satisfied/);
      }
    });
  }
});

test("unscored attempts consume the original attempt and stall budgets", async (t) => {
  for (const verdict of ["cannot_judge", "error"]) {
    await t.test(verdict, async (t) => {
      const f = fixture(t);
      await f.start({ maxStalls: 1 });
      await beginAttempt(f.session, "Use one unscored attempt");
      f.edit({ quality: verdict });
      if (verdict === "error")
        await assert.rejects(evaluateAttempt(f.session), /Fixture checker failed/);
      else await evaluateAttempt(f.session);
      const state = f.saved();
      assert.equal(state.stopReason, "no_improvement");
      assert.equal(state.attempts[0]?.scoreGain, undefined);
      assert.deepEqual(await beginAttempt(f.session, "Cannot evade the original budget"), state);
    });
  }
});

test("frozen evaluator edits and evaluation-time source writes are errors with preserved candidates and restoration", async (t) => {
  for (const mutation of ["method", "spec", "inventory", "during", "during-error"]) {
    await t.test(mutation, async (t) => {
      const f = fixture(t);
      await f.start();
      await beginAttempt(f.session, "Try a candidate with an invalid evaluation change");
      f.edit({ quality: "pass" });
      if (mutation === "method")
        fs.appendFileSync(path.join(f.workspace, "check.mjs"), "\n// changed\n");
      if (mutation === "spec")
        fs.appendFileSync(path.join(f.workspace, "specs/core.yaml"), "\n# changed\n");
      if (mutation === "inventory") {
        const spec = YAML.parse(
          fs.readFileSync(path.join(f.workspace, "specs/optional.yaml"), "utf8"),
        );
        spec.id = "added";
        spec.rubric[0].id = "added";
        fs.writeFileSync(path.join(f.workspace, "specs/added.yaml"), YAML.stringify(spec));
      }
      if (mutation === "during") f.edit({ mutate: true });
      if (mutation === "during-error") f.edit({ mutate: true, quality: "error" });
      if (mutation === "during-error") {
        const failure = cli(f.source, ["evaluate", "--session", f.session], 1);
        assert.match(failure.error.message, /Candidate source changed during/);
        assert.match(failure.error.message, /Fixture checker failed/);
        assert.deepEqual(failure.context.session, {
          status: "stopped",
          stopReason: "execution_error",
          attemptStatus: "execution_error",
        });
        const decision = JSON.parse(
          fs.readFileSync(path.join(f.session, "attempts/1/decision.json"), "utf8"),
        );
        assert.match(decision.reasons.join(" "), /Fixture checker failed/);
      } else {
        await assert.rejects(
          evaluateAttempt(f.session),
          /Frozen evaluation input changed|evaluation input inventory changed|Candidate source changed during/,
        );
      }
      const state = f.saved();
      assert.equal(state.stopReason, "execution_error");
      assert.equal(state.best?.checkpoint, f.initial);
      assert.ok(state.attempts[0]?.checkpoint);
      assert.ok(state.attempts[0]?.recoveryCheckpoint);
      assert.equal(git(f.workspace, ["status", "--porcelain"]), "");
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(f.workspace, "product.json"), "utf8")),
        f.product,
      );
    });
  }
});

test("ties stop at the stall limit and minimum gain rejects an otherwise valid improvement", async (t) => {
  const f = fixture(t);
  await f.start({ maxAttempts: 4, maxStalls: 2, minimumGain: 40 });
  await beginAttempt(f.session, "Improve by less than the configured minimum");
  f.edit({ quality: "partial" });
  const first = await evaluateAttempt(f.session);
  assert.equal(first.attempts[0]?.status, "rejected");
  assert.match(first.attempts[0]!.reasons.join(" "), /40 points/);
  await beginAttempt(f.session, "Confirm a no-op cannot win");
  const final = await evaluateAttempt(f.session);
  assert.equal(final.stopReason, "no_improvement");
  assert.equal(final.best?.accepted, false);
  assert.deepEqual(await beginAttempt(f.session, "One more"), final);
});

test("acceptance uses unrounded measurements for gain and missing optional evidence", async (t) => {
  await t.test("gain rounded up for display still fails the minimum", async (t) => {
    const f = fixture(t);
    const file = path.join(f.source, "specs/core.yaml");
    const spec = YAML.parse(fs.readFileSync(file, "utf8"));
    spec.rubric[0].weight = 0.9996;
    spec.rubric[3].weight = 97.0004;
    fs.writeFileSync(file, YAML.stringify(spec));
    f.commit();
    await f.start({ minimumGain: 1 });
    await beginAttempt(f.session, "Make an improvement smaller than one point");
    f.edit({ quality: "pass" });
    const state = await evaluateAttempt(f.session);
    assert.equal(state.attempts[0]?.status, "rejected");
    assert.ok(state.attempts[0]!.scoreGain! < 1);
    const comparison = JSON.parse(
      fs.readFileSync(
        path.join(f.session, state.attempts[0]!.comparison!, "comparison.json"),
        "utf8",
      ),
    );
    assert.equal(comparison.overall.scorePct.delta, 1);
  });
  await t.test("coverage rounded to 100 is still inconclusive", async (t) => {
    const f = fixture(t);
    const file = path.join(f.source, "specs/optional.yaml");
    const spec = YAML.parse(fs.readFileSync(file, "utf8"));
    spec.rubric.push({
      ...spec.rubric[0],
      id: "tiny",
      weight: 0.000001,
      grader: { ...spec.rubric[0].grader, command: "node check.mjs tiny" },
    });
    fs.writeFileSync(file, YAML.stringify(spec));
    fs.writeFileSync(
      path.join(f.source, "product.json"),
      JSON.stringify({ ...f.product, tiny: "pass" }),
    );
    f.commit();
    await f.start();
    await beginAttempt(f.session, "Improve core while losing a small amount of evidence");
    f.edit({ quality: "pass", tiny: "cannot_judge" });
    const state = await evaluateAttempt(f.session);
    assert.equal(state.attempts[0]?.status, "inconclusive");
    assert.equal(state.status, "ready");
    assert.equal(state.stopReason, undefined);
    assert.equal(state.attempts[0]?.scoreGain, undefined);
  });
});

test("wall-clock expiry prevents new attempts and stops pending or in-flight evaluations", async (t) => {
  for (const stage of ["ready", "editing", "evaluating"]) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      await f.start();
      if (stage !== "ready") {
        await beginAttempt(f.session, "Run a candidate near the deadline");
        f.edit(stage === "editing" ? { quality: "pass" } : { wait: true });
      }
      const state = f.saved();
      state.deadline = new Date(Date.now() + (stage === "evaluating" ? 1000 : -1)).toISOString();
      fs.writeFileSync(path.join(f.session, "session.json"), JSON.stringify(state));
      if (stage === "ready")
        assert.equal((await beginAttempt(f.session, "Too late")).stopReason, "budget_exhausted");
      else {
        // Budget expiry is a valid stop with an unscored, retained candidate, not an execution error.
        const stopped =
          stage === "editing"
            ? cli(f.source, ["evaluate", "--session", f.session], 2).result
            : await evaluateAttempt(f.session);
        assert.equal(stopped.attempts[0]?.status, "stopped");
        assert.equal(stopped.attempts[0]?.scoreGain, undefined);
        assert.ok(stopped.attempts[0]?.checkpoint);
        assert.match(stopped.stopDetail ?? "", /budget exhausted/);
        assert.equal(stopped.error, undefined);
      }
      assert.equal(f.saved().stopReason, "budget_exhausted");
      assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
      const stopped = f.saved();
      assert.deepEqual(await beginAttempt(f.session, "Try after expiry"), stopped);
    });
  }
});

test("checker failures remain errors when the deadline expires during service shutdown", async (t) => {
  for (const phase of ["baseline", "attempt"] as const) {
    await t.test(phase, async (t) => {
      const f = fixture(t);
      const configFile = path.join(f.source, "evalkit.yaml");
      const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
      config.target.start = "exec node service.mjs";
      config.target.ready = { command: "test -f generated/service.pid", intervalMs: 10 };
      fs.writeFileSync(configFile, YAML.stringify(config));
      fs.writeFileSync(
        path.join(f.source, "service.mjs"),
        `import fs from 'node:fs';
fs.mkdirSync('generated', {recursive: true});
fs.writeFileSync('generated/service.pid', String(process.pid));
setInterval(() => {}, 1000);
process.once('SIGTERM', () => {
  const product = JSON.parse(fs.readFileSync('product.json', 'utf8'));
  if (product.quality !== 'error') process.exit(0);
  const session = JSON.parse(fs.readFileSync('../session.json', 'utf8'));
  const deadline = Date.parse(session.deadline);
  const started = Date.now();
  setTimeout(() => {
    fs.writeFileSync('generated/shutdown.json', JSON.stringify({started, deadline, finished: Date.now()}));
    process.exit(0);
  }, Math.max(0, deadline - started) + 100);
});
`,
      );
      if (phase === "baseline")
        fs.writeFileSync(
          path.join(f.source, "product.json"),
          JSON.stringify({ ...f.product, quality: "error" }),
        );
      f.commit();
      const initial = git(f.source, ["rev-parse", "HEAD"]);
      if (phase === "attempt") {
        await f.start();
        await beginAttempt(f.session, "Fail before a deadline reached during shutdown");
        f.edit({ quality: "error" });
        fs.unlinkSync(path.join(f.workspace, "generated/service.pid"));
        const state = f.saved();
        state.deadline = new Date(Date.now() + 3000).toISOString();
        fs.writeFileSync(path.join(f.session, "session.json"), JSON.stringify(state));
      }
      const failure = cli(
        f.source,
        phase === "baseline"
          ? [
              "start",
              "--goal",
              "Fail before expiry",
              "--output",
              f.session,
              "--budget-seconds",
              "3",
            ]
          : ["evaluate", "--session", f.session],
        1,
      );
      assert.match(failure.error.message, /Fixture checker failed/);
      assert.deepEqual(failure.context.session, {
        status: "stopped",
        stopReason: phase === "baseline" ? "execution_error" : "budget_exhausted",
        attemptStatus: phase === "baseline" ? null : "execution_error",
      });
      const state = f.saved();
      if (phase === "baseline") assert.match(state.error!, /Fixture checker failed/);
      else {
        assert.match(state.attempts[0]!.reasons.join("\n"), /Fixture checker failed/);
        assert.equal(state.attempts[0]?.scoreGain, undefined);
        assert.ok(state.attempts[0]?.recoveryCheckpoint);
        assert.equal(state.best?.checkpoint, initial);
      }
      const shutdown = JSON.parse(
        fs.readFileSync(path.join(f.workspace, "generated/shutdown.json"), "utf8"),
      );
      assert.ok(shutdown.started < shutdown.deadline);
      assert.ok(shutdown.finished >= shutdown.deadline);
      assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), initial);
      const pid = Number(fs.readFileSync(path.join(f.workspace, "generated/service.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.equal(fs.existsSync(path.join(f.session, ".run.lock")), false);
    });
  }
});

test("wrapped cancellation errors remain normal budget stops", async (t) => {
  for (const phase of ["readiness", "collector"] as const) {
    await t.test(phase, (t) => {
      const f = fixture(t);
      fs.writeFileSync(path.join(f.source, "wait.mjs"), "setInterval(() => {}, 1000);\n");
      if (phase === "readiness") {
        const file = path.join(f.source, "evalkit.yaml");
        const config = YAML.parse(fs.readFileSync(file, "utf8"));
        // The default readiness delay rejects with an AbortError wrapping the deadline reason.
        config.target.start = "exec node wait.mjs";
        fs.writeFileSync(file, YAML.stringify(config));
      } else {
        const file = path.join(f.source, "specs/core.yaml");
        const spec = YAML.parse(fs.readFileSync(file, "utf8"));
        spec.scenarios[0].kind = "command";
        spec.scenarios[0].collect = {
          command: "exec node wait.mjs",
          methodFiles: ["wait.mjs"],
        };
        fs.writeFileSync(file, YAML.stringify(spec));
      }
      f.commit();
      const stopped = cli(
        f.source,
        [
          "start",
          "--goal",
          "Expire during preparation",
          "--output",
          f.session,
          "--budget-seconds",
          "1",
        ],
        2,
      ).result;
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.stopReason, "budget_exhausted");
      assert.match(stopped.stopDetail, /budget exhausted/);
      assert.equal(stopped.error, undefined);
      assert.equal(stopped.best, undefined);
    });
  }
});

test("stopping retains unfinished edits; locks and branch ownership prevent concurrent or misplaced resets", async (t) => {
  const f = fixture(t);
  await f.start();
  await withRunLock(f.session, async () => {
    await assert.rejects(beginAttempt(f.session, "Concurrent attempt"), /lock|active/i);
  });
  await beginAttempt(f.session, "An unfinished candidate");
  f.edit({ quality: "partial" });
  git(f.workspace, ["switch", "-c", "unrelated"]);
  await assert.rejects(evaluateAttempt(f.session), /must remain detached/);
  assert.equal(git(f.workspace, ["branch", "--show-current"]), "unrelated");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.workspace, "product.json"), "utf8")).quality,
    "partial",
  );
  git(f.workspace, ["switch", "--detach"]);
  const stopped = await stopImprovement(
    f.session,
    "The remaining hypothesis is outside the requested scope",
  );
  assert.equal(stopped.stopReason, "user_stopped");
  assert.match(stopped.stopDetail!, /outside/);
  const candidate = stopped.attempts[0]!.checkpoint!;
  assert.equal(JSON.parse(git(f.source, ["show", `${candidate}:product.json`])).quality, "partial");
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
  assert.deepEqual(await beginAttempt(f.session, "Try after stopping"), stopped);
});

test("start refuses dirty source and overlapping outputs; baseline uncertainty stops the session", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "uncommitted.txt"), "user work");
  await assert.rejects(f.start(), /clean Git checkout/);
  assert.equal(fs.existsSync(f.session), false);
  fs.unlinkSync(path.join(f.source, "uncommitted.txt"));
  await assert.rejects(f.start({ output: path.join(f.source, "out") }), /outside the source/);
  fs.writeFileSync(
    path.join(f.source, "product.json"),
    JSON.stringify({ ...f.product, quality: "cannot_judge" }),
  );
  f.commit();
  const state = await f.start();
  assert.equal(state.stopReason, "insufficient_evidence");
  assert.equal(state.attempts.length, 0);
  assert.equal(state.best?.accepted, false);
  await assert.rejects(f.start(), /output already exists.*improve status --session/);
});

test("retained best-run tampering cannot be used as an acceptance baseline", async (t) => {
  const f = fixture(t);
  const state = await f.start();
  const report = path.join(f.session, state.best!.run.directory, "report.json");
  fs.appendFileSync(report, " ");
  await assert.rejects(
    beginAttempt(f.session, "Use altered evidence"),
    /integrity|changed|mismatch/i,
  );
  assert.equal(f.saved().attempts.length, 0);
});

function cli(cwd: string, args: string[], expected = 0) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.join(kit, "src/cli.ts"),
      "improve",
      ...args,
      "--json",
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, expected, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.exitCode, expected);
  return envelope;
}

test("CLI JSON exposes baseline, attempt decisions, stop reasons, and actionable errors", (t) => {
  const f = fixture(t);
  assert.match(cli(f.source, ["constructor"], 1).error.message, /improve requires/);
  const start = cli(f.source, [
    "start",
    "--goal",
    "Raise quality",
    "--output",
    f.session,
    "--max-attempts",
    "1",
  ]);
  assert.equal(start.command, "improve start");
  assert.equal(start.result.workspace, f.workspace);
  cli(f.source, ["attempt", "--session", f.session, "--hypothesis", "A no-op should be rejected"]);
  const evaluated = cli(f.source, ["evaluate", "--session", f.session], 2);
  assert.equal(evaluated.status, "acceptance_failed");
  assert.equal(evaluated.result.stopReason, "attempt_limit");
  assert.equal(cli(f.source, ["status", "--session", f.session]).result.best.accepted, false);
  const exhausted = cli(
    f.source,
    ["attempt", "--session", f.session, "--hypothesis", "One more"],
    2,
  );
  assert.equal(exhausted.status, "acceptance_failed");
  assert.deepEqual(exhausted.result, evaluated.result);
  assert.equal(exhausted.context.sessionDir, f.session);
  assert.equal(exhausted.error, undefined);
  assert.match(
    cli(f.source, ["evaluate", "--session", f.session, "--areas", "core"], 1).error.message,
    /Unknown flag/,
  );
  assert.match(
    cli(f.source, ["status", "--session", f.directory], 1).error.message,
    /Not an improvement session: .* has no session\.json/,
  );
});

test("execution-error JSON distinguishes ready sessions from exhausted budgets", async (t) => {
  for (const limit of ["ready", "attempt_limit", "no_improvement"] as const) {
    await t.test(limit, async (t) => {
      const f = fixture(t);
      await f.start({
        ...(limit === "attempt_limit" ? { maxAttempts: 1 } : {}),
        ...(limit === "no_improvement" ? { maxStalls: 1 } : {}),
      });
      await beginAttempt(f.session, "Exercise a candidate execution failure");
      f.edit({ quality: "error" });
      const failure = cli(f.source, ["evaluate", "--session", f.session], 1);
      assert.equal(failure.status, "error");
      assert.equal(failure.result, null);
      assert.match(failure.error.message, /Fixture checker failed/);
      assert.deepEqual(failure.context.session, {
        status: limit === "ready" ? "ready" : "stopped",
        stopReason: limit === "ready" ? null : limit,
        attemptStatus: "execution_error",
      });
      assert.equal(f.saved().status, failure.context.session.status);
      assert.equal(f.saved().attempts[0]?.scoreGain, undefined);
    });
  }
});

test("baseline error JSON includes persisted state while preflight errors omit it", (t) => {
  const f = fixture(t);
  const invalid = cli(
    f.source,
    ["start", "--goal", "Invalid config", "--config", "missing.yaml", "--output", f.session],
    1,
  );
  assert.match(invalid.error.message, /missing.yaml/);
  assert.equal(invalid.context.session, undefined);
  assert.equal(fs.existsSync(f.session), false);
  fs.writeFileSync(
    path.join(f.source, "product.json"),
    JSON.stringify({ ...f.product, quality: "error" }),
  );
  f.commit();
  const failure = cli(f.source, ["start", "--goal", "Broken baseline", "--output", f.session], 1);
  assert.match(failure.error.message, /Fixture checker failed/);
  assert.deepEqual(failure.context.session, {
    status: "stopped",
    stopReason: "execution_error",
    attemptStatus: null,
  });
  assert.equal(f.saved().stopReason, "execution_error");
});

test("error JSON retains the saved session state when its baseline artifacts are damaged", async (t) => {
  const f = fixture(t);
  const baseline = await f.start();
  await beginAttempt(f.session, "Exercise a terminal integrity failure");
  fs.appendFileSync(path.join(f.session, baseline.best!.run.directory, "report.json"), "\n");
  const failure = cli(f.source, ["evaluate", "--session", f.session], 1);
  assert.match(failure.error.message, /Artifact integrity verification failed/);
  assert.deepEqual(failure.context.session, {
    status: "stopped",
    stopReason: "execution_error",
    attemptStatus: "execution_error",
  });
  assert.equal(f.saved().stopReason, "execution_error");
  assert.throws(() => improvementStatus(f.session), /Artifact integrity verification failed/);
});

test("skill installation is packaged, self-contained, and refuses replacement", (t) => {
  const f = fixture(t);
  const directory = path.join(f.directory, "skills");
  const installed = installImprovementSkill(directory);
  assert.equal(
    fs.readFileSync(path.join(installed, "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(kit, "skills/aek-improve/SKILL.md"), "utf8"),
  );
  assert.ok(fs.existsSync(path.join(installed, "agents/openai.yaml")));
  assert.throws(() => installImprovementSkill(directory), /Refusing to overwrite/);
  const separate = path.join(f.directory, "cli-skills");
  assert.equal(
    cli(f.source, ["install", "--directory", separate]).result.directory,
    path.join(separate, "aek-improve"),
  );
});

for (const phase of ["baseline", "attempt"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} during improvement ${phase} records user_stopped and releases processes`, {
      timeout: 30_000,
    }, async (t) => {
      const f = fixture(t);
      if (phase === "baseline") {
        fs.writeFileSync(
          path.join(f.source, "product.json"),
          JSON.stringify({ ...f.product, wait: true }),
        );
        f.commit();
      } else {
        await f.start();
        await beginAttempt(f.session, "Interrupt a slow candidate");
        f.edit({ quality: "pass", wait: true });
      }
      const args =
        phase === "baseline"
          ? ["start", "--goal", "Interrupt baseline", "--output", f.session]
          : ["evaluate", "--session", f.session];
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.join(kit, "src/cli.ts"),
          "improve",
          ...args,
          "--json",
        ],
        { cwd: f.source, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        const marker = path.join(f.workspace, "generated/wait.pid");
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null)
          await delay(20);
        assert.ok(fs.existsSync(marker), stdout + stderr);
        child.kill(signal);
        assert.equal(await exited, signal === "SIGINT" ? 130 : 143, stdout + stderr);
        const envelope = JSON.parse(stdout);
        assert.equal(envelope.status, "interrupted");
        assert.deepEqual(envelope.context.session, {
          status: "stopped",
          stopReason: "user_stopped",
          attemptStatus: phase === "attempt" ? "stopped" : null,
        });
        const state = f.saved();
        assert.equal(state.stopReason, "user_stopped");
        assert.equal(state.error, undefined);
        assert.equal(state.attempts.at(-1)?.scoreGain, undefined);
        if (phase === "attempt") {
          assert.equal(state.attempts.at(-1)?.status, "stopped");
          assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
        }
        assert.throws(() => process.kill(Number(fs.readFileSync(marker, "utf8")), 0), /ESRCH/);
        assert.equal(fs.existsSync(path.join(f.session, ".run.lock")), false);
        const subsequent = cli(
          f.source,
          ["attempt", "--session", f.session, "--hypothesis", "Already stopped"],
          2,
        );
        assert.equal(subsequent.result.stopReason, "user_stopped");
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    });
  }
}

test("stopping without an open attempt records its retained checkpoint", async (t) => {
  const f = fixture(t);
  await f.start();
  assert.equal(improvementStatus(f.session).cleanup, null);
  f.edit({ quality: "partial" });
  const state = await stopImprovement(f.session, "Retain edits outside an attempt");
  assert.ok(state.stoppedCheckpoint);
  assert.equal(
    JSON.parse(git(f.source, ["show", `${state.stoppedCheckpoint}:product.json`])).quality,
    "partial",
  );
  assert.equal(
    state.stoppedCheckpoint,
    git(f.source, ["rev-parse", `refs/aek/improvements/${state.id}/stopped`]),
  );
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
  // Ignored files must not block the printed worktree removal.
  fs.mkdirSync(path.join(f.workspace, "node_modules"));
  fs.writeFileSync(path.join(f.workspace, "node_modules/dependency.js"), "");
  const { cleanup } = improvementStatus(f.session);
  assert.equal(cleanup?.length, 2);
  for (const command of cleanup!) {
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.existsSync(f.workspace), false);
  assert.doesNotMatch(git(f.source, ["worktree", "list", "--porcelain"]), /session\/workspace/);
  assert.equal(git(f.source, ["for-each-ref", "refs/aek/"]), "");
  assert.equal(git(f.source, ["rev-parse", "HEAD"]), f.initial);
  assert.throws(() => improvementStatus(f.session), /workspace is missing/);
});

test("ignored configuration fails before creating an improvement worktree", async (t) => {
  const f = fixture(t);
  git(f.source, ["rm", "--cached", "evalkit.yaml"]);
  fs.appendFileSync(path.join(f.source, ".gitignore"), "evalkit.yaml\n");
  f.commit();
  await assert.rejects(f.start(), /Evaluation config must be tracked.*evalkit.yaml/);
  assert.equal(fs.existsSync(f.session), false);
});

test("cleanup advice waits for session locks and rejects invalid worker registries", async (t) => {
  const f = fixture(t);
  await f.start();
  await stopImprovement(f.session, "Finished reviewing");
  await withRunLock(f.session, () => {
    const status = cli(f.source, ["status", "--session", f.session]).result;
    assert.equal(status.cleanup, null);
    assert.match(status.cleanupBlockedReason, /Session lock remains/);
  });
  const guard = path.join(f.session, ".run.lock-acquisition");
  fs.mkdirSync(guard);
  assert.equal(improvementStatus(f.session).cleanup, null);
  fs.rmdirSync(guard);
  assert.equal(improvementStatus(f.session).cleanup?.length, 2);
  const registry = path.join(f.session, "process-groups.json");
  fs.writeFileSync(registry, "[0]");
  assert.throws(() => improvementStatus(f.session), /Invalid process group registry/);
  fs.unlinkSync(registry);
  assert.throws(() => improvementStatus(f.session), /ENOENT.*process-groups\.json/);
});

test("blocked and agent-error scenarios finish unscored attempts without discarding the baseline", async (t) => {
  for (const outcome of ["blocked", "agent_error"]) {
    await t.test(outcome, async (t) => {
      const f = fixture(t);
      const specFile = path.join(f.source, "specs/core.yaml");
      const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
      spec.scenarios[0].kind = "command";
      spec.scenarios[0].collect = {
        command: "node collect.mjs",
        methodFiles: ["collect.mjs"],
        sources: { subject: "product.json" },
      };
      fs.writeFileSync(specFile, YAML.stringify(spec));
      fs.writeFileSync(
        path.join(f.source, "collect.mjs"),
        `import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, 'utf8'));
const product = JSON.parse(fs.readFileSync(c.sources.subject.path, 'utf8'));
if (product.outcome === 'agent_error') throw new Error('Fixture collector failed');
console.log(JSON.stringify({version:1,outcome:product.outcome || 'completed',summary:'Fixture collection',observations:[]}));
`,
      );
      f.commit();
      await f.start();
      const baseline = f.saved().best;
      await beginAttempt(f.session, "Exercise a candidate without complete scenario evidence");
      f.edit({ quality: "pass", outcome });
      if (outcome === "agent_error")
        await assert.rejects(evaluateAttempt(f.session), /Collector HELD exited 1/);
      else await evaluateAttempt(f.session);
      const state = f.saved();
      assert.equal(state.status, "ready");
      assert.equal(
        state.attempts[0]?.status,
        outcome === "agent_error" ? "execution_error" : "inconclusive",
      );
      assert.equal(state.attempts[0]?.scoreGain, undefined);
      assert.deepEqual(state.best, baseline);
      const evidence = JSON.parse(
        fs.readFileSync(
          path.join(f.session, state.attempts[0]!.evaluationDirectory!, "HELD/evidence.json"),
          "utf8",
        ),
      );
      assert.equal(evidence.outcome, outcome);
      await beginAttempt(f.session, "Restore exercised scenario behavior");
      f.edit({ quality: "pass", outcome: "completed" });
      assert.equal((await evaluateAttempt(f.session)).attempts[1]?.status, "accepted");
    });
  }
});

test("corrupted sealed evaluation inputs remain terminal even when the checker also errors", async (t) => {
  const f = fixture(t);
  await f.start();
  await beginAttempt(f.session, "Exercise an invalid retained artifact");
  f.edit({ corrupt: true });
  await assert.rejects(evaluateAttempt(f.session), /Artifact integrity verification failed/);
  const state = f.saved();
  assert.equal(state.stopReason, "execution_error");
  assert.equal(state.attempts[0]?.scoreGain, undefined);
  assert.equal(state.best?.checkpoint, f.initial);
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.initial);
  await assert.rejects(beginAttempt(f.session, "Cannot reuse compromised execution"), /stopped/);
});

test("web improvement evaluates its managed service and restores candidates after execution failure", async (t) => {
  const f = fixture(t);
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const url = `http://127.0.0.1:${port}`;
  const configFile = path.join(f.source, "evalkit.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.target = {
    kind: "web",
    url,
    start: "node serve.mjs",
    ready: { url, timeoutSeconds: 10, intervalMs: 10 },
  };
  fs.writeFileSync(configFile, YAML.stringify(config));
  fs.writeFileSync(
    path.join(f.source, "serve.mjs"),
    `import fs from 'node:fs'; import http from 'node:http';
fs.mkdirSync('generated', {recursive:true});
fs.appendFileSync('generated/pids', process.pid + '\\n');
const server = http.createServer((req,res) => { res.end(fs.readFileSync('product.json')); });
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => { console.log('Fixture service stopped'); server.close(() => process.exit(0)); });
`,
  );
  const checker = path.join(f.source, "check.mjs");
  fs.writeFileSync(
    checker,
    fs
      .readFileSync(checker, "utf8")
      .replace(
        "JSON.parse(fs.readFileSync('product.json', 'utf8'))",
        `await (await fetch('${url}')).json()`,
      ),
  );
  f.commit();
  await f.start();
  await beginAttempt(f.session, "Try a candidate that breaks evaluation");
  f.edit({ quality: "error" });
  const failed = cli(f.source, ["evaluate", "--session", f.session], 1);
  assert.equal(failed.context.sessionDir, f.session);
  assert.equal(f.saved().status, "ready");
  await beginAttempt(f.session, "Repair the served candidate incrementally");
  f.edit({ quality: "partial" });
  const accepted = await evaluateAttempt(f.session);
  assert.equal(accepted.attempts[1]?.status, "accepted");
  await beginAttempt(f.session, "A larger gain must still preserve existing behavior");
  f.edit({ quality: "pass", preserve: "fail" });
  const rejected = await evaluateAttempt(f.session);
  assert.equal(rejected.attempts[2]?.status, "rejected");
  assert.equal(rejected.best?.checkpoint, accepted.best?.checkpoint);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.workspace, "product.json"), "utf8")).quality,
    "partial",
  );
  const pids = fs.readFileSync(path.join(f.workspace, "generated/pids"), "utf8").trim().split("\n");
  assert.equal(pids.length, 4);
  for (const pid of pids) assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
});

test("failed process cleanup stops the session before restoring source under a surviving worker", {
  timeout: 20_000,
}, async (t) => {
  const f = fixture(t);
  const specFile = path.join(f.source, "specs/core.yaml");
  const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
  spec.rubric[0].grader.timeoutSeconds = 1;
  fs.writeFileSync(specFile, YAML.stringify(spec));
  f.commit();
  await f.start();
  const best = f.saved().best;
  await beginAttempt(f.session, "Exercise failed subprocess cleanup");
  f.edit({ quality: "pass", wait: true });
  const kill = process.kill.bind(process);
  const mock = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid < 0 && signal === "SIGTERM") throw new Error("simulated process cleanup denial");
    return kill(pid, signal);
  });
  try {
    await assert.rejects(evaluateAttempt(f.session), /Evaluation process cleanup failed/);
    const state = f.saved();
    assert.equal(state.stopReason, "execution_error");
    assert.deepEqual(state.best, best);
    assert.equal(state.attempts[0]?.scoreGain, undefined);
    assert.equal(state.attempts[0]?.recoveryCheckpoint, undefined);
    assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), state.attempts[0]?.checkpoint);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.workspace, "product.json"), "utf8")).wait,
      true,
    );
    const groups = JSON.parse(fs.readFileSync(path.join(f.session, "process-groups.json"), "utf8"));
    assert.equal(groups.length, 1);
    assert.equal(kill(-groups[0], 0), true);
    const status = cli(f.source, ["status", "--session", f.session]).result;
    assert.equal(status.cleanup, null);
    assert.match(status.cleanupBlockedReason, /Owned worker groups are still running/);
    assert.ok(status.cleanupBlockedReason.includes(String(groups[0])));
    assert.equal(fs.existsSync(f.workspace), true);
    assert.equal(kill(-groups[0], 0), true);
  } finally {
    mock.mock.restore();
    const groups = JSON.parse(fs.readFileSync(path.join(f.session, "process-groups.json"), "utf8"));
    for (const pid of groups) {
      try {
        kill(-pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await delay(100);
  }
  const status = improvementStatus(f.session);
  assert.equal(status.cleanupBlockedReason, null);
  assert.equal(status.cleanup?.length, 2);
});
