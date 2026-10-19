import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
if(s.mode==='hang')await new Promise(()=>{setInterval(()=>{},1000)});
const m={version:1,candidate:{id:s.id,revision:s.id},workload:{id:'work',sha256:'a'.repeat(64)},method:{id:'timer',sha256:'b'.repeat(64)},environment:{hardware:'fixture'},work:{unit:'items',requested:1,completed:1},outcome:{state:'completed'},metrics:[{id:'time',unit:'ms',preferredDirection:'lower',scope:'application',observation:{state:'observed',samples:[s.id==='baseline'?10:5]}}],correctness:[{scenarioId:'WORKLOAD',fileLabel:'raw'}]};
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
  const { root, recipe } = fixture(t, ["baseline", "middle", "candidate"]);
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
    [-5, -5],
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

test("cancellation drains the collector and releases the resource before returning", async (t) => {
  const { root, recipe } = fixture(t, undefined, "hang");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Stopped experiment")), 500);
  try {
    const result = await runBenchmarkExperiment(path.join(root, "output"), recipe, {
      signal: controller.signal,
    });
    assert.equal(result.outcome, "execution_error");
    assert.equal(result.visits.length, 1);
    assert.equal(fs.existsSync(path.join(recipe.resource, ".run.lock")), false);
  } finally {
    clearTimeout(timer);
  }
});
