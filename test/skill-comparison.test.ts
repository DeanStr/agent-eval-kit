import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

const repository = path.resolve(import.meta.dirname, "..");
const example = path.join(repository, "examples/skill-comparison");
const { runComparison } = await import(path.join(example, "run.mjs"));
const { runCandidate, validateControls } = await import(path.join(example, "docker-runner.mjs"));
const correct = `export function total(lines, discount=0) {
  return Math.round(lines.reduce((sum,line)=>sum+line.priceCents*line.quantity,0)*(100-discount)/100);
}\n`;
const wrong = `export function total(lines, discount=0) {
  return lines.reduce((sum,line)=>sum+Math.round(line.priceCents*(100-discount)/100)*line.quantity,0);
}\n`;
const roundedPerLine = `export function total(lines, discount=0) {
  return lines.reduce((sum,line)=>sum+Math.round(line.priceCents*line.quantity*(100-discount)/100),0);
}\n`;

function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-skill-comparison-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Simulated Docker transport for ordinary CI. It executes the actual submitted
// module and observation inputs, never returns canned grader verdicts.
function dockerTransport(t: TestContext, root: string) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const log = path.join(root, "docker.ndjson");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0]==='rm') {
  if(process.env.AEK_TEST_CLEANUP_FAIL) { console.error('Fixture daemon refused cleanup'); process.exit(1); }
  process.exit(0);
}
if(args[0]==='network') { console.log('true'); process.exit(0); }
if(args.includes('--model')) {
  fs.readFileSync(0,'utf8');
  if(process.env.AEK_TEST_CANDIDATE_READY) {
    fs.writeFileSync(process.env.AEK_TEST_CANDIDATE_READY, 'ready');
    setTimeout(()=>{},10000);
  }
  else if(process.env.AEK_TEST_CANDIDATE_TIMEOUT) {
    process.on('SIGTERM',()=>{});
    process.stdout.write('{malformed partial event');
    setTimeout(()=>{},10000);
  }
  else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:20}}));
} else {
  if(!args.includes('--network=none')) throw Error('Probe networking must be disabled');
  const mounts = args.filter((_,index)=>args[index-1]==='--mount');
  if(mounts.length!==1 || !mounts[0].endsWith('target=/target/cart.mjs,readonly')) throw Error('Unexpected grading mount');
  const source=mounts[0].split(',').find(value=>value.startsWith('source=')).slice(7);
  const script=args[args.indexOf('-e')+1].replace("'/target/cart.mjs'",JSON.stringify(pathToFileURL(source).href));
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:fs.readFileSync(0),encoding:'utf8'});
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  return log;
}

function controls(root: string) {
  const authFile = path.join(root, "auth.json");
  fs.writeFileSync(authFile, "{}");
  return {
    image: process.env.AEK_TEST_DOCKER_IMAGE ?? `node@sha256:${"a".repeat(64)}`,
    model: "fixed-fixture-model",
    effort: "high",
    repetitions: 2,
    timeoutSeconds: 5,
    authFile,
    network: "aek-test-internal",
    proxyUrl: "http://model-proxy:8080",
  };
}

test("candidate adapter isolates mounts, pins controls, captures usage, and cleans up deadlines", async (t) => {
  const root = temporary(t);
  const log = dockerTransport(t, root);
  const fixed = controls(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  assert.throws(() => validateControls({ ...fixed, image: "runner:latest" }), /sha256 digest/);
  assert.throws(() => validateControls({ ...fixed, repetitions: 1 }), /two fresh candidate/);
  const result = await runCandidate({
    workspace,
    directory: root,
    controls: fixed,
    instructions: "Fixture instructions",
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 20 });
  assert.equal(result.observedCostUsd, null);
  const args = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((args) => args[0] === "run");
  assert.equal(args.filter((value: string) => value === "--mount").length, 2);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes(fixed.image));
  assert.ok(args.includes(fixed.model));
  assert.ok(
    !args.some((value: string) => value.includes("/evaluation") || value.includes("/evals")),
  );
  process.env.AEK_TEST_CANDIDATE_TIMEOUT = "1";
  t.after(() => {
    delete process.env.AEK_TEST_CANDIDATE_TIMEOUT;
  });
  const timeout = await runCandidate({
    workspace,
    directory: root,
    controls: { ...fixed, timeoutSeconds: 1 },
    instructions: "Fixture instructions",
  });
  assert.match(timeout.error, /ETIMEDOUT/);
  assert.match(timeout.error, /Invalid candidate event stream/);
  assert.ok(timeout.durationMs < 5000, "Deadline must kill a client that ignores SIGTERM");
  const calls = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.at(-1)[0], "rm");
});

test("controlled comparison repeats fresh candidates, independently grades artifacts, and retains every error", async (t) => {
  const root = temporary(t);
  // Set AEK_TEST_DOCKER_IMAGE to an installed pinned Node image to exercise real
  // artifact containers. Candidate outputs remain deterministic test fixtures.
  if (!process.env.AEK_TEST_DOCKER_IMAGE) dockerTransport(t, root);
  const output = path.join(root, "experiment");
  const fixed = controls(root);
  const starts: string[][] = [];
  const candidate = ({ workspace, directory }: { workspace: string; directory: string }) => {
    starts.push(fs.readdirSync(workspace).sort());
    assert.equal(
      fs.readFileSync(path.join(workspace, "cart.mjs"), "utf8"),
      fs.readFileSync(path.join(example, "fixture/cart.mjs"), "utf8"),
    );
    const id = path.basename(directory);
    fs.writeFileSync(path.join(workspace, "cart.mjs"), id === "1-plain" ? wrong : correct);
    if (id === "2-reviewed")
      return { exitCode: 1, error: "External runner unavailable", durationMs: 1, usage: null };
    return { exitCode: 0, durationMs: 1, usage: { input_tokens: 10, output_tokens: 20 } };
  };
  const summary = await runComparison(output, fixed, {
    candidate,
    cli: ["--import", import.meta.resolve("tsx"), path.join(repository, "src/cli.ts")],
  });
  assert.equal(starts.length, 4);
  for (const files of starts) assert.deepEqual(files, ["TASK.md", "cart.mjs", "cart.test.mjs"]);
  assert.equal(summary.attempts.length, 4);
  assert.equal(summary.variants.plain.evaluated, 2);
  assert.equal(summary.variants.reviewed.errors, 1);
  const first = summary.attempts[0];
  assert.equal(first.id, "1-plain");
  assert.equal(first.result.score, 0);
  assert.equal(first.result.coverage, 100);
  assert.equal(first.result.gatesPassed, false);
  assert.equal(summary.attempts[1].result.score, 100);
  assert.equal(summary.attempts[2].id, "2-reviewed");
  assert.equal(Object.hasOwn(summary.attempts[2], "result"), false);
  assert.equal(summary.attempts[3].id, "2-plain");
  assert.equal(summary.attempts[3].result.score, 100);
  assert.equal(summary.comparisons[0].report.compatibility.status, "compatible");
  assert.equal(summary.comparisons[0].report.overall.scorePct.delta, 100);
  assert.match(summary.comparisons[1].error, /execution failed/);
  assert.equal(
    new Set(
      summary.attempts
        .filter((entry: { result?: object }) => entry.result)
        .map((entry: { result: { evaluator: string } }) => entry.result.evaluator),
    ).size,
    1,
  );
  assert.equal(
    fs.readFileSync(path.join(output, "journal.ndjson"), "utf8").trim().split("\n").length,
    4,
  );
  for (const id of ["1-plain", "1-reviewed", "2-plain", "2-reviewed"])
    assert.ok(fs.existsSync(path.join(output, "attempts", id, "workspace/cart.mjs")));
  const before = fs.readFileSync(path.join(output, "journal.ndjson"));
  await assert.rejects(runComparison(output, fixed), /Refusing to overwrite/);
  assert.deepEqual(fs.readFileSync(path.join(output, "journal.ndjson")), before);
});

test("subtotal calibration rejects per-line rounding with full evidence", async (t) => {
  const root = temporary(t);
  if (!process.env.AEK_TEST_DOCKER_IMAGE) dockerTransport(t, root);
  const summary = await runComparison(path.join(root, "experiment"), controls(root), {
    cli: ["--import", import.meta.resolve("tsx"), path.join(repository, "src/cli.ts")],
    candidate: ({ workspace, directory }: { workspace: string; directory: string }) => {
      const defective = path.basename(directory).endsWith("-plain");
      fs.writeFileSync(path.join(workspace, "cart.mjs"), defective ? roundedPerLine : correct);
      return { exitCode: 0, durationMs: 1 };
    },
  });
  assert.equal(summary.attempts.length, 4);
  const methods = new Set();
  for (const attempt of summary.attempts) {
    const defective = attempt.variant === "plain";
    assert.equal(attempt.status, "evaluated", attempt.error);
    assert.equal(attempt.result.verdicts.TOTALS, defective ? "fail" : "pass");
    assert.equal(attempt.result.score, defective ? 0 : 100);
    assert.equal(attempt.result.coverage, 100);
    assert.equal(attempt.result.gatesPassed, !defective);
    methods.add(attempt.result.evaluator);
    const scenario = path.join(attempt.run, "OBSERVE");
    const evidence = JSON.parse(fs.readFileSync(path.join(scenario, "evidence.json"), "utf8"));
    const file = evidence.files.find((file: { label: string }) => file.label === "values");
    const observations = JSON.parse(fs.readFileSync(path.join(scenario, file.path), "utf8"));
    const values = Object.fromEntries(
      observations.map(({ id, actual }: { id: string; actual: number }) => [id, actual]),
    );
    assert.equal(values["round-once"], 5, "The per-line defect passes the single-line case");
    assert.equal(values["round-across-lines"], defective ? 6 : 5);
  }
  assert.equal(methods.size, 1, "Good and defective targets must use the same evaluator");
});

test("independent artifact execution errors remain errors and never product scores", async (t) => {
  const root = temporary(t);
  dockerTransport(t, root);
  const summary = await runComparison(path.join(root, "experiment"), controls(root), {
    cli: ["--import", import.meta.resolve("tsx"), path.join(repository, "src/cli.ts")],
    candidate: ({ workspace }: { workspace: string }) => {
      fs.writeFileSync(
        path.join(workspace, "cart.mjs"),
        "throw new Error('broken artifact import');\n",
      );
      return { exitCode: 0, durationMs: 1 };
    },
  });
  assert.equal(summary.attempts.length, 4);
  for (const entry of summary.attempts) {
    assert.equal(entry.status, "error");
    assert.match(entry.error, /AEK execution error/);
    assert.equal(Object.hasOwn(entry, "result"), false);
    assert.ok(entry.run);
    assert.equal(fs.existsSync(path.join(entry.run, "report.json")), false);
  }
});

test("ordinary fixture tests remain runnable without AEK or a candidate runner", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", path.join(example, "fixture/cart.test.mjs")],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tests 2/);
});

test("failed candidate cleanup retains the attempt and stops further model calls", async (t) => {
  const root = temporary(t);
  const log = dockerTransport(t, root);
  process.env.AEK_TEST_CLEANUP_FAIL = "1";
  t.after(() => {
    delete process.env.AEK_TEST_CLEANUP_FAIL;
  });
  const output = path.join(root, "experiment");
  const summary = await runComparison(output, controls(root));
  assert.equal(summary.attempts.length, 1);
  assert.equal(summary.plannedAttempts, 4);
  assert.equal(summary.unattempted, 3);
  assert.match(summary.stoppedReason, /cleanup failed/);
  assert.equal(summary.attempts[0].status, "error");
  assert.match(summary.attempts[0].candidate.cleanupError, /Failed to remove container/);
  assert.equal(Object.hasOwn(summary.attempts[0], "result"), false);
  const commands = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(commands.filter((args) => args[0] === "run").length, 1);
  assert.match(
    fs.readFileSync(path.join(output, "attempts/1-plain/candidate-cleanup.stderr"), "utf8"),
    /refused cleanup/,
  );
});

test("experiment interruption cleans up the active candidate and journals cancellation", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    await t.test(signal, async (subtest) => {
      const root = temporary(subtest);
      const log = dockerTransport(subtest, root);
      const ready = path.join(root, "candidate-ready");
      const output = path.join(root, "experiment");
      const controlFile = path.join(root, "controls.json");
      fs.writeFileSync(controlFile, JSON.stringify(controls(root)));
      const child = spawn(process.execPath, [path.join(example, "run.mjs"), output, controlFile], {
        env: { ...process.env, AEK_TEST_CANDIDATE_READY: ready },
        stdio: ["ignore", "pipe", "pipe"],
      });
      subtest.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline)
        await delay(25);
      assert.ok(fs.existsSync(ready), `Candidate did not start: ${stderr}`);
      child.kill(signal);
      const result = await completion;
      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 1, stderr);
      const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
      assert.equal(summary.attempts.length, 1);
      assert.equal(summary.unattempted, 3);
      assert.match(summary.stoppedReason, new RegExp(signal));
      const entry = summary.attempts[0];
      assert.equal(entry.interruptedSignal, signal);
      assert.equal(entry.status, "error");
      assert.equal(Object.hasOwn(entry, "result"), false);
      assert.equal(entry.candidate.cleanup.exitCode, 0);
      const journal = JSON.parse(fs.readFileSync(path.join(output, "journal.ndjson"), "utf8"));
      assert.equal(journal.interruptedSignal, signal);
      const calls = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(calls.filter((args) => args[0] === "run").length, 1);
      assert.equal(calls.at(-1)[0], "rm");
    });
  }
});

test("collector cleanup failure stays an execution error despite successful observations", (t) => {
  const root = temporary(t);
  dockerTransport(t, root);
  const methods = path.join(root, "evals");
  const output = path.join(root, "observations");
  fs.mkdirSync(methods);
  fs.mkdirSync(output);
  for (const file of ["collect.mjs", "docker-runner.mjs"])
    fs.copyFileSync(path.join(example, file), path.join(methods, file));
  fs.writeFileSync(
    path.join(methods, "runtime.json"),
    JSON.stringify({ image: controls(root).image }),
  );
  const artifact = path.join(root, "cart.mjs");
  fs.writeFileSync(artifact, correct);
  const context = path.join(root, "context.json");
  fs.writeFileSync(
    context,
    JSON.stringify({ outputDir: output, sources: { cart: { path: artifact } } }),
  );
  const result = spawnSync(process.execPath, [path.join(methods, "collect.mjs")], {
    encoding: "utf8",
    env: { ...process.env, AEK_COLLECT_CONTEXT: context, AEK_TEST_CLEANUP_FAIL: "1" },
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Failed to remove container/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(output, "probe.stdout"), "utf8")).length > 0);
  assert.equal(fs.existsSync(path.join(output, "values.json")), false);
});

test("malformed comparison output is retained as an error alongside every completed attempt", async (t) => {
  const root = temporary(t);
  dockerTransport(t, root);
  const wrapper = path.join(root, "cli.mjs");
  fs.writeFileSync(
    wrapper,
    `import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const args = process.argv.slice(2);
if(args[0]==='compare') {
  const output = args[args.indexOf('--output')+1];
  fs.writeFileSync(output+'/comparison.json','{invalid comparison'); process.exit(0);
}
const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(import.meta.resolve("tsx"))}, ${JSON.stringify(path.join(repository, "src/cli.ts"))}, ...args], {stdio:'inherit'});
process.exit(child.status ?? 1);`,
  );
  const output = path.join(root, "experiment");
  const summary = await runComparison(output, controls(root), {
    cli: [wrapper],
    candidate: ({ workspace }: { workspace: string }) => {
      fs.writeFileSync(path.join(workspace, "cart.mjs"), correct);
      return { exitCode: 0, durationMs: 1 };
    },
  });
  assert.equal(summary.attempts.length, 4);
  assert.equal(summary.unattempted, 0);
  for (const attempt of summary.attempts) assert.equal(attempt.status, "evaluated");
  assert.equal(summary.comparisons.length, 2);
  for (const comparison of summary.comparisons)
    assert.match(comparison.error, /JSON|property name/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8")).attempts.length,
    4,
  );
});
