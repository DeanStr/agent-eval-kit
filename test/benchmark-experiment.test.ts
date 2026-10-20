import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import YAML from "yaml";
import {
  benchmarkExperimentSchema,
  counterbalancedBlocks,
  runBenchmarkExperiment,
} from "../src/benchmark-experiment.js";
import { withRunLock } from "../src/run/state.js";

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
if(s.mode==='hang'){fs.writeFileSync(path.resolve('..','started'),'');await new Promise(()=>{setInterval(()=>{},1000)});}
if(s.mode==='mutate')fs.appendFileSync('subject.json',' ');
if(s.mode==='managed'){fs.mkdirSync('.agent-eval/old-run',{recursive:true});fs.appendFileSync('.agent-eval/old-run/log','another run');}
let value=s.id==='baseline'?10:5;
if(s.mode==='paired'){const log=path.resolve('..','observations.json'),visits=fs.existsSync(log)?JSON.parse(fs.readFileSync(log,'utf8')):[],n=visits.filter(id=>id===s.id).length;value=s.id==='baseline'?[10,20][n]:[5,12][n];visits.push(s.id);fs.writeFileSync(log,JSON.stringify(visits));}
const m={version:1,candidate:{id:s.id,revision:s.id},workload:{id:'work',sha256:'a'.repeat(64)},method:{id:'timer',sha256:'b'.repeat(64)},environment:{hardware:'fixture'},work:{unit:'items',requested:1,completed:1},outcome:{state:'completed'},metrics:[{id:'time',unit:'ms',preferredDirection:'lower',scope:'application',observation:{state:'observed',samples:[value]}}],correctness:[{scenarioId:'WORKLOAD',fileLabel:'raw'}]};
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

test("preflight failure leaves the requested output available for a corrected retry", async (t) => {
  const { root, recipe } = fixture(t);
  const file = recipe.candidates.candidate!,
    body = fs.readFileSync(file);
  fs.writeFileSync(file, "invalid: config");
  const output = path.join(root, "output");
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
  assert.match(result.error!, /inputs changed during visit/);
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`packaged experiment retains ${signal} status and releases its resource`, async (t) => {
    const { root, recipe } = fixture(t, undefined, "hang");
    const recipeFile = path.join(root, "recipe.json"),
      output = path.join(root, "output");
    fs.writeFileSync(recipeFile, JSON.stringify(recipe));
    const child = spawn(
      process.execPath,
      ["examples/benchmark/experiment.mjs", output, recipeFile],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, "started"))) child.kill(signal);
    }, 20);
    try {
      const [code] = await closed;
      assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
      assert.doesNotMatch(stderr, /^Error:|uncaught|at file:/m);
      assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8")).unattempted.length,
        3,
      );
    } finally {
      clearInterval(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
}
