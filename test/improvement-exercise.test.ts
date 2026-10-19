import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const example = path.join(repository, "examples/improvement-exercise");
const { recordDecision } = await import(path.join(example, "record-decision.mjs"));
function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-improvement-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function invoke(script: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

test("exercise checker rejects invalid names rather than producing an empty pass", (t) => {
  const root = temporary(t);
  for (const name of ["toString", "constructor", "__proto__", "UNKNOWN"]) {
    const result = invoke(path.join(example, "check.mjs"), [name], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Specify BEST or PENDING/);
    assert.equal(result.stdout, "");
  }
});

test("exercise checker distinguishes observed failures from corrupt evidence", (t) => {
  const root = temporary(t);
  const directory = path.join(root, "DEMO");
  fs.mkdirSync(directory);
  const states = {
    rejected: { decision: "REJECT", score: "77", gates: "Fail", "best-score": "68" },
    unverified: {
      decision: "UNVERIFIED",
      score: "—",
      coverage: "58%",
      gates: "Unknown",
      "best-score": "82",
    },
  };
  const retain = () => {
    const bytes = Buffer.from(JSON.stringify(states));
    fs.writeFileSync(path.join(directory, "states.json"), bytes);
    fs.writeFileSync(
      path.join(directory, "evidence.json"),
      JSON.stringify({
        files: [
          {
            label: "states",
            path: "states.json",
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
  };
  const check = () =>
    invoke(path.join(example, "check.mjs"), ["BEST"], root, {
      ...process.env,
      AEK_RUN_DIR: root,
    });
  retain();
  const good = check();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).verdict, "pass");
  states.rejected["best-score"] = "77";
  retain();
  const bad = check();
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).verdict, "fail");
  assert.match(JSON.parse(bad.stdout).reasoning, /rejected.best-score/);
  fs.appendFileSync(path.join(directory, "states.json"), " ");
  const corrupt = check();
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /integrity verification/);
  assert.equal(corrupt.stdout, "");
});

function checkout(t: TestContext) {
  const root = temporary(t);
  const methods = path.join(root, "examples/improvement-exercise");
  fs.cpSync(example, methods, { recursive: true });
  fs.symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  return { root, methods };
}

test("exercise preparation leaves no partial project when mutation anchors are stale", (t) => {
  const { root, methods } = checkout(t);
  const source = path.join(root, "docs/marketing");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "index.html"), "<html>The page changed.</html>");
  const output = path.join(root, "experiment");
  const failed = invoke(path.join(methods, "prepare.mjs"), [output], root);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Mutation anchor must occur once/);
  assert.equal(fs.existsSync(output), false);
  fs.copyFileSync(
    path.join(repository, "docs/marketing/index.html"),
    path.join(source, "index.html"),
  );
  const prepared = invoke(path.join(methods, "prepare.mjs"), [output], root);
  assert.equal(prepared.status, 0, prepared.stderr);
  const target = path.join(output, "project/site/index.html");
  const before = fs.readFileSync(target);
  const repeated = invoke(path.join(methods, "prepare.mjs"), [output], root);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /Refusing to overwrite/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test("exercise runner journals early CLI errors without inventing a run or score", (t) => {
  const { root, methods } = checkout(t);
  fs.mkdirSync(path.join(root, "src"));
  // Exercise the wrapper's failure path without a provider call or browser.
  fs.writeFileSync(
    path.join(root, "src/cli.ts"),
    'console.error("Invalid evaluation configuration"); process.exit(1);',
  );
  const experiment = path.join(root, "experiment");
  fs.mkdirSync(path.join(experiment, "project/site"), { recursive: true });
  fs.writeFileSync(path.join(experiment, "project/site/index.html"), "target");
  for (const previousRun of [false, true]) {
    if (previousRun) fs.mkdirSync(path.join(experiment, "runs/previous"), { recursive: true });
    const result = invoke(path.join(methods, "run.mjs"), [experiment, "current"], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid evaluation configuration/);
    assert.doesNotMatch(result.stderr, /ENOENT|Expected one new run/);
    const entries = fs
      .readFileSync(path.join(experiment, "journal.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const entry = entries.at(-1);
    assert.equal(entry.run, null);
    assert.equal(entry.exitCode, 1);
    assert.equal(Object.hasOwn(entry, "score"), false);
    assert.match(entry.error, /before creating a run/);
  }
});

test("improvement decisions preserve journal provenance, comparisons, errors, and revision reasons", (t) => {
  const root = temporary(t);
  const journal = [
    {
      variant: "combined",
      targetSha256: "old",
      run: "/runs/old",
      evaluator: "method",
      score: 0,
      coverage: 100,
      exitCode: 2,
      scoreWithheld: false,
      gatesPassed: false,
    },
    {
      variant: "current",
      targetSha256: "new",
      run: "/runs/new",
      evaluator: "method",
      score: 100,
      coverage: 100,
      exitCode: 0,
      scoreWithheld: false,
      gatesPassed: true,
    },
    {
      variant: "current",
      targetSha256: "broken",
      run: null,
      exitCode: 1,
      error: "Collection crashed",
    },
  ];
  const original = journal.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "journal.ndjson"), original);
  const comparison = {
    baseline: {
      runId: "old",
      evaluationFingerprint: "method",
      scorePct: 0,
      coveragePct: 100,
      scoreWithheld: false,
    },
    candidate: {
      runId: "new",
      evaluationFingerprint: "method",
      scorePct: 100,
      coveragePct: 100,
      scoreWithheld: false,
    },
    compatibility: { status: "compatible", overridden: false },
  };
  fs.writeFileSync(path.join(root, "comparison.json"), JSON.stringify(comparison));
  const input = {
    id: "repair",
    hypothesis: "Evidence-first guidance repairs acceptance.",
    change: "Replace the isolated next action.",
    attempts: [1, 2],
    comparisons: ["comparison.json"],
    outcome: "unresolved",
    reason: "Review pending.",
  };
  const pending = recordDecision(root, input);
  const accepted = recordDecision(root, {
    ...input,
    outcome: "accepted",
    reason: "Both runs verified; coverage and gates support acceptance.",
  });
  assert.equal(
    accepted.previousSha256,
    createHash("sha256").update(JSON.stringify(pending)).digest("hex"),
  );
  assert.deepEqual(accepted.attempts[1].entry, journal[1]);
  assert.equal(accepted.comparisons[0].report.compatibility.status, "compatible");
  const error = recordDecision(root, {
    ...input,
    attempts: [3],
    comparisons: [],
    outcome: "unresolved",
    reason: "Repair collector before product judgment.",
  });
  assert.equal(Object.hasOwn(error.attempts[0].entry, "score"), false);
  assert.equal(error.attempts[0].entry.error, "Collection crashed");
  assert.throws(
    () => recordDecision(root, { ...input, attempts: [3], comparisons: [], outcome: "accepted" }),
    /Acceptance requires/,
  );
  assert.throws(
    () => recordDecision(root, { ...input, attempts: [1] }),
    /must reference a linked journal run/,
  );
  assert.throws(() => recordDecision(root, { ...input, attempts: [8] }), /Unknown journal attempt/);
  assert.throws(() => recordDecision(root, { ...input, reason: "" }), /reason/);
  assert.equal(fs.readFileSync(path.join(root, "journal.ndjson"), "utf8"), original);
  assert.equal(
    fs.readFileSync(path.join(root, "decisions.ndjson"), "utf8").trim().split("\n").length,
    3,
  );
  const rejected = recordDecision(root, {
    ...input,
    outcome: "rejected",
    reason: "The observed guidance still permits acceptance without evidence.",
  });
  assert.equal(rejected.outcome, "rejected");
  const acceptedWithHistory = recordDecision(root, {
    ...input,
    attempts: [1, 2, 3],
    outcome: "accepted",
    reason: "The fresh candidate passed; the earlier collector error remains history.",
  });
  assert.equal(acceptedWithHistory.attempts[2].entry.error, "Collection crashed");
  assert.equal(Object.hasOwn(acceptedWithHistory.attempts[2].entry, "score"), false);
  // A compatible comparison alone cannot justify accepting failed gates or
  // withheld/incomplete evidence, even if the journal was edited to say exit 0.
  for (const change of [{ gatesPassed: false }, { coverage: 58, scoreWithheld: true }]) {
    const changed = structuredClone(journal);
    Object.assign(changed[1]!, change);
    fs.writeFileSync(
      path.join(root, "journal.ndjson"),
      changed.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const changedComparison = structuredClone(comparison);
    changedComparison.candidate.coveragePct = changed[1]!.coverage!;
    changedComparison.candidate.scoreWithheld = changed[1]!.scoreWithheld!;
    fs.writeFileSync(path.join(root, "comparison.json"), JSON.stringify(changedComparison));
    assert.throws(
      () => recordDecision(root, { ...input, outcome: "accepted" }),
      /full coverage, a visible score, and passed gates/,
    );
  }
  fs.writeFileSync(path.join(root, "journal.ndjson"), original);
  const mismatched = structuredClone(comparison);
  mismatched.candidate.evaluationFingerprint = "different-method";
  fs.writeFileSync(path.join(root, "comparison.json"), JSON.stringify(mismatched));
  assert.throws(
    () => recordDecision(root, input),
    /does not match journal execution and provenance/,
  );
});

test("exercise runner retains malformed reports as execution errors without a score", (t) => {
  const { root, methods } = checkout(t);
  fs.mkdirSync(path.join(root, "src"));
  const experiment = path.join(root, "experiment");
  fs.mkdirSync(path.join(experiment, "project/site"), { recursive: true });
  fs.writeFileSync(path.join(experiment, "project/site/index.html"), "target");
  fs.writeFileSync(
    path.join(root, "src/cli.ts"),
    `import fs from 'node:fs';
const run = ${JSON.stringify(path.join(experiment, "runs/invalid"))};
fs.mkdirSync(run, {recursive:true}); fs.writeFileSync(run+'/report.json', '{}');`,
  );
  const result = invoke(path.join(methods, "run.mjs"), [experiment, "current"], root);
  assert.equal(result.status, 1, result.stderr);
  const entry = JSON.parse(fs.readFileSync(path.join(experiment, "journal.ndjson"), "utf8"));
  assert.equal(entry.exitCode, 1);
  assert.match(entry.error, /Invalid report/);
  assert.equal(Object.hasOwn(entry, "score"), false);
  assert.equal(entry.run, path.join(experiment, "runs/invalid"));
});

test("exercise runner retains unknown CLI exits as errors even when a report exists", (t) => {
  const { root, methods } = checkout(t);
  fs.mkdirSync(path.join(root, "src"));
  const experiment = path.join(root, "experiment");
  fs.mkdirSync(path.join(experiment, "project/site"), { recursive: true });
  fs.writeFileSync(path.join(experiment, "project/site/index.html"), "target");
  const report = {
    receipt: { evaluationFingerprint: "method" },
    gates: { passed: true },
    scoreWithheld: false,
    overallCoveragePct: 100,
    overallScorePct: 100,
    areas: [{ items: [{ id: "GUIDANCE", verdict: "pass" }] }],
  };
  fs.writeFileSync(
    path.join(root, "src/cli.ts"),
    `import fs from 'node:fs';
const run = ${JSON.stringify(path.join(experiment, "runs/invalid-exit"))};
fs.mkdirSync(run, {recursive:true}); fs.writeFileSync(run+'/report.json', ${JSON.stringify(JSON.stringify(report))}); process.exit(7);`,
  );
  const result = invoke(path.join(methods, "run.mjs"), [experiment, "current"], root);
  assert.equal(result.status, 1, result.stderr);
  const entry = JSON.parse(fs.readFileSync(path.join(experiment, "journal.ndjson"), "utf8"));
  assert.equal(entry.cliExitCode, 7);
  assert.equal(entry.exitCode, 1);
  assert.equal(entry.evaluator, "method");
  assert.match(entry.error, /Unexpected evaluation CLI exit code: 7/);
  assert.equal(Object.hasOwn(entry, "score"), false);
});
