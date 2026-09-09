import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { assertScenarioTargetCompatibility, loadSpecs, materializeSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { judgeCollected } from "../src/judge-run.js";
import { loadComparisonInput } from "../src/compare.js";
import { checkpointRefs, validateCheckpoints, rubricWasReached } from "../src/checkpoints.js";
import { scoreArea } from "../src/scoring.js";
import { normalizeRubricJudgement } from "../src/judging/rubric.js";
import { bindInputs } from "../src/workflow.js";
import { retainEvidenceFile } from "../src/evidence/files.js";
import type { ScenarioEvidence } from "../src/types.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-evidence-workflows-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Evidence workflows" },
      target: { kind: "command" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
    }),
  );
  return { root, configFile, config: loadConfig(configFile) };
}
const rubric = (id: string) => ({
  id,
  criterion: id,
  weight: 1,
  passCriteria: "Evidence proves it",
  scenarios: [] as string[],
  grader: { type: "command", command: "exit 0", methodFiles: [], output: "exit-code" },
});

test("bindings preserve declared scalar types even when values equal a retained file path", (t) => {
  const f = fixture(t);
  const file = retainEvidenceFile({
    directory: f.root,
    label: "data",
    filename: "data.csv",
    mediaType: "text/csv",
    bytes: Buffer.from("a\n1\n"),
    step: 1,
  });
  const output = { value: file.path, evidenceRefs: ["step:1"] };
  const source = {
    outcome: "completed" as const,
    outputs: { scalar: output, file: output },
    files: [file],
  };
  const consumer = {
    inputs: {
      scalar: { from: "SOURCE", output: "scalar" },
      file: { from: "SOURCE", output: "file" },
    },
  };
  const declarations = new Map([
    [
      "SOURCE",
      {
        outputs: {
          scalar: { type: "string" as const },
          file: { type: "file" as const },
        },
      },
    ],
  ]);
  const bound = bindInputs(consumer, new Map([["SOURCE", source]]), declarations);
  assert.equal(bound.scalar!.value, file.path);
  assert.equal(bound.scalar!.file, undefined);
  assert.deepEqual(bound.file!.file, file);
  assert.throws(
    () => bindInputs(consumer, new Map([["SOURCE", { ...source, files: [] }]]), declarations),
    /no retained file receipt/,
  );
});

test("command collectors exchange typed files and scalars with sealed provenance and resume", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "produce.mjs"),
    `import fs from 'node:fs';import path from 'node:path';const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8'));fs.writeFileSync(path.join(c.outputDir,'result.csv'),'name,value\\nAlice,2\\n');console.log(JSON.stringify({version:1,outcome:'completed',summary:'Exported',observations:[],files:[{label:'table',path:'result.csv',filename:'result.csv',mediaType:'text/csv'}],outputs:{table:{value:'table',evidenceRefs:['step:1']},rows:{value:1,evidenceRefs:['step:1']}},checkpoints:{exported:{evidenceRefs:['step:1']}}}));`,
  );
  fs.writeFileSync(
    path.join(f.root, "consume.mjs"),
    `import fs from 'node:fs';import assert from 'node:assert/strict';const c=JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT,'utf8'));assert.equal(c.inputs.rows.value,1);assert.equal(fs.readFileSync(c.inputs.table.path,'utf8'),'name,value\\nAlice,2\\n');console.log(JSON.stringify({version:1,outcome:'completed',summary:'Verified upstream file',observations:['File data matches']}));`,
  );
  fs.writeFileSync(
    path.join(f.root, "spec.yaml"),
    YAML.stringify({
      id: "exports",
      title: "Exports",
      weight: 100,
      description: "File workflow",
      scenarios: [
        {
          id: "PRODUCE",
          name: "Produce",
          kind: "command",
          instructions: "Export",
          outputs: { table: { type: "file" }, rows: { type: "number" } },
          checkpoints: { exported: "Export data" },
          collect: { command: "node produce.mjs", methodFiles: ["produce.mjs"], files: ["table"] },
        },
        {
          id: "CONSUME",
          name: "Consume",
          kind: "command",
          instructions: "Verify",
          dependsOn: ["PRODUCE"],
          inputs: {
            table: { from: "PRODUCE", output: "table" },
            rows: { from: "PRODUCE", output: "rows" },
          },
          collect: { command: "node consume.mjs", methodFiles: ["consume.mjs"] },
        },
      ],
      rubric: [rubric("EXPORTED")],
    }),
  );
  const specs = loadSpecs(f.config.paths.specs);
  for (const scenarioId of ["PRODUCE", "CONSUME"]) {
    const invalid = structuredClone(specs);
    const scenario = invalid[0]!.scenarios.find((s) => s.id === scenarioId)!;
    scenario.kind = "workspace";
    delete scenario.collect;
    assert.throws(
      () => assertScenarioTargetCompatibility(invalid, f.config.target),
      scenarioId === "PRODUCE"
        ? /file outputs require browser downloads or command/
        : /file input table requires command/,
    );
  }
  const result = await runEvaluation({ ...f, specs, fixtures: {} });
  const scenarios = result.report!.areas[0]!.scenarios;
  const source = scenarios[0]!,
    consumer = scenarios[1]!;
  assert.equal(source.files?.length, 1);
  assert.ok(source.checkpoints?.exported);
  assert.equal(consumer.inputs?.table?.file?.sha256, source.files![0]!.sha256);
  assert.equal(consumer.outcome, "completed");
  assert.ok(loadComparisonInput(path.join(result.runDir, "report.json")));
  const resumed = await runEvaluation({ ...f, specs, fixtures: {}, resumeDir: result.runDir });
  assert.deepEqual(resumed.report!.areas[0]!.scenarios, scenarios);
  const collection = await runEvaluation({ ...f, specs, fixtures: {}, collectOnly: true });
  const judged = await judgeCollected({
    ...f,
    specs,
    fixtures: {},
    evidenceDir: collection.runDir,
  });
  assert.equal(
    judged.report.areas[0]!.scenarios[1]!.inputs?.table?.file?.sha256,
    source.files![0]!.sha256,
  );
});

test("command output contracts distinguish missing evidence from invalid execution", async (t) => {
  const f = fixture(t);
  const manifest = {
    version: 1,
    outcome: "completed",
    summary: "Collected",
    observations: [],
  };
  for (const [outputs, error] of [
    [{ count: { value: "wrong type", evidenceRefs: ["step:1"] } }, /must have type number/],
    [{ count: { value: 2, evidenceRefs: ["step:2"] } }, /unavailable evidence/],
    [{ extra: { value: 2, evidenceRefs: ["step:1"] } }, /Undeclared scenario output/],
    [{}, /Completed collector omitted required outputs/],
    [{}, undefined],
  ] as const) {
    fs.writeFileSync(
      path.join(f.root, "collect.mjs"),
      `console.log(JSON.stringify(${JSON.stringify({ ...manifest, outcome: error ? "completed" : "blocked", outputs })}));`,
    );
    fs.writeFileSync(
      path.join(f.root, "spec.yaml"),
      YAML.stringify({
        id: "contracts",
        title: "Contracts",
        description: "Contracts",
        weight: 100,
        scenarios: [
          {
            id: "SOURCE",
            name: "Source",
            kind: "command",
            instructions: "Collect count",
            outputs: { count: { type: "number" } },
            collect: { command: "node collect.mjs", methodFiles: ["collect.mjs"] },
          },
          {
            id: "DEPENDENT",
            name: "Dependent",
            kind: "command",
            instructions: "Must not run",
            dependsOn: ["SOURCE"],
            inputs: { count: { from: "SOURCE", output: "count" } },
            collect: { command: "exit 19", methodFiles: [] },
          },
        ],
        rubric: [rubric("CONTRACT")],
      }),
    );
    const options = { ...f, specs: loadSpecs(f.config.paths.specs), fixtures: {} };
    if (error) await assert.rejects(runEvaluation(options), error);
    else {
      const result = await runEvaluation(options);
      const evidence = result.report!.areas[0]!.scenarios;
      assert.equal(evidence[0]!.outcome, "blocked");
      assert.match(evidence[0]!.summary, /Required outputs unavailable/);
      assert.equal(evidence[1]!.outcome, "blocked");
      assert.equal(
        fs.existsSync(path.join(result.runDir, "DEPENDENT", "collector-run.json")),
        false,
      );
    }
  }
});

test("declared exclusions skip collectors and grades, retain reasons, and survive collect/judge", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, "spec.yaml"),
    YAML.stringify({
      id: "scope",
      title: "Scope",
      weight: 100,
      description: "Scope",
      scenarios: [
        {
          id: "UNUSED",
          name: "Unused",
          kind: "command",
          instructions: "Must not run",
          collect: { command: "exit 19", methodFiles: [] },
        },
      ],
      rubric: [
        rubric("ACTIVE"),
        {
          ...rubric("EXCLUDED"),
          weight: 3,
          scenarios: ["UNUSED"],
          grader: { type: "llm" },
          applicability: {
            applicable: false,
            reason: "This suite variant does not include AI review",
          },
        },
      ],
    }),
  );
  const specs = loadSpecs(f.config.paths.specs),
    plan = materializeSpecs(specs);
  assert.equal(plan[0]!.scenarios.length, 0);
  assert.equal(plan[0]!.rubric.length, 1);
  const result = await runEvaluation({ ...f, specs, fixtures: {} });
  assert.equal(result.report!.overallCoveragePct, 100);
  assert.equal(result.report!.areas[0]!.total, 1);
  assert.deepEqual(result.report!.areas[0]!.exclusions, [
    { id: "EXCLUDED", weight: 3, reason: "This suite variant does not include AI review" },
  ]);
  assert.match(
    fs.readFileSync(path.join(result.runDir, "report.html"), "utf8"),
    /Declared exclusions/,
  );
  const collection = await runEvaluation({ ...f, specs, fixtures: {}, collectOnly: true });
  const judged = await judgeCollected({
    ...f,
    specs,
    fixtures: {},
    evidenceDir: collection.runDir,
  });
  assert.deepEqual(judged.report.areas[0]!.exclusions, result.report!.areas[0]!.exclusions);
  assert.throws(
    () =>
      loadSpecs(
        (() => {
          fs.writeFileSync(
            path.join(f.root, "spec.yaml"),
            YAML.stringify({
              ...specs[0],
              sourceFile: undefined,
              rubric: [
                {
                  ...rubric("GATE"),
                  gate: true,
                  applicability: { applicable: false, reason: "Skip" },
                },
              ],
            }),
          );
          return f.config.paths.specs;
        })(),
      ),
    /gates cannot be excluded/,
  );
});

test("checkpoint-scoped grading retains reached evidence after a later blockage and rejects unrelated citations", (t) => {
  const f = fixture(t);
  const spec = {
    id: "checks",
    title: "Checks",
    weight: 100,
    optional: false,
    description: "Checks",
    sourceFile: "unused",
    scenarios: [],
    rubric: [
      {
        id: "EARLY",
        criterion: "Saved",
        weight: 1,
        tags: ["persistence"],
        scenarios: ["FLOW"],
        checkpoints: { FLOW: ["saved"] },
        grader: { type: "llm" as const },
        passCriteria: "Saved",
      },
      {
        id: "LATE",
        criterion: "Later",
        weight: 1,
        tags: [],
        scenarios: ["FLOW"],
        checkpoints: { FLOW: ["later"] },
        grader: { type: "llm" as const },
        passCriteria: "Later",
      },
    ],
  };
  const evidence: ScenarioEvidence = {
    scenarioId: "FLOW",
    scenarioName: "Flow",
    kind: "browser",
    outcome: "blocked",
    summary: "Later auth wall",
    observations: [],
    evidenceRefs: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "now",
    finishedAt: "now",
    durationMs: 1,
    transcript: [
      { step: 1, at: "now", tool: "snapshot", input: {}, result: "Persisted value" },
      {
        step: 2,
        at: "now",
        tool: "checkpoint",
        input: { name: "saved", evidenceRefs: ["step:1"] },
        result: "Recorded",
      },
    ],
    checkpoints: { saved: { step: 2, evidenceRefs: ["step:1"] } },
  };
  validateCheckpoints(
    { checkpoints: { saved: "Saved" } },
    evidence.checkpoints,
    evidence.transcript,
  );
  assert.throws(
    () => validateCheckpoints({ checkpoints: { saved: "Saved" } }, {}, evidence.transcript),
    /missing its matching metadata/,
  );
  assert.deepEqual(
    validateCheckpoints({ checkpoints: { saved: "Saved" } }, {}, evidence.transcript.slice(0, 1)),
    {},
  );
  assert.throws(
    () =>
      validateCheckpoints(
        { checkpoints: { saved: "Saved" } },
        { saved: { step: 2, evidenceRefs: ["step:3"] } },
        evidence.transcript,
      ),
    /earlier/,
  );
  assert.equal(rubricWasReached(spec.rubric[0]!, [evidence]), true);
  assert.equal(rubricWasReached(spec.rubric[1]!, [evidence]), false);
  assert.equal(
    rubricWasReached({ ...spec.rubric[0]!, scenarios: ["constructor"], checkpoints: {} }, [
      { ...evidence, scenarioId: "constructor", outcome: "completed" },
    ]),
    true,
  );
  assert.deepEqual(checkpointRefs({ ...evidence, checkpoints: {} }, ["constructor"]), []);
  assert.equal(
    rubricWasReached(
      {
        ...spec.rubric[0]!,
        scenarios: ["FLOW", "MISSING"],
        checkpoints: { FLOW: ["saved"], MISSING: ["saved"] },
      },
      [evidence],
    ),
    false,
  );
  const judgement = {
    items: [
      {
        id: "EARLY",
        verdict: "pass" as const,
        confidence: "high" as const,
        reasoning: "Persisted",
        evidenceRefs: ["FLOW/evidence.json#checkpoint-saved"],
      },
      {
        id: "LATE",
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: "Not reached",
        evidenceRefs: [],
      },
    ],
    cases: [
      {
        rubricId: "EARLY",
        caseId: "default",
        verdict: "pass" as const,
        confidence: "high" as const,
        reasoning: "Persisted",
        evidenceRefs: ["FLOW/browser-transcript.ndjson#step-1"],
      },
      {
        rubricId: "LATE",
        caseId: "default",
        verdict: "cannot_judge" as const,
        confidence: "low" as const,
        reasoning: "Blocked",
        evidenceRefs: [],
      },
    ],
    defects: [],
    notes: "",
  };
  const normalize = () =>
    normalizeRubricJudgement({
      judgement,
      screenshotAccess: "attached",
      spec,
      items: spec.rubric,
      evidence: [evidence],
      directory: f.root,
      attachments: {},
    });
  const normalized = normalize();
  const area = scoreArea({
    spec,
    config: f.config,
    evidence: [evidence],
    judgements: normalized.items,
    caseResults: normalized.cases,
  });
  assert.equal(area.coveragePct, 50);
  assert.equal(area.scorePct, 100);
  judgement.items[0]!.evidenceRefs = ["FLOW/evidence.json"];
  assert.throws(normalize, /out-of-scope/);
  assert.equal(rubricWasReached(spec.rubric[0]!, [{ ...evidence, outcome: "agent_error" }]), false);

  const instances = [
    { ...evidence, scenarioId: "SHARED" },
    { ...evidence, scenarioId: "FLOW--a", caseId: "a" },
    { ...evidence, scenarioId: "FLOW--b", caseId: "b" },
  ];
  const matrixItem = {
    ...spec.rubric[0]!,
    scenarios: instances.map((s) => s.scenarioId),
    checkpoints: Object.fromEntries(instances.map((s) => [s.scenarioId, ["saved"]])),
  };
  const matrixJudgement = {
    items: [{ ...judgement.items[0]!, evidenceRefs: ["SHARED/evidence.json#checkpoint-saved"] }],
    cases: ["a", "b"].map((caseId) => ({
      ...judgement.cases[0]!,
      caseId,
      evidenceRefs: [`FLOW--${caseId}/evidence.json#checkpoint-saved`],
    })),
    defects: [],
    notes: "",
  };
  const normalizeMatrix = () =>
    normalizeRubricJudgement({
      judgement: matrixJudgement,
      screenshotAccess: "attached",
      spec: { ...spec, rubric: [matrixItem] },
      items: [matrixItem],
      evidence: instances,
      directory: f.root,
      attachments: {},
    });
  assert.deepEqual(
    normalizeMatrix().cases.map((c) => c.verdict),
    ["pass", "pass"],
  );
  instances[0]!.checkpoints = {};
  matrixJudgement.items[0]!.evidenceRefs = ["FLOW--a/evidence.json#checkpoint-saved"];
  assert.deepEqual(
    normalizeMatrix().cases.map((c) => c.verdict),
    ["cannot_judge", "cannot_judge"],
  );
});

test("an entirely excluded area is audited without lowering coverage; an entirely excluded suite fails before execution", async (t) => {
  const f = fixture(t);
  const specsDir = path.join(f.root, "specs");
  fs.mkdirSync(specsDir);
  f.config.paths.specs = specsDir;
  fs.writeFileSync(
    path.join(specsDir, "active.yaml"),
    YAML.stringify({
      id: "active",
      title: "Active",
      weight: 60,
      description: "Active",
      rubric: [rubric("ACTIVE")],
    }),
  );
  fs.writeFileSync(
    path.join(specsDir, "excluded.yaml"),
    YAML.stringify({
      id: "excluded",
      title: "Excluded",
      weight: 40,
      description: "Excluded",
      rubric: [
        {
          ...rubric("EXCLUDED"),
          grader: { type: "command", command: "exit 19", methodFiles: [], output: "exit-code" },
          applicability: { applicable: false, reason: "Not in this declared tier" },
        },
      ],
    }),
  );
  const specs = loadSpecs(specsDir);
  const result = await runEvaluation({ ...f, specs, fixtures: {} });
  assert.equal(result.report!.areas.length, 2);
  assert.equal(result.report!.overallCoveragePct, 100);
  assert.equal(result.report!.areas.find((area) => area.id === "excluded")!.total, 0);
  assert.ok(loadComparisonInput(path.join(result.runDir, "report.json")));
  const collection = await runEvaluation({ ...f, specs, fixtures: {}, collectOnly: true });
  const judged = await judgeCollected({
    ...f,
    specs,
    fixtures: {},
    evidenceDir: collection.runDir,
  });
  assert.equal(judged.report.overallCoveragePct, 100);
  assert.equal(judged.report.areas.length, 2);
  await assert.rejects(
    () =>
      runEvaluation({ ...f, specs: specs.filter((spec) => spec.id === "excluded"), fixtures: {} }),
    /no rubric items/,
  );
});
