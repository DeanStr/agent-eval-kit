import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { findConfigFile } from "../src/config.js";
import { formatDuration, formatPct, formatPoints, plural } from "../src/format.js";
import { listRuns, resolveRunReference } from "../src/run-references.js";
import { pruneRuns } from "../src/runs.js";
import { chooseSkillsDirectory } from "../src/skills.js";
import { closestMatch, didYouMean } from "../src/suggest.js";
import { ensureGitignore, starterProviders } from "../src/templates.js";
import { KIT_VERSION } from "../src/version.js";

const kitRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(kitRoot, "node_modules", "tsx", "dist", "cli.mjs");
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "aek-ux-test-"));

function aek(cwd: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [tsxCli, path.join(kitRoot, "src/cli.ts"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 10 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
}

/** The offline first-run cart project: two command checks and one manual review. */
function cartProject(t: test.TestContext): string {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(kitRoot, "examples/first-run"), root, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  return root;
}

function breakCart(root: string): void {
  fs.writeFileSync(
    path.join(root, "cart.mjs"),
    "export function total(lines) {\n  return lines.reduce((sum, line) => sum + line.priceCents, 0);\n}\n",
  );
}

test("suggestions match typos without guessing at unrelated input", () => {
  assert.equal(closestMatch("rn", ["run", "runs", "init"]), "run");
  assert.equal(closestMatch("fail-under-scor", ["fail-under-score", "json"]), "fail-under-score");
  assert.equal(closestMatch("comand", ["llm", "command", "manual"]), "command");
  assert.equal(closestMatch("RUN", ["run"]), "run");
  assert.equal(closestMatch("run", ["run"]), undefined);
  assert.equal(closestMatch("bogus", ["run", "init", "check"]), undefined);
  assert.equal(didYouMean("promot", ["promote", "list"]), " Did you mean `promote`?");
});

test("display formatters round percentages and pluralize", () => {
  assert.equal(formatPct(86.6667), "86.7%");
  assert.equal(formatPct(25), "25%");
  assert.equal(formatPct(null), "n/a");
  assert.equal(formatPoints(-75), "-75 points");
  assert.equal(formatPoints(1), "+1 point");
  assert.equal(plural(1, "area"), "1 area");
  assert.equal(plural(2, "criterion", "criteria"), "2 criteria");
  assert.equal(formatDuration(125_000), "2 min 5 s");
});

test("version, help topics, and typo suggestions", () => {
  for (const flag of ["--version", "-v"]) {
    const version = aek(os.tmpdir(), [flag]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), KIT_VERSION);
  }
  const help = aek(os.tmpdir(), ["help", "baseline", "promote"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: aek baseline promote/);
  assert.match(help.stdout, /--run <run>/);
  const overview = aek(os.tmpdir(), ["--help"]);
  assert.ok(overview.stdout.indexOf("init [directory]") < overview.stdout.indexOf("image compare"));
  const command = aek(os.tmpdir(), ["rn"]);
  assert.equal(command.status, 1);
  assert.match(command.stderr, /Unknown command rn\. Did you mean `aek run`\?/);
  assert.doesNotMatch(command.stderr, /Getting started/, "an unknown command must not dump help");
  const flag = aek(os.tmpdir(), ["run", "--fail-under-scor", "50"]);
  assert.match(flag.stderr, /Unknown flag: --fail-under-scor\. Did you mean --fail-under-score\?/);
  assert.match(flag.stderr, /aek run --help/);
  const subcommand = aek(os.tmpdir(), ["baseline", "promot"]);
  assert.match(
    subcommand.stderr,
    /baseline requires promote or list \(got promot\)\. Did you mean `promote`\?/,
  );
});

test("config discovery searches parents up to the repository root", (t) => {
  const root = cartProject(t);
  const nested = path.join(root, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findConfigFile(nested), path.join(root, "evalkit.yaml"));
  const validated = aek(nested, ["validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /Using \.\.\/\.\.\/evalkit\.yaml/);
  assert.match(validated.stdout, /1 area, 1 scenario template, 1 executable case, 3 rubric items/);

  const outside = temporary();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "evalkit.yaml"), "version: 1\n");
  const repository = path.join(outside, "repository");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  assert.equal(findConfigFile(repository), undefined, "search stops at the Git root");
  const missing = aek(repository, ["validate"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No evalkit\.yaml in .* or its parent directories\. Run `aek init`/);
  const explicit = aek(repository, ["validate", "--config", "nope.yaml"]);
  assert.match(explicit.stderr, /Config file not found: .*nope\.yaml/);
  assert.doesNotMatch(explicit.stderr, /aek init/);
});

test("YAML validation suggests the intended key and value", (t) => {
  const root = cartProject(t);
  const file = path.join(root, "specs/cart.yaml");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("passCriteria: Two items", "passCriterion: Two items")
      .replace(
        "type: command, methodFiles: [check.mjs], output: json, command: node check.mjs empty",
        "type: comand, methodFiles: [check.mjs], output: json, command: node check.mjs empty",
      ),
  );
  const result = aek(root, ["validate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid specs\/cart\.yaml:/);
  assert.match(result.stderr, /Unknown key "passCriterion"\. Did you mean "passCriteria"\?/);
  assert.doesNotMatch(
    result.stderr,
    /passCriteria: Invalid input/,
    "the typo explains the missing key",
  );
  assert.match(result.stderr, /Did you mean "command"\?/);
});

test("runs explain each criterion, resolve run aliases, and compare by name", (t) => {
  const root = cartProject(t);
  const good = aek(root, ["run"]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /✓ QUANTITY pass · gate {2}Expected 1000 cents; received 1000 cents\./);
  assert.match(good.stdout, /○ RECEIPT {2}pending manual review/);
  assert.match(
    good.stdout,
    /Result: 100% score · 80% coverage · 1 critical gate passed · 1 manual review pending/,
  );
  assert.match(good.stdout, /aek finalize --run \.agent-eval\/runs\/\S+ --interactive/);

  breakCart(root);
  const broken = aek(root, ["run", "--json"]);
  assert.equal(broken.status, 2);
  const envelope = JSON.parse(broken.stdout);
  const quantity = envelope.result.items.find(
    (item: { itemId: string }) => item.itemId === "QUANTITY",
  );
  assert.equal(quantity.verdict, "fail");
  assert.equal(quantity.gate, "failed");
  assert.match(quantity.reasoning, /received 500 cents/);
  assert.equal(
    envelope.result.items.find((item: { itemId: string }) => item.itemId === "RECEIPT")
      .manualPending,
    true,
  );
  assert.match(broken.stderr, /✗ QUANTITY fail · gate/);
  assert.match(broken.stderr, /aek compare --baseline \.agent-eval\/runs\/\S+ --candidate/);
  assert.match(
    broken.stderr,
    /Acceptance failed: critical gates not satisfied: cart\/QUANTITY failed \(Critical criterion received fail; critical gates require a full pass\)/,
  );

  const runs = listRuns(path.join(root, ".agent-eval/runs"));
  const [first, second] = runs.map((entry) => entry.directory);
  const runsDir = () => path.join(root, ".agent-eval/runs");
  assert.equal(
    resolveRunReference("latest", { flag: "run", requirement: "report", runsDir }),
    second,
  );
  assert.equal(
    resolveRunReference("previous", { flag: "run", requirement: "report", runsDir }),
    first,
  );
  assert.equal(
    resolveRunReference(path.basename(first!), { flag: "run", requirement: "report", runsDir }),
    first,
  );
  assert.throws(
    () => resolveRunReference("latest", { flag: "resume", requirement: "resumable-run", runsDir }),
    /--resume latest needs at least one incomplete runs .* found 0/,
  );
  assert.throws(
    () =>
      resolveRunReference(`${path.basename(first!)}x`, {
        flag: "run",
        requirement: "report",
        runsDir,
      }),
    /no run directory or run ID .* Did you mean/,
  );

  const compared = aek(root, [
    "compare",
    "--baseline",
    "previous",
    "--candidate",
    "latest",
    "--fail-on-regression",
  ]);
  assert.equal(compared.status, 2, compared.stderr);
  assert.match(compared.stdout, /score 100% → 25% \(-75 points\)/);
  assert.match(compared.stdout, /Regressed: QUANTITY now fails; 1 critical gate newly failing/);
  assert.match(
    compared.stdout,
    /✗ cart\/QUANTITY pass → fail {2}Expected 1000 cents; received 500 cents\./,
  );
  assert.match(compared.stderr, /Acceptance failed: regressions: cart\/QUANTITY \(pass → fail\)/);

  const listed = aek(root, ["runs", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /RUN\s+STATUS\s+SCORE\s+Δ\s+COVERAGE\s+GATES\s+MANUAL/);
  assert.match(listed.stdout, /complete\s+25%\s+-75\s+80%\s+failed\s+1/);
  assert.match(listed.stdout, /Score trend: \S+ {2}100% → 25%/);

  const reportFile = path.join(first!, "report.json");
  const original = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  for (const invalid of [{}, null, { ...original, overallScorePct: 101 }]) {
    fs.writeFileSync(reportFile, JSON.stringify(invalid));
    const history = aek(root, ["runs", "list", "--json"]);
    assert.equal(history.status, 0, history.stderr);
    const entries = JSON.parse(history.stdout).result.runs;
    const unreadable = entries.find((entry: { directory: string }) => entry.directory === first);
    assert.equal(unreadable.status, "unreadable");
    assert.equal(unreadable.scorePct, null);
    assert.equal(unreadable.gatesPassed, null);
    assert.match(unreadable.error, /Invalid Agent Eval Kit report:/);
    assert.ok(unreadable.error.includes(reportFile));
    assert.equal(
      entries.find((entry: { directory: string }) => entry.directory === second).scorePct,
      25,
    );
  }
});

test("finalize explains missing verdicts and records interactive answers", async (t) => {
  const root = cartProject(t);
  assert.equal(aek(root, ["run"]).status, 0);
  const missing = aek(root, ["finalize", "--run", "latest"]);
  assert.equal(missing.status, 1);
  assert.match(
    missing.stderr,
    /No manual verdicts are recorded in .*manual-results\.json; pending: cart\/RECEIPT/,
  );
  assert.match(missing.stderr, /--interactive/);

  const unrecognized = aek(
    root,
    ["finalize", "--run", "latest", "--interactive"],
    "reviewer-a\nmaybe\n",
  );
  assert.equal(unrecognized.status, 1);
  assert.match(unrecognized.stderr, /Unrecognized answer "maybe"/);
  assert.match(unrecognized.stderr, /Input ended before cart\/RECEIPT was answered/);

  const child = spawn(
    process.execPath,
    [
      tsxCli,
      path.join(kitRoot, "src/cli.ts"),
      "finalize",
      "--run",
      "latest",
      "--interactive",
      "--json",
    ],
    {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const finished = once(child, "close", { signal: AbortSignal.timeout(15_000) });
  // Leave stdin open like a terminal: finishing the review must not require EOF.
  child.stdin.write("reviewer-a\np\nApproved by product\n");
  const [exitCode] = await finished;
  assert.equal(exitCode, 0, stderr);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.result.coveragePct, 100);
  assert.equal(envelope.result.manualPending, 0);
  const runDir = envelope.result.runDir;
  const manual = JSON.parse(fs.readFileSync(path.join(runDir, "manual-results.json"), "utf8"));
  assert.equal(manual.RECEIPT.verdict, "pass");
  assert.equal(manual.RECEIPT.reviewer, "reviewer-a");
  assert.equal(manual.RECEIPT.notes, "Approved by product");
  assert.equal(aek(root, ["verify", "--run", "latest"]).status, 0);
});

test("interactive finalization preserves earlier reviewers and revision history", async (t) => {
  for (const explicitReviewer of [false, true]) {
    await t.test(explicitReviewer ? "reviewer flag" : "prompted reviewer", (t) => {
      const root = cartProject(t);
      const specFile = path.join(root, "specs/cart.yaml");
      const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
      spec.rubric.push({ ...spec.rubric.at(-1), id: "OTHER" });
      fs.writeFileSync(specFile, YAML.stringify(spec));
      assert.equal(aek(root, ["run"]).status, 0);
      const first = aek(
        root,
        ["finalize", "--run", "latest", "--interactive", "--json"],
        "Alice\np\nAlice reviewed the receipt\ns\n",
      );
      assert.equal(first.status, 0, first.stderr);
      const runDir = JSON.parse(first.stdout).result.runDir;
      const manualFile = path.join(runDir, "manual-results.json");
      const historyFile = path.join(runDir, "manual-revisions.ndjson");
      const alice = JSON.parse(fs.readFileSync(manualFile, "utf8")).RECEIPT;
      const history = fs.readFileSync(historyFile, "utf8");
      const args = ["finalize", "--run", "latest", "--interactive", "--json"];
      if (explicitReviewer) args.push("--reviewer", "Bob");
      const second = aek(
        root,
        args,
        `${explicitReviewer ? "" : "Bob\n"}p\nBob reviewed the other item\n`,
      );
      assert.equal(second.status, 0, second.stderr);
      assert.equal(JSON.parse(second.stdout).result.manualPending, 0);
      const manual = JSON.parse(fs.readFileSync(manualFile, "utf8"));
      assert.deepEqual(manual.RECEIPT, alice);
      assert.equal(manual.OTHER.reviewer, "Bob");
      const revisions = fs.readFileSync(historyFile, "utf8");
      assert.ok(revisions.startsWith(history));
      assert.deepEqual(
        revisions
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).itemId),
        ["RECEIPT", "OTHER"],
      );
      assert.equal(aek(root, ["verify", "--run", "latest"]).status, 0);
    });
  }
});

test("interactive finalization handles signals without retaining partial answers or locks", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    await t.test(signal, async (t) => {
      const root = cartProject(t);
      const specFile = path.join(root, "specs/cart.yaml");
      const spec = YAML.parse(fs.readFileSync(specFile, "utf8"));
      spec.rubric.push({ ...spec.rubric.at(-1), id: "OTHER" });
      fs.writeFileSync(specFile, YAML.stringify(spec));
      const run = aek(root, ["run", "--json"]);
      assert.equal(run.status, 0, run.stderr);
      const runDir = JSON.parse(run.stdout).result.runDir;
      const files = [
        "manual-results.json",
        "manual-checklist.md",
        "report.json",
        "report.html",
        "receipt.json",
        "artifact-index.json",
      ];
      const before = files.map((file) => fs.readFileSync(path.join(runDir, file), "utf8"));
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          path.join(kitRoot, "src/cli.ts"),
          "finalize",
          "--run",
          "latest",
          "--interactive",
          "--json",
        ],
        {
          cwd: root,
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      t.after(() => child.kill("SIGKILL"));
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      const marker = signal === "SIGINT" ? "Reviewer" : "[2/2] cart/OTHER";
      const prompted = new Promise<void>((resolve) => {
        child.stderr.on("data", (data) => {
          stderr += data;
          if (stderr.includes(marker)) resolve();
        });
      });
      const exited = once(child, "close", { signal: AbortSignal.timeout(15_000) });
      // SIGTERM arrives after one complete answer, while the second item is still pending.
      if (signal === "SIGTERM") child.stdin.write("reviewer-a\np\nUncommitted first answer\n");
      await Promise.race([
        prompted,
        exited.then(() => {
          throw new Error(`Review exited before a prompt: ${stderr}`);
        }),
      ]);
      child.kill(signal);
      const [exitCode, exitSignal] = await exited;
      assert.equal(exitCode, signal === "SIGINT" ? 130 : 143, stderr);
      assert.equal(exitSignal, null);
      const envelope = JSON.parse(stdout);
      assert.equal(envelope.status, "interrupted");
      assert.equal(envelope.exitCode, exitCode);
      assert.equal(envelope.result, null);
      assert.equal(envelope.context.runDir, runDir);
      assert.deepEqual(
        files.map((file) => fs.readFileSync(path.join(runDir, file), "utf8")),
        before,
      );
      assert.equal(fs.existsSync(path.join(runDir, "manual-revisions.ndjson")), false);
      assert.equal(fs.existsSync(path.join(runDir, ".run.lock")), false);
      assert.equal(fs.existsSync(path.join(runDir, ".run.lock-acquisition")), false);
      assert.equal(aek(root, ["verify", "--run", "latest"]).status, 0);
    });
  }
});

test("check runs command checkers without creating a run", (t) => {
  const root = cartProject(t);
  const passed = aek(root, ["check"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /✓ cart\/QUANTITY {2}pass/);
  assert.match(passed.stdout, /2 checkers: 2 passed, 0 did not pass, 0 execution errors/);
  assert.equal(fs.existsSync(path.join(root, ".agent-eval")), false);

  breakCart(root);
  const failed = aek(root, ["check", "cart/QUANTITY", "--json"]);
  assert.equal(failed.status, 2);
  const result = JSON.parse(failed.stdout).result.checks;
  assert.deepEqual(
    result.map((check: { itemId: string; verdict: string }) => [check.itemId, check.verdict]),
    [["QUANTITY", "fail"]],
  );
  assert.match(
    aek(root, ["check", "RECEIPT"]).stderr,
    /manual grader; aek check runs only command checkers/,
  );
  assert.match(
    aek(root, ["check", "QUANTIT"]).stderr,
    /No rubric item QUANTIT\. Did you mean `QUANTITY`\?/,
  );

  fs.writeFileSync(path.join(root, "check.mjs"), "console.log('not json');\n");
  const broken = aek(root, ["check", "EMPTY"]);
  assert.equal(broken.status, 1);
  assert.match(
    broken.stdout + broken.stderr,
    /! cart\/EMPTY {2}checker error .*expected one JSON object on stdout/,
  );
});

test("check respects declared applicability and explains explicit exclusions", (t) => {
  const root = cartProject(t);
  const file = path.join(root, "specs/cart.yaml");
  const spec = YAML.parse(fs.readFileSync(file, "utf8"));
  const excluded = spec.rubric.find((item: { id: string }) => item.id === "EMPTY");
  excluded.applicability = {
    applicable: false,
    reason: "This target does not support empty carts",
  };
  excluded.grader.command = "node excluded-check.mjs";
  excluded.grader.methodFiles = ["excluded-check.mjs"];
  fs.writeFileSync(file, YAML.stringify(spec));
  fs.writeFileSync(
    path.join(root, "excluded-check.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('excluded-ran', 'executed'); console.log(JSON.stringify({verdict: 'fail', reasoning: 'Excluded checker must not run'}));\n",
  );
  const normal = aek(root, ["run", "--json"]);
  assert.equal(normal.status, 0, normal.stderr);
  const checked = aek(root, ["check", "--json"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(
    JSON.parse(checked.stdout).result.checks.map((item: { itemId: string }) => item.itemId),
    ["QUANTITY"],
  );
  assert.equal(fs.existsSync(path.join(root, "excluded-ran")), false);
  for (const selector of ["EMPTY", "cart/EMPTY"]) {
    const explicit = aek(root, ["check", selector]);
    assert.equal(explicit.status, 1);
    assert.match(
      explicit.stderr,
      /cart\/EMPTY is declared inapplicable: This target does not support empty carts/,
    );
  }
  const quantity = spec.rubric.find((item: { id: string }) => item.id === "QUANTITY");
  quantity.gate = false;
  quantity.applicability = {
    applicable: false,
    reason: "No quantity checks apply to this target",
  };
  fs.writeFileSync(file, YAML.stringify(spec));
  const none = aek(root, ["check"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No applicable standalone command checkers/);
  assert.equal(fs.existsSync(path.join(root, "excluded-ran")), false);
});

test("check rejects malformed selectors before executing any checker", (t) => {
  const root = cartProject(t);
  fs.writeFileSync(
    path.join(root, "check.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('checker-ran', 'executed'); console.log(JSON.stringify({verdict: 'pass', reasoning: 'Should not execute'}));\n",
  );
  for (const selectors of [
    ["cart/QUANTITY/garbage"],
    ["cart//QUANTITY"],
    ["cart/QUANTITY/"],
    ["/QUANTITY"],
    ["cart/"],
    [""],
    ["QUANTITY", "cart/QUANTITY/garbage"],
  ]) {
    const result = aek(root, ["check", ...selectors]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Invalid rubric selector .*expected ID or area\/ID/);
    assert.equal(fs.existsSync(path.join(root, "checker-ran")), false);
  }
});

test("checker helpers emit the command grader contract", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "check.ts");
  fs.writeFileSync(
    script,
    `import { expectEqual, pass } from ${JSON.stringify(path.join(kitRoot, "src/grader.ts"))};\nexpectEqual("total", { cents: 500 }, { cents: 1000 });\ntry { pass("again"); } catch (error) { console.error(String(error)); }\n`,
  );
  const result = spawnSync(process.execPath, [tsxCli, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    verdict: "fail",
    confidence: "high",
    reasoning: "total: expected { cents: 1000 }; received { cents: 500 }.",
    evidenceRefs: [],
  });
  assert.match(result.stderr, /must report exactly one verdict/);
});

test("runs prune keeps the newest runs and supports a dry run", (t) => {
  const root = cartProject(t);
  for (let index = 0; index < 3; index++) assert.equal(aek(root, ["run"]).status, 0);
  const runsDir = path.join(root, ".agent-eval/runs");
  const before = listRuns(runsDir).map((entry) => entry.runId);
  assert.throws(() => pruneRuns(runsDir, { dryRun: true }), /requires --keep/);
  const preview = aek(root, ["runs", "prune", "--keep", "1", "--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Would delete 2 runs/);
  assert.deepEqual(
    listRuns(runsDir).map((entry) => entry.runId),
    before,
  );
  const none = pruneRuns(runsDir, { keep: 1, olderThanDays: 30, dryRun: false });
  assert.equal(none.deleted.length, 0, "both limits must apply");
  const pruned = pruneRuns(runsDir, { keep: 1, dryRun: false });
  assert.deepEqual(
    pruned.deleted.map((run) => run.runId),
    before.slice(0, 2),
  );
  assert.deepEqual(
    listRuns(runsDir).map((entry) => entry.runId),
    before.slice(2),
  );
});

test("init writes .gitignore, chooses distinct providers, and needs no scenario for commands", (t) => {
  assert.deepEqual(starterProviders("web", ["codex", "claude"]), {
    agent: "codex",
    judge: "claude",
    detected: ["codex", "claude"],
  });
  assert.deepEqual(starterProviders("web", []), { agent: "codex", judge: "codex", detected: [] });
  assert.deepEqual(starterProviders("command", ["claude"]), {
    agent: "mock",
    judge: "mock",
    detected: ["claude"],
  });
  assert.deepEqual(starterProviders("web", ["codex"], { agent: "grok", judge: "claude" }), {
    agent: "grok",
    judge: "claude",
  });

  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = aek(root, [
    "init",
    "--kind",
    "repository",
    "--agent",
    "claude",
    "--judge",
    "codex",
  ]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created in \.:\n {2}evalkit\.yaml/);
  assert.match(created.stdout, /\.gitignore \(created \.agent-eval\/\)/);
  assert.match(created.stdout, /Providers: agent claude, judge codex/);
  const config = YAML.parse(fs.readFileSync(path.join(root, "evalkit.yaml"), "utf8"));
  assert.equal(config.agent.provider, "claude");
  assert.equal(config.judge.provider, "codex");
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.agent-eval\/$/m);
  assert.equal(ensureGitignore(root), "unchanged");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules");
  assert.equal(ensureGitignore(root), "updated");
  assert.equal(
    fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n")[0],
    "node_modules",
  );
  assert.equal(ensureGitignore(root), "unchanged");

  const command = temporary();
  t.after(() => fs.rmSync(command, { recursive: true, force: true }));
  assert.equal(aek(command, ["init", "--kind", "command"]).status, 0);
  const spec = YAML.parse(fs.readFileSync(path.join(command, "evals/specs/core.yaml"), "utf8"));
  assert.deepEqual(spec.scenarios, []);
  assert.equal(aek(command, ["validate"]).status, 0);
  assert.match(
    aek(command, ["init", "--kind", "visul"]).stderr,
    /Unknown starter visul; .*Did you mean `visual`\?/,
  );
});

test("skills install chooses the agent's directory and installs both skills", (t) => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(chooseSkillsDirectory({}, root).directory, path.join(root, ".agents/skills"));
  fs.mkdirSync(path.join(root, ".claude"));
  assert.deepEqual(chooseSkillsDirectory({}, root), {
    directory: path.join(root, ".claude/skills"),
    reason: "found .claude/ (Claude Code)",
  });
  assert.equal(
    chooseSkillsDirectory({ agent: "codex" }, root).directory,
    path.join(root, ".agents/skills"),
  );
  assert.throws(() => chooseSkillsDirectory({ agent: "vim" }, root), /--agent must be one of/);
  const installed = aek(root, ["skills", "install"]);
  assert.equal(installed.status, 0, installed.stderr);
  for (const skill of ["aek-author", "aek-improve"])
    assert.ok(fs.existsSync(path.join(root, ".claude/skills", skill, "SKILL.md")));
  assert.equal(
    fs.existsSync(path.join(root, ".claude/skills/aek-author/references/docs/history")),
    false,
  );
  const again = aek(root, ["skills", "install"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /Refusing to overwrite/);
});
