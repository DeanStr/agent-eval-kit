import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { spawnSync } from "node:child_process";
import { loadComparisonInput } from "../src/compare.js";
import { writeArtifactIndex } from "../src/integrity.js";
import { loadConfig } from "../src/config.js";
import { loadSpecs, materializeSpec, materializeSpecs } from "../src/specs.js";
import { assertSavedWorkflowEvidence, bindInputs, validateOutputs, validateWorkflowSelection } from "../src/workflow.js";
import { runEvaluation } from "../src/runner.js";
import type { Scenario, ScenarioEvidence, TranscriptEntry } from "../src/types.js";

const scenario = (id: string): Scenario => ({ id, name: id, instructions: "Inspect", dependsOn: [], requiresAuth: false, successSignals: [] });
const transcript: TranscriptEntry[] = [{ step: 1, at: "now", tool: "read_file", input: { path: "record.txt" }, result: "record-42" }];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-workflow-"));
  const specsDir = path.join(root, "specs");
  fs.mkdirSync(specsDir);
  const producer = { ...scenario("CREATE"), outputs: { record: { type: "string" as const } } };
  const consumer = { ...scenario("VERIFY"), dependsOn: ["CREATE"], inputs: { record: { from: "CREATE", output: "record" } } };
  const area = (id: string, step: Scenario) => ({ id, title: id, description: id, weight: 50, scenarios: [step], rubric: [{ id: `R-${id}`, criterion: "Works", passCriteria: "Verified", weight: 1, scenarios: [step.id] }] });
  const write = () => {
    fs.writeFileSync(path.join(specsDir, "01-consumer.yaml"), YAML.stringify(area("consumer", consumer)));
    fs.writeFileSync(path.join(specsDir, "02-producer.yaml"), YAML.stringify(area("producer", producer)));
  };
  write();
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(configFile, YAML.stringify({ version: 1, project: { name: "Workflow", root }, target: { kind: "repository" }, agent: { provider: "mock" }, judge: { provider: "mock" }, paths: { specs: "specs" } }));
  return { root, specsDir, configFile, producer, consumer, write };
}

test("suite dependencies validate cycles, bindings, matrix expansion and missing selected areas", () => {
  const f = fixture();
  try {
    let specs = loadSpecs(f.specsDir);
    assert.doesNotThrow(() => validateWorkflowSelection(specs));
    assert.throws(() => validateWorkflowSelection([specs[0]]), /CREATE.*outside the selected areas/);
    f.producer.cases = [{ id: "one", variables: {}, strata: [] }];
    f.consumer.cases = [{ id: "one", variables: {}, strata: [] }];
    f.write();
    assert.throws(() => materializeSpec(loadSpecs(f.specsDir)[0]), /Cannot expand dependency CREATE/);
    specs = materializeSpecs(loadSpecs(f.specsDir));
    assert.deepEqual(specs[0].scenarios[0].dependsOn, ["CREATE--one"]);
    assert.equal(specs[0].scenarios[0].inputs?.record.from, "CREATE--one");
    f.consumer.inputs.record.output = "missing";
    f.write();
    assert.throws(() => loadSpecs(f.specsDir), /unknown output CREATE.missing/);
    f.consumer.inputs.record.output = "constructor";
    f.write();
    assert.throws(() => loadSpecs(f.specsDir), /unknown output CREATE.constructor/);
    f.consumer.inputs.record.output = "record";
    f.producer.dependsOn = ["VERIFY"];
    f.write();
    assert.throws(() => loadSpecs(f.specsDir), /dependency cycle/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("split filtering retains transitive setup areas without scoring them", async () => {
  const f = fixture();
  try {
    const specs = loadSpecs(f.specsDir);
    const producer = specs.find(spec => spec.id === "producer")!;
    const consumer = specs.find(spec => spec.id === "consumer")!;
    delete producer.scenarios[0].outputs;
    delete consumer.scenarios[0].inputs;
    producer.scenarios[0].dependsOn = ["PREPARE"];
    producer.scenarios.push({ ...scenario("EVALUATE"), split: "evaluation" }, scenario("UNUSED"));
    producer.rubric[0].scenarios = ["EVALUATE"];
    const setup = { ...producer, id: "setup", scenarios: [scenario("PREPARE"), { ...scenario("EVALUATE-SETUP"), split: "evaluation" as const }],
      rubric: [{ ...producer.rubric[0], id: "R-setup", scenarios: ["EVALUATE-SETUP"] }] };
    setup.sourceFile = path.join(f.specsDir, "03-setup.yaml");
    const unused = { ...producer, id: "unused", sourceFile: path.join(f.specsDir, "04-unused.yaml"),
      scenarios: [scenario("UNUSED-DEPENDENCY"), { ...scenario("EVALUATE-UNUSED"), split: "evaluation" as const }],
      rubric: [{ ...producer.rubric[0], id: "R-unused", scenarios: ["EVALUATE-UNUSED"] }] };
    producer.scenarios.find(s => s.id === "UNUSED")!.cases = [{ id: "one", variables: {}, strata: ["kind=unused"] }];
    producer.scenarios.find(s => s.id === "UNUSED")!.dependsOn = ["UNUSED-DEPENDENCY"];
    specs.push(setup, unused);
    for (const spec of specs) spec.weight = 25;
    for (const { sourceFile, ...definition } of specs) fs.writeFileSync(sourceFile, YAML.stringify(definition));
    const expanded = materializeSpecs(specs, "development");
    assert.deepEqual(expanded.find(spec => spec.id === "producer")!.scenarios.map(s => s.id), ["CREATE"]);
    assert.deepEqual(expanded.find(spec => spec.id === "setup")!.scenarios.map(s => s.id), ["PREPARE"]);
    validateWorkflowSelection(expanded);
    const selectedWithoutUnusedArea = specs.filter(spec => spec.id !== "unused");
    assert.deepEqual(materializeSpecs(selectedWithoutUnusedArea, "development"), expanded);
    const options = { config: loadConfig(f.configFile), configFile: f.configFile, specs: loadSpecs(f.specsDir), fixtures: {} };
    const result = await runEvaluation(options);
    assert.deepEqual(result.report!.areas.map(area => area.id), ["consumer"]);
    for (const id of ["PREPARE", "CREATE", "VERIFY"]) assert.ok(fs.existsSync(path.join(result.runDir, id, "evidence.json")));
    assert.equal(fs.existsSync(path.join(result.runDir, "UNUSED")), false);
    const before = fs.readFileSync(path.join(result.runDir, "CREATE", "evidence.json"), "utf8");
    const resumed = await runEvaluation({ ...options, resumeDir: result.runDir });
    assert.deepEqual(resumed.report!.areas.map(area => area.id), ["consumer"]);
    assert.equal(fs.readFileSync(path.join(result.runDir, "CREATE", "evidence.json"), "utf8"), before);
    assert.deepEqual(loadComparisonInput(result.runDir).report.receipt.inputs.selection.areas, ["consumer"]);
    const cliResume = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "run", "--resume", result.runDir], { encoding: "utf8" });
    assert.equal(cliResume.status, 0, `${cliResume.stdout}\n${cliResume.stderr}`);
    assert.equal(fs.readFileSync(path.join(result.runDir, "CREATE", "evidence.json"), "utf8"), before);
    for (const command of ["rescore", "finalize"]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), command, "--run", result.runDir], { encoding: "utf8" });
      assert.equal(child.status, 0, `${command}: ${child.stdout}\n${child.stderr}`);
      assert.deepEqual(loadComparisonInput(result.runDir).report.areas.map(area => area.id), ["consumer"]);
    }
    const selectedRun = await runEvaluation({ ...options, specs: options.specs.filter(spec => spec.id !== "unused") });
    assert.deepEqual(loadComparisonInput(selectedRun.runDir).report.areas.map(area => area.id), ["consumer"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("outputs require declared types and real successful evidence; bindings retain provenance", () => {
  const declaration: Scenario = { ...scenario("CREATE"), outputs: { record: { type: "string" }, url: { type: "url" } } };
  const output = { record: { value: "record-42", evidenceRefs: ["step:1"] } };
  assert.deepEqual(validateOutputs(declaration, output, transcript), output);
  assert.throws(() => validateOutputs(declaration, { missing: output.record }, transcript), /Undeclared/);
  assert.throws(() => validateOutputs(declaration, { record: { ...output.record, value: 42 } }, transcript), /type string/);
  assert.throws(() => validateOutputs(declaration, output, [{ ...transcript[0], isError: true }]), /unavailable evidence/);
  assert.throws(() => validateOutputs(declaration, output, [
    { ...transcript[0], tool: "observe", input: { note: "Invented record-42" } },
    { ...transcript[0], step: 2 },
  ]), /unavailable evidence step:1/);
  assert.throws(() => validateOutputs(declaration, { url: { ...output.record, value: "https://app.test/?token=secret" } }, transcript), /without credentials/);
  const consumer = { ...scenario("VERIFY"), inputs: { id: { from: "CREATE", output: "record" } } };
  const evidence = new Map([["CREATE", { outcome: "completed", outputs: output } as Pick<ScenarioEvidence, "outcome" | "outputs">]]);
  assert.deepEqual(bindInputs(consumer, evidence).id, { ...output.record, scenarioId: "CREATE", output: "record" });
  assert.throws(() => bindInputs(consumer, new Map()), /did not complete/);
});

test("missing outputs block downstream execution without fabricated values or scores", async () => {
  const f = fixture();
  try {
    const result = await runEvaluation({ config: loadConfig(f.configFile), configFile: f.configFile, specs: loadSpecs(f.specsDir), fixtures: {} });
    const producer = result.report!.areas.find(area => area.id === "producer")!.scenarios[0];
    const consumer = result.report!.areas.find(area => area.id === "consumer")!.scenarios[0];
    assert.equal(producer.outcome, "blocked");
    assert.match(producer.summary, /Required outputs unavailable: record/);
    assert.equal(consumer.outcome, "blocked");
    assert.equal(fs.existsSync(path.join(result.runDir, "VERIFY", "provider-run.json")), false);
    assert.equal(result.report!.overallCoveragePct, 0);
    const blockedFile = path.join(result.runDir, "VERIFY", "evidence.json");
    const before = fs.readFileSync(blockedFile, "utf8");
    await runEvaluation({ config: loadConfig(f.configFile), configFile: f.configFile, specs: loadSpecs(f.specsDir), fixtures: {}, resumeDir: result.runDir });
    assert.equal(fs.readFileSync(blockedFile, "utf8"), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("cross-area outputs reach downstream prompts and survive sealed resume", async () => {
  const f = fixture();
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
if (process.argv.includes('--version')) { console.log('claude workflow-test 1.0'); process.exit(0); }
const directory = path.dirname(process.argv[process.argv.lastIndexOf('--mcp-config') + 1]);
const result = {outcome:'completed',summary:'Observed record',observations:[],evidenceRefs:[]};
fs.writeFileSync(path.join(directory,'workspace-result.json'),JSON.stringify({...result,finishedAt:new Date().toISOString()}));
fs.writeFileSync(path.join(directory,'workspace-transcript.ndjson'),JSON.stringify(${JSON.stringify(transcript[0])})+'\\n');
if(path.basename(directory)==='CREATE') fs.writeFileSync(path.join(directory,'outputs.json'),JSON.stringify({record:{value:'record-'+Date.now(),evidenceRefs:['step:1']}}));
console.log(JSON.stringify({type:'result',structured_output:result,result:JSON.stringify(result)}));
`);
  fs.chmodSync(path.join(bin, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
  try {
    const config = loadConfig(f.configFile);
    config.agent.provider = "claude";
    const options = { config, configFile: f.configFile, specs: loadSpecs(f.specsDir), fixtures: {} };
    const result = await runEvaluation(options);
    assert.match(fs.readFileSync(path.join(result.runDir, "VERIFY", "prompt.md"), "utf8"), /record-/);
    const bound = result.report!.areas[0].scenarios[0].inputs!.record;
    assert.equal(bound.scenarioId, "CREATE");
    const file = path.join(result.runDir, "CREATE", "outputs.json");
    const before = fs.statSync(file).mtimeMs;
    const resumed = await runEvaluation({ ...options, resumeDir: result.runDir });
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.deepEqual(resumed.report!.areas[0].scenarios[0].inputs!.record, bound);
    // Simulate a second interruption after new upstream evidence was sealed but
    // before the dependent evidence and report were regenerated.
    const sourceFile = path.join(result.runDir, "CREATE", "evidence.json");
    const resealedSource = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    resealedSource.outputs.record.value = "record-after-interruption";
    fs.writeFileSync(sourceFile, JSON.stringify(resealedSource));
    fs.writeFileSync(file, JSON.stringify(resealedSource.outputs));
    writeArtifactIndex(result.runDir);
    const twiceResumed = await runEvaluation({ ...options, resumeDir: result.runDir });
    assert.equal(twiceResumed.report!.areas[0].scenarios[0].inputs!.record.value, "record-after-interruption");
    assert.equal(twiceResumed.report!.areas[1].scenarios[0].outputs!.record.value, "record-after-interruption");
    // An interrupted upstream scenario must invalidate downstream evidence and
    // area judgments, even when the downstream artifacts themselves are sealed.
    const stateFile = path.join(result.runDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, status: "failed" }));
    fs.appendFileSync(path.join(result.runDir, "CREATE", "provider-run.json"), " interrupted");
    // Recollection can be interrupted after removing previously sealed outputs.
    fs.rmSync(file);
    const recovered = await runEvaluation({ ...options, resumeDir: result.runDir });
    const newBound = recovered.report!.areas[0].scenarios[0].inputs!.record;
    assert.notEqual(newBound.value, bound.value);
    assert.equal(newBound.value, recovered.report!.areas[1].scenarios[0].outputs!.record.value);
    assert.match(fs.readFileSync(path.join(result.runDir, "VERIFY", "prompt.md"), "utf8"), new RegExp(String(newBound.value)));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});


test("sealed workflow evidence cannot silently discard missing provenance", () => {
  const producer = { ...scenario("CREATE"), outputs: { record: { type: "string" as const } } };
  const consumer = { ...scenario("VERIFY"), dependsOn: ["CREATE"], inputs: { record: { from: "CREATE", output: "record" } } };
  const saved = { outcome: "completed", transcript: [] } as unknown as ScenarioEvidence;
  assert.throws(() => assertSavedWorkflowEvidence(producer, saved), /missing required output record/);
  assert.throws(() => assertSavedWorkflowEvidence(consumer, saved), /missing or invalid prerequisite hashes/);
  assert.throws(() => assertSavedWorkflowEvidence(consumer, { ...saved, dependencyEvidence: { CREATE: "a".repeat(64) } }), /missing bound input record/);
  assert.doesNotThrow(() => assertSavedWorkflowEvidence(producer, { ...saved, outcome: "blocked" }));
});
