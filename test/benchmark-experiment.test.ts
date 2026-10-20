import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  benchmarkExperimentSchema,
  counterbalancedBlocks,
  runBenchmarkExperiment,
} from "../src/benchmark-experiment.js";
import { withRunLock } from "../src/run/state.js";
import { terminateProcessGroup } from "../src/process-tree.js";

function pairedRows(root: string): string[][] {
  const document = parse(fs.readFileSync(path.join(root, "output/experiment.html"), "utf8"));
  const rows: string[][] = [];
  const text = (node: DefaultTreeAdapterMap["node"]): string =>
    "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node && node.tagName === "tr") {
      rows.push(
        node.childNodes
          .filter((child) => "tagName" in child && ["td", "th"].includes(child.tagName))
          .map(text),
      );
    } else if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  return rows.filter((row) => row[0] !== "Block");
}

function stopFixtureProcess(marker: string): void {
  if (!fs.existsSync(marker)) return;
  const pid = Number(fs.readFileSync(marker, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `Invalid fixture PID in ${marker}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await delay(20);
  assert.ok(fs.existsSync(file), `Missing process marker: ${file}`);
}

function addStubbornTarget(candidates: Record<string, string>): void {
  for (const file of Object.values(candidates)) {
    fs.writeFileSync(
      path.join(path.dirname(file), "wait.mjs"),
      `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync('../target-started',String(process.pid));setInterval(()=>{},1000);`,
    );
    const config = YAML.parse(fs.readFileSync(file, "utf8"));
    config.target.start = { command: "node wait.mjs" };
    config.target.ready = { command: "test -f ../target-started", intervalMs: 20 };
    fs.writeFileSync(file, YAML.stringify(config));
  }
}

function fixture(t: test.TestContext, variants = ["baseline", "candidate"], mode = "pass") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-experiment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidates: Record<string, string> = {};
  for (const id of variants) {
    const project = path.join(root, id);
    fs.mkdirSync(project);
    candidates[id] = path.join(project, "evalkit.yaml");
    fs.writeFileSync(
      candidates[id]!,
      YAML.stringify({
        version: 1,
        project: { name: "Experiment" },
        target: { kind: "command" },
        agent: { provider: "mock" },
        judge: { provider: "mock" },
        paths: { specs: "spec.yaml" },
        scoring: { minimumCoverage: 100 },
      }),
    );
    fs.writeFileSync(path.join(project, "subject.json"), JSON.stringify({ id, mode }));
    fs.writeFileSync(
      path.join(project, "collect.mjs"),
      `import fs from 'node:fs';import path from 'node:path';
const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8')), s=JSON.parse(fs.readFileSync(c.sources.subject.path,'utf8'));
if(s.mode==='crash'&&s.id==='candidate')throw Error('Collector crashed');
if(['hang','stubborn'].includes(s.mode)){if(s.mode==='stubborn')process.on('SIGTERM',()=>fs.writeFileSync(path.resolve('..','terminating'),''));fs.writeFileSync(path.resolve('..','started'),String(process.pid));await new Promise(()=>{setInterval(()=>{},1000)});}
if(s.mode==='mutate')fs.appendFileSync('subject.json',' ');
if(s.mode==='managed'){fs.mkdirSync('.agent-eval/old-run',{recursive:true});fs.appendFileSync('.agent-eval/old-run/log','another run');}
let value=s.id==='baseline'?10:5;
if(s.mode==='paired'){const log=path.resolve('..','observations.json'),visits=fs.existsSync(log)?JSON.parse(fs.readFileSync(log,'utf8')):[],n=visits.filter(id=>id===s.id).length;value=s.id==='baseline'?[10,20][n]:[5,12][n];visits.push(s.id);fs.writeFileSync(log,JSON.stringify(visits));}
const m={version:1,candidate:{id:s.id,revision:s.id},workload:{id:'work',sha256:'a'.repeat(64)},method:{id:'timer',sha256:'b'.repeat(64)},environment:{hardware:'fixture'},work:{unit:'items',requested:1,completed:1},outcome:{state:'completed'},metrics:[{id:'time',unit:s.mode==='units'&&s.id==='candidate'?'s':'ms',preferredDirection:'lower',scope:'application',observation:{state:'observed',samples:[value]}}],correctness:[{scenarioId:'WORKLOAD',fileLabel:'raw'}]};
if(s.mode==='env'&&process.env.AEK_EXPERIMENT_TEST_VALUE!==s.id)throw Error('Candidate environment leaked');
fs.writeFileSync(path.join(c.outputDir,'measurements.json'),JSON.stringify(m));fs.writeFileSync(path.join(c.outputDir,'raw.json'),JSON.stringify({valid:!(s.mode==='wrong'&&s.id==='candidate')}));
console.log(JSON.stringify({version:1,outcome:'completed',summary:'Observed',observations:['Real subprocess fixture'],files:['measurements','raw'].map(label=>({label,path:label+'.json',filename:label+'.json',mediaType:'application/json'}))}));`,
    );
    fs.writeFileSync(
      path.join(project, "check.mjs"),
      `import fs from 'node:fs';import path from 'node:path';const d=path.join(process.env.AEK_RUN_DIR,'WORKLOAD'), e=JSON.parse(fs.readFileSync(path.join(d,'evidence.json'),'utf8')), f=e.files.find(f=>f.label==='raw'), r=JSON.parse(fs.readFileSync(path.join(d,f.path),'utf8'));console.log(JSON.stringify({verdict:r.valid?'pass':'fail',confidence:'high',reasoning:'Independent check',evidenceRefs:['WORKLOAD/'+f.path]}));`,
    );
    fs.writeFileSync(
      path.join(project, "spec.yaml"),
      YAML.stringify({
        id: "work",
        title: "Work",
        description: "Actual command collector",
        weight: 100,
        scenarios: [
          {
            id: "WORKLOAD",
            name: "Work",
            kind: "command",
            instructions: "Observe workload",
            collect: {
              command: "node collect.mjs",
              methodFiles: ["collect.mjs"],
              sources: { subject: "subject.json" },
              files: ["measurements", "raw"],
            },
          },
        ],
        rubric: [
          {
            id: "CORRECT",
            criterion: "Correct output",
            passCriteria: "Independent oracle passes",
            weight: 1,
            gate: true,
            scenarios: ["WORKLOAD"],
            grader: {
              type: "command",
              command: "node check.mjs",
              output: "json",
              methodFiles: ["check.mjs"],
            },
          },
        ],
      }),
    );
  }
  const recipe = {
    version: 1 as const,
    candidates,
    baseline: "baseline",
    blocks: counterbalancedBlocks(variants, 2),
    resource: path.join(root, "resource"),
    timeoutSeconds: 20,
    measurement: { scenarioId: "WORKLOAD", fileLabel: "measurements" },
  };
  return { root, recipe };
}

test("plans preserve explicit block order and reject missing or repeated candidates", () => {
  assert.deepEqual(counterbalancedBlocks(["a", "b", "c"], 2), [
    ["a", "b", "c"],
    ["c", "b", "a"],
  ]);
  assert.throws(() => counterbalancedBlocks(["a", "a"], 2));
  const recipe = {
    version: 1,
    candidates: { a: "a.yaml", b: "b.yaml" },
    baseline: "a",
    resource: "resource",
    timeoutSeconds: 10,
    measurement: { scenarioId: "W", fileLabel: "m" },
  };
  assert.throws(
    () =>
      benchmarkExperimentSchema.parse({
        ...recipe,
        blocks: [
          ["a", "b"],
          ["a", "a"],
        ],
      }),
    /every candidate exactly once/,
  );
});

test("multi-candidate acquisition is counterbalanced and pairs complete runs by block", async (t) => {
  const { root, recipe } = fixture(t, ["baseline", "middle", "candidate"], "paired");
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "compared");
  assert.deepEqual(
    result.visits.map((v) => v.candidate),
    ["baseline", "middle", "candidate", "candidate", "middle", "baseline"],
  );
  assert.deepEqual(result.unattempted, []);
  const pairs = JSON.parse(
    fs.readFileSync(
      path.join(root, "output/comparisons/candidate/paired-differences.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    pairs.pairs[0].blocks.map((b: { delta: number }) => b.delta),
    [-5, -8],
  );
  assert.deepEqual(pairedRows(root), [
    ["1", "time", "application", "ms (lower)", "10", "5", "-5"],
    ["2", "time", "application", "ms (lower)", "20", "12", "-8"],
    ["1", "time", "application", "ms (lower)", "10", "5", "-5"],
    ["2", "time", "application", "ms (lower)", "20", "12", "-8"],
  ]);
  const html = fs.readFileSync(path.join(root, "output/experiment.html"), "utf8");
  assert.match(html, /candidate vs baseline/);
  assert.match(html, /href="comparisons\/candidate\/paired-differences.json"/);
  assert.match(html, /no statistical confidence or automatic performance acceptance/);
  assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
  await assert.rejects(runBenchmarkExperiment(path.join(root, "output"), recipe), /EEXIST/);
});

test("a faster incorrect candidate remains a requirement failure", async (t) => {
  const { root, recipe } = fixture(t, undefined, "wrong");
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "requirement_failure");
  assert.equal(result.visits.length, 4);
});

test("execution failure retains the failed visit and leaves later visits unattempted", async (t) => {
  const { root, recipe } = fixture(t, undefined, "crash");
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "execution_error");
  assert.equal(result.visits.length, 2);
  assert.equal(result.visits[1]!.status, "error");
  assert.equal(result.unattempted.length, 2);
  assert.deepEqual(pairedRows(root), [
    ["1", "time", "application", "ms (lower)", "10", "unavailable", "unavailable"],
    ["2", "time", "application", "ms (lower)", "unavailable", "unavailable", "unavailable"],
  ]);
});

test("paired HTML retains raw values but withholds differences for incompatible methods", async (t) => {
  const { root, recipe } = fixture(t);
  const configFile = recipe.candidates.candidate!;
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.instructions = "Different evaluation method";
  fs.writeFileSync(configFile, YAML.stringify(config));
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(pairedRows(root), [
    ["1", "time", "application", "ms (lower)", "10", "5", "unavailable"],
    ["2", "time", "application", "ms (lower)", "10", "5", "unavailable"],
  ]);
  assert.match(
    fs.readFileSync(path.join(root, "output/experiment.html"), "utf8"),
    /Measurement validity: incompatible/,
  );
});

test("paired HTML never labels values from incompatible units with the baseline unit", async (t) => {
  const { root, recipe } = fixture(t, undefined, "units");
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "inconclusive");
  assert.deepEqual(pairedRows(root), [
    ["1", "time", "application", "ms (lower)", "10", "unavailable", "unavailable"],
    ["2", "time", "application", "ms (lower)", "10", "unavailable", "unavailable"],
  ]);
});

test("a shared resource excludes a second experiment with a different output directory", async (t) => {
  const { root, recipe } = fixture(t);
  fs.mkdirSync(recipe.resource);
  await withRunLock(recipe.resource, async () => {
    await assert.rejects(
      runBenchmarkExperiment(path.join(root, "other"), recipe),
      /locked by active process/,
    );
    assert.equal(fs.existsSync(path.join(root, "other")), false);
  });
});

test("symlink resource aliases still exclude acquisition", async (t) => {
  const { root, recipe } = fixture(t);
  fs.mkdirSync(recipe.resource);
  const alias = path.join(root, "resource-alias");
  fs.symlinkSync(recipe.resource, alias);
  await withRunLock(recipe.resource, async () => {
    await assert.rejects(
      runBenchmarkExperiment(path.join(root, "output"), { ...recipe, resource: alias }),
      /locked by active process/,
    );
  });
});

test("parent death refuses resource recovery while its detached worker and collector survive", {
  timeout: 30_000,
}, async (t) => {
  const { root, recipe } = fixture(t, undefined, "hang");
  const recipeFile = path.join(root, "recipe.json");
  const output = path.join(root, "output");
  fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  const child = spawn(process.execPath, ["examples/benchmark/experiment.mjs", output, recipeFile], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  let workerPid: number | undefined;
  try {
    await waitForFile(path.join(root, "started"));
    const ledger = JSON.parse(fs.readFileSync(path.join(output, "experiment.json"), "utf8"));
    workerPid = JSON.parse(
      fs.readFileSync(path.join(ledger.visits[0].runDir, "run-state.json"), "utf8"),
    ).pid as number;
    child.kill("SIGKILL");
    await exited;
    process.kill(workerPid, 0);
    const collectorPid = Number(fs.readFileSync(path.join(root, "started"), "utf8"));
    process.kill(collectorPid, 0);
    const lockFile = path.join(recipe.resource, ".run.lock");
    const lock = fs.readFileSync(lockFile, "utf8");
    await assert.rejects(
      runBenchmarkExperiment(path.join(root, "other"), recipe),
      /Detached workers or collectors may still be running.*before removing this lock/,
    );
    assert.equal(fs.readFileSync(lockFile, "utf8"), lock);
    assert.equal(fs.existsSync(path.join(root, "other")), false);
    process.kill(workerPid, 0);
    process.kill(collectorPid, 0);
  } finally {
    child.kill("SIGKILL");
    await exited;
    if (workerPid !== undefined) await terminateProcessGroup(workerPid);
    stopFixtureProcess(path.join(root, "started"));
  }
});

test("candidate dotenv values remain isolated from other candidates and the caller", async (t) => {
  const { root, recipe } = fixture(t, undefined, "env");
  assert.equal(process.env.AEK_EXPERIMENT_TEST_VALUE, undefined);
  for (const id of Object.keys(recipe.candidates)) {
    fs.writeFileSync(path.join(root, id, ".env"), `AEK_EXPERIMENT_TEST_VALUE=${id}\n`);
    const file = recipe.candidates[id]!;
    const config = YAML.parse(fs.readFileSync(file, "utf8"));
    config.target.setup = {
      command: `node -e "if(process.env.AEK_EXPERIMENT_TEST_VALUE!==JSON.parse(require('fs').readFileSync('subject.json')).id)process.exit(1)"`,
    };
    fs.writeFileSync(file, YAML.stringify(config));
  }
  const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
  assert.equal(result.outcome, "compared");
  assert.equal(process.env.AEK_EXPERIMENT_TEST_VALUE, undefined);
});

for (const phase of ["before", "during"] as const) {
  test(`external config dotenv changes ${phase} a visit stop the experiment`, async (t) => {
    const { root, recipe } = fixture(t);
    const observations = path.join(root, "observations.json");
    const baselineEnv = path.join(root, "configs/baseline/.env");
    assert.equal(process.env.AEK_EXPERIMENT_TEST_VALUE, undefined);
    for (const [id, file] of Object.entries(recipe.candidates)) {
      const configDirectory = path.join(root, "configs", id);
      fs.mkdirSync(configDirectory, { recursive: true });
      const config = YAML.parse(fs.readFileSync(file, "utf8"));
      config.project.root = path.dirname(file);
      recipe.candidates[id] = path.join(configDirectory, "evalkit.yaml");
      fs.writeFileSync(recipe.candidates[id]!, YAML.stringify(config));
      fs.unlinkSync(file);
      fs.writeFileSync(path.join(configDirectory, ".env"), "AEK_EXPERIMENT_TEST_VALUE=one\n");
      fs.appendFileSync(
        path.join(config.project.root, "collect.mjs"),
        `
const log=${JSON.stringify(observations)};
const visits=fs.existsSync(log)?JSON.parse(fs.readFileSync(log,'utf8')):[];
visits.push(process.env.AEK_EXPERIMENT_TEST_VALUE);
fs.writeFileSync(log,JSON.stringify(visits));
if(visits.length===${phase === "during" ? 1 : 2})fs.writeFileSync(${JSON.stringify(baselineEnv)},'AEK_EXPERIMENT_TEST_VALUE=two\\n');
`,
      );
    }
    const result = await runBenchmarkExperiment(path.join(root, "output"), recipe);
    assert.equal(result.outcome, "execution_error");
    assert.match(result.error!, new RegExp(`inputs changed ${phase} visit: baseline`));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(observations, "utf8")),
      phase === "during" ? ["one"] : ["one", "one", "one"],
    );
    assert.equal(result.visits.at(-1)!.status, "error");
    if (phase === "before") assert.equal(result.visits.at(-1)!.runDir, undefined);
    assert.equal(process.env.AEK_EXPERIMENT_TEST_VALUE, undefined);
  });
}

for (const runs of [".agent-eval/runs", "custom-runs"]) {
  test(`fresh nested output works with ${runs} and existing output stays reserved`, async (t) => {
    const { root, recipe } = fixture(t);
    for (const file of Object.values(recipe.candidates)) {
      const config = YAML.parse(fs.readFileSync(file, "utf8"));
      config.paths.runs = runs;
      fs.writeFileSync(file, YAML.stringify(config));
    }
    const output = path.join(root, "baseline/.agent-eval/experiments/trial-1");
    assert.equal(fs.existsSync(path.dirname(output)), false);
    const result = await runBenchmarkExperiment(output, recipe);
    assert.equal(result.outcome, "compared");
    const summary = fs.readFileSync(path.join(output, "summary.json"), "utf8");
    await assert.rejects(runBenchmarkExperiment(output, recipe), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(output, "summary.json"), "utf8"), summary);
  });
}

test("custom run paths still detect target changes beside the experiment output", async (t) => {
  const { root, recipe } = fixture(t);
  for (const file of Object.values(recipe.candidates)) {
    const config = YAML.parse(fs.readFileSync(file, "utf8"));
    config.paths.runs = "custom-runs";
    fs.writeFileSync(file, YAML.stringify(config));
    fs.appendFileSync(
      path.join(path.dirname(file), "collect.mjs"),
      "\nfs.writeFileSync('.agent-eval/experiments/target-input.json','changed');",
    );
  }
  const result = await runBenchmarkExperiment(
    path.join(root, "baseline/.agent-eval/experiments/trial-1"),
    recipe,
  );
  assert.equal(result.outcome, "execution_error");
  assert.match(result.error!, /inputs changed during visit: baseline/);
  assert.equal(result.unattempted.length, 3);
});

for (const [mode, outcome, exit] of [
  ["pass", "compared", 0],
  ["wrong", "requirement_failure", 2],
  ["units", "inconclusive", 2],
  ["crash", "execution_error", 1],
] as const) {
  test(`benchmark CLI reports ${outcome}, ordered progress and exit ${exit}`, (t) => {
    const { root, recipe } = fixture(t, undefined, mode);
    const recipes = path.join(root, "recipes"),
      cwd = path.join(root, "launch");
    fs.mkdirSync(recipes);
    fs.mkdirSync(cwd);
    // A recipe-driven command must not load evalkit.yaml from its working directory.
    fs.writeFileSync(path.join(cwd, "evalkit.yaml"), "invalid: config");
    const file = path.join(recipes, "experiment.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...recipe,
        candidates: Object.fromEntries(
          Object.entries(recipe.candidates).map(([id, config]) => [
            id,
            path.relative(recipes, config),
          ]),
        ),
        resource: "../resource",
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../dist/cli.js"),
        "benchmark",
        "experiment",
        "--recipe",
        "../recipes/experiment.json",
        "--output",
        "results/experiment",
      ],
      { cwd, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    const output = path.join(cwd, "results/experiment");
    const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
    assert.equal(summary.outcome, outcome);
    assert.match(result.stdout, new RegExp(`Experiment outcome: ${outcome}`));
    assert.ok(result.stdout.includes(`Report: ${path.join(output, "experiment.html")}`));
    assert.ok(result.stdout.includes(`Summary: ${path.join(output, "summary.json")}`));
    assert.ok(fs.existsSync(path.join(output, "experiment.html")));
    assert.deepEqual(
      result.stderr.split("\n").filter((line) => line.endsWith("· running")),
      summary.visits.map(
        (visit: { block: number; candidate: string }) =>
          `Block ${visit.block}/2 · candidate ${visit.candidate} · running`,
      ),
    );
    assert.match(result.stderr, /Preparing candidate baseline/);
    assert.match(result.stderr, /Block 1\/2 · candidate baseline · complete/);
    assert.equal(fs.existsSync(path.join(root, "resource/.run.lock")), false);
    assert.equal(summary.unattempted.length, mode === "crash" ? 2 : 0);
  });
}

test("preflight failure leaves the requested output available for a corrected retry", async (t) => {
  const { root, recipe } = fixture(t);
  const file = recipe.candidates.candidate!,
    body = fs.readFileSync(file);
  fs.writeFileSync(file, "invalid: config");
  const output = path.join(root, "new-parent/output");
  await assert.rejects(runBenchmarkExperiment(output, recipe));
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
  fs.writeFileSync(file, body);
  assert.equal((await runBenchmarkExperiment(output, recipe)).outcome, "compared");
});

test("ordinary managed artifacts stay excluded while target mutations fail closed", async (t) => {
  const managed = fixture(t, undefined, "managed");
  for (const id of Object.keys(managed.recipe.candidates)) {
    fs.mkdirSync(path.join(managed.root, id, ".agent-eval"), { recursive: true });
    fs.writeFileSync(path.join(managed.root, id, ".agent-eval", "prior.json"), "{}");
  }
  assert.equal(
    (await runBenchmarkExperiment(path.join(managed.root, "output"), managed.recipe)).outcome,
    "compared",
  );
  const changed = fixture(t, undefined, "mutate");
  const result = await runBenchmarkExperiment(path.join(changed.root, "output"), changed.recipe);
  assert.equal(result.outcome, "execution_error");
  assert.ok(result.error);
  assert.ok(
    fs.readFileSync(path.join(changed.root, "baseline/subject.json"), "utf8").endsWith(" "),
  );
  assert.equal(result.unattempted.length, 3);
});

test("cancellation drains the collector and releases the resource before returning", async (t) => {
  const { root, recipe } = fixture(t, undefined, "hang");
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, "started")))
      controller.abort(new Error("Stopped experiment"));
  }, 20);
  try {
    const result = await runBenchmarkExperiment(path.join(root, "output"), recipe, {
      signal: controller.signal,
    });
    assert.equal(result.outcome, "execution_error");
    assert.equal(result.visits.length, 1);
    assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
  } finally {
    clearInterval(timer);
  }
});

for (const reason of ["cancellation", "timeout"] as const) {
  test(`${reason} retains the resource until stubborn collector and target cleanup finish`, {
    timeout: 45_000,
  }, async (t) => {
    const { root, recipe } = fixture(t, undefined, "stubborn");
    if (reason === "timeout") recipe.timeoutSeconds = 10;
    addStubbornTarget(recipe.candidates);
    const controller = new AbortController();
    const output = path.join(root, "output");
    const running = runBenchmarkExperiment(output, recipe, { signal: controller.signal });
    // Observe rejection immediately while waiting for the subprocess markers.
    void running.catch(() => {});
    try {
      await waitForFile(path.join(root, "started"));
      if (reason === "cancellation") controller.abort(new Error("Stopped stubborn processes"));
      await waitForFile(path.join(root, "terminating"));
      await assert.rejects(
        runBenchmarkExperiment(path.join(root, "other"), recipe),
        /locked by active process/,
      );
      const result = await running;
      assert.equal(result.outcome, "execution_error");
      assert.equal(result.visits.length, 1);
      assert.equal(result.unattempted.length, 3);
      for (const marker of ["started", "target-started"]) {
        const pid = Number(fs.readFileSync(path.join(root, marker), "utf8"));
        assert.throws(() => process.kill(pid, 0), /ESRCH/, `${marker} is still alive`);
      }
      const runDir = result.visits[0]!.runDir!;
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(runDir, "run-state.json"), "utf8")).status,
        "failed",
        "the worker must finish failure handling before it exits",
      );
      assert.equal(fs.existsSync(path.join(runDir, ".run.lock")), false);
      assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
    } finally {
      controller.abort();
      await running.catch(() => {});
      for (const marker of ["started", "target-started"]) {
        stopFixtureProcess(path.join(root, marker));
      }
    }
  });
}

test("a stalled worker cannot leave detached processes alive after resource release", {
  timeout: 45_000,
}, async (t) => {
  const { root, recipe } = fixture(t, undefined, "stubborn");
  addStubbornTarget(recipe.candidates);
  const output = path.join(root, "output");
  const controller = new AbortController();
  const running = runBenchmarkExperiment(output, recipe, { signal: controller.signal });
  void running.catch(() => {});
  try {
    await waitForFile(path.join(root, "started"));
    const ledger = JSON.parse(fs.readFileSync(path.join(output, "experiment.json"), "utf8"));
    const state = JSON.parse(
      fs.readFileSync(path.join(ledger.visits[0].runDir, "run-state.json"), "utf8"),
    );
    fs.writeFileSync(path.join(root, "worker.pid"), String(state.pid));
    process.kill(state.pid, "SIGSTOP");
    controller.abort(new Error("Stopped stalled worker"));
    await assert.rejects(
      runBenchmarkExperiment(path.join(root, "other"), recipe),
      /locked by active process/,
    );
    const result = await running;
    assert.equal(result.outcome, "execution_error");
    assert.equal(result.unattempted.length, 3);
    for (const marker of ["started", "target-started"]) {
      const pid = Number(fs.readFileSync(path.join(root, marker), "utf8"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `${marker} survived its worker`);
    }
    assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
  } finally {
    controller.abort();
    stopFixtureProcess(path.join(root, "worker.pid"));
    await running.catch(() => {});
    stopFixtureProcess(path.join(root, "started"));
    stopFixtureProcess(path.join(root, "target-started"));
  }
});

for (const entryPoint of ["example", "CLI"]) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`experiment ${entryPoint} retains ${signal} status and releases its resource`, async (t) => {
      const { root, recipe } = fixture(t, undefined, "stubborn");
      const recipeFile = path.join(root, "recipe.json"),
        output = path.join(root, "output");
      fs.writeFileSync(recipeFile, JSON.stringify(recipe));
      const child = spawn(
        process.execPath,
        entryPoint === "CLI"
          ? ["dist/cli.js", "benchmark", "experiment", "--recipe", recipeFile, "--output", output]
          : ["examples/benchmark/experiment.mjs", output, recipeFile],
        { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, "close");
      let signalled = false;
      const timer = setInterval(() => {
        if (!signalled && fs.existsSync(path.join(root, "started"))) {
          signalled = true;
          child.kill(signal);
        }
      }, 20);
      try {
        const [code] = await closed;
        assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
        assert.doesNotMatch(stderr, /^Error:|uncaught|^\s+at\s/m);
        assert.match(stderr, new RegExp(`Received ${signal}`));
        assert.throws(
          () => process.kill(Number(fs.readFileSync(path.join(root, "started"), "utf8")), 0),
          /ESRCH/,
          "the collector must stop before the CLI exits",
        );
        assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8")).unattempted.length,
          3,
        );
      } finally {
        clearInterval(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        stopFixtureProcess(path.join(root, "started"));
      }
    });
  }
}
