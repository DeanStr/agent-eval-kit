import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { assertScenarioTargetCompatibility, loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import {
  collectorInputDefinitions,
  collectorInputs,
  collectorInputPath,
  snapshotCollectorInputs,
} from "../src/collectors/inputs.js";
import { collectCommand } from "../src/collectors/command.js";
import { buildRunReceipt } from "../src/receipts.js";
import { verifyArtifactIndex } from "../src/integrity.js";
import { loadComparisonInput } from "../src/compare.js";
import { promoteBaseline } from "../src/baselines.js";
import { validateVisualInputs, visualEvidenceReader } from "../src/visual/inputs.js";
import { withCancellation } from "../src/cancellation.js";

const collector = `
import fs from 'node:fs'; import path from 'node:path';
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, 'utf8'));
fs.copyFileSync(context.sources.artifact.path, path.join(context.outputDir, 'image.png'));
console.log(JSON.stringify({version:1,outcome:'completed',summary:'Collected exported image',observations:['Exported pixels only'],images:[{label:'export',path:'image.png',source:'artifact',extraction:'Copied the pinned PNG',timeSeconds:1.25}]}));
`;

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-collector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sharp({ create: { width: 32, height: 32, channels: 3, background: "#2475c8" } })
    .png()
    .toFile(path.join(root, "source.png"));
  fs.copyFileSync(path.join(root, "source.png"), path.join(root, "reference.png"));
  fs.writeFileSync(path.join(root, "collect.mjs"), collector);
  const configFile = path.join(root, "evalkit.yaml"),
    specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Collector" },
      target: { kind: "repository" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "spec.yaml" },
    }),
  );
  fs.writeFileSync(
    specFile,
    YAML.stringify({
      id: "visual",
      title: "Visual",
      weight: 100,
      description: "Export checks",
      scenarios: [
        {
          id: "EXPORT",
          name: "Export",
          kind: "command",
          instructions: "Collect exported artifact",
          collect: {
            command: "node collect.mjs",
            methodFiles: ["collect.mjs"],
            sources: { artifact: "source.png" },
            images: ["export"],
          },
        },
      ],
      rubric: [
        {
          id: "READABLE",
          criterion: "Readable export",
          weight: 1,
          scenarios: ["EXPORT"],
          grader: { type: "llm" },
          gate: true,
          passCriteria: "Labels are readable",
        },
        {
          id: "PAIR",
          criterion: "Good hierarchy",
          weight: 1,
          scenarios: ["EXPORT"],
          grader: {
            type: "pairwise",
            candidate: "export",
            references: [{ file: "reference.png" }],
            policy: "non_regression",
            voting: { minimumVotes: 1, maximumVotes: 1 },
          },
          passCriteria: "At least as readable as the reference",
        },
      ],
    }),
  );
  const config = loadConfig(configFile),
    specs = loadSpecs(specFile);
  const runDir = path.join(config.paths.runs, "direct"),
    directory = path.join(runDir, "EXPORT");
  return { root, configFile, specFile, config, specs, fixtures: {}, runDir, directory };
}

function prepare(value: Awaited<ReturnType<typeof fixture>>) {
  fs.mkdirSync(value.directory, { recursive: true });
  const receipt = buildRunReceipt(value);
  snapshotCollectorInputs(value.config, value.specs, value.runDir, "all", receipt.inputs);
  fs.writeFileSync(path.join(value.runDir, "receipt.json"), JSON.stringify(receipt));
  return receipt;
}

test("command evidence reaches LLM and pairwise grading, seals sources, resumes, and promotes images", async (t) => {
  const value = await fixture(t);
  const result = await runEvaluation(value);
  const report = result.report!;
  const evidence = requireDefined(
    requireDefined(report.areas[0], "report.areas[0]").scenarios[0],
    "report.areas[0].scenarios[0]",
  );
  assert.equal(evidence.collector, "command");
  assert.equal(evidence.outcome, "completed");
  assert.equal(
    requireDefined(evidence.screenshots[0], "evidence.screenshots[0]").timeSeconds,
    1.25,
  );
  assert.equal(
    report.overallCoveragePct,
    0,
    "mock judges abstain; collection must not fabricate quality",
  );
  assert.equal(report.gates.passed, false);
  assert.ok(verifyArtifactIndex(result.runDir).ok);
  assert.equal(
    requireDefined(
      requireDefined(
        loadComparisonInput(result.runDir).report.areas[0],
        "loadComparisonInput(result.runDir).report.areas[0]",
      ).scenarios[0],
      "loadComparisonInput(result.runDir).report.areas[0].scenarios[0]",
    ).collector,
    "command",
  );
  const candidate = visualEvidenceReader(result.runDir).candidate(evidence, "export");
  assert.ok(candidate);
  assert.throws(
    () => visualEvidenceReader(result.runDir).candidate({ ...evidence, screenshots: [] }, "export"),
    /Completed command collection/,
  );
  const prompt = fs.readFileSync(path.join(result.runDir, "areas/visual/_judge/prompt.md"), "utf8");
  assert.match(prompt, /Copied the pinned PNG/);
  assert.match(prompt, /"visualAvailable": true/);
  const resumed = await runEvaluation({ ...value, resumeDir: result.runDir });
  assert.equal(
    requireDefined(
      requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").scenarios[0],
      "resumed.report!.areas[0].scenarios[0]",
    ).startedAt,
    evidence.startedAt,
  );
  const baseline = promoteBaseline({
    config: value.config,
    runDir: result.runDir,
    name: "export",
    reviewer: "test",
    mode: "milestone",
    reason: "Reviewed mock export fixture",
    includeImages: true,
  });
  assert.ok(Object.values(baseline.promotion.images!).some((image) => image.label === "export"));
  fs.writeFileSync(candidate!.file, "tampered image");
  assert.equal(verifyArtifactIndex(result.runDir).ok, false);
  await assert.rejects(
    runEvaluation({ ...value, resumeDir: result.runDir }),
    /changed|integrity|checksum/i,
  );
});

test("collector source changes prevent resume but preserve evaluator compatibility and offline provenance", async (t) => {
  const value = await fixture(t);
  const result = await runEvaluation(value);
  const before = result.report!.receipt;
  await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ff0000" } })
    .png()
    .toFile(path.join(value.root, "source.png"));
  const after = buildRunReceipt({ ...value, split: "development" });
  assert.equal(after.evaluationFingerprint, before.evaluationFingerprint);
  assert.notEqual(after.inputFingerprint, before.inputFingerprint);
  await assert.rejects(
    runEvaluation({ ...value, resumeDir: result.runDir }),
    /changed since this run began/,
  );
  fs.unlinkSync(path.join(value.root, "source.png"));
  const offline = buildRunReceipt({ ...value, split: "development", evidenceProvenance: before });
  assert.deepEqual(offline.inputs.collectorSources, before.inputs.collectorSources);
});

test("collector decodes immutable snapshots even if the project original changes", async (t) => {
  const value = await fixture(t);
  const receipt = prepare(value);
  fs.writeFileSync(path.join(value.root, "source.png"), "changed original");
  const evidence = await collectCommand(
    value.config,
    requireDefined(
      requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
      "value.specs[0].scenarios[0]",
    ),
    value.directory,
  );
  assert.equal(evidence.outcome, "completed");
  assert.equal(
    (
      await sharp(
        path.join(
          value.directory,
          requireDefined(evidence.screenshots[0], "evidence.screenshots[0]").path,
        ),
      ).metadata()
    ).width,
    32,
  );
  assert.ok(fs.existsSync(collectorInputPath(value.runDir, "EXPORT/artifact")));
  assert.ok(
    requireDefined(
      receipt.inputs.collectorSources!["EXPORT/artifact"],
      'receipt.inputs.collectorSources!["EXPORT/artifact"]',
    ).sha256,
  );
});

test("blocked collection is unavailable evidence and never a fabricated score", async (t) => {
  const value = await fixture(t);
  fs.writeFileSync(
    path.join(value.root, "collect.mjs"),
    `console.log(JSON.stringify({version:1,outcome:'blocked',summary:'Required page is unavailable in this artifact',observations:[],images:[]}))`,
  );
  const result = await runEvaluation(value);
  assert.equal(
    requireDefined(
      requireDefined(result.report!.areas[0], "result.report!.areas[0]").scenarios[0],
      "result.report!.areas[0].scenarios[0]",
    ).outcome,
    "blocked",
  );
  assert.equal(result.report!.overallCoveragePct, 0);
  assert.equal(result.report!.overallScorePct, null);
});

test("collector rejects invalid manifests, paths, images, exits and modified source snapshots", async (t) => {
  const cases: Array<[string, string, RegExp]> = [
    ["bad JSON", "console.log('not json')", /JSON|Unexpected token/],
    [
      "missing image",
      collector.replace(
        "images:[{label:'export',path:'image.png',source:'artifact',extraction:'Copied the pinned PNG',timeSeconds:1.25}]",
        "images:[]",
      ),
      /every declared image/,
    ],
    [
      "traversal",
      collector.replace("path:'image.png'", "path:'../source.png'"),
      /relative to its output/,
    ],
    [
      "symlink escape",
      collector.replace(
        "fs.copyFileSync(context.sources.artifact.path, path.join(context.outputDir, 'image.png'));",
        "fs.symlinkSync(context.sources.artifact.path, path.join(context.outputDir, 'image.png'));",
      ),
      /escapes output directory/,
    ],
    [
      "unknown source",
      collector.replace("source:'artifact'", "source:'other'"),
      /Unknown collector source/,
    ],
    [
      "corrupt image",
      collector.replace(
        "fs.copyFileSync(context.sources.artifact.path, path.join(context.outputDir, 'image.png'));",
        "fs.writeFileSync(path.join(context.outputDir, 'image.png'), 'corrupt');",
      ),
      /unsupported image|corrupt/i,
    ],
    ["execution failure", "process.exit(1)", /exited 1/],
    [
      "blocked with images",
      collector.replace("outcome:'completed'", "outcome:'blocked'"),
      /Blocked collector must return no images/,
    ],
    [
      "snapshot mutation",
      collector.replace(
        "console.log(JSON.stringify",
        "fs.chmodSync(context.sources.artifact.path,0o644);fs.writeFileSync(context.sources.artifact.path,'changed');console.log(JSON.stringify",
      ),
      /modified source snapshot/,
    ],
  ];
  for (const [name, script, expected] of cases)
    await t.test(name, async (sub) => {
      const value = await fixture(sub);
      fs.writeFileSync(path.join(value.root, "collect.mjs"), script);
      prepare(value);
      await assert.rejects(
        collectCommand(
          value.config,
          requireDefined(
            requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
            "value.specs[0].scenarios[0]",
          ),
          value.directory,
        ),
        expected,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(value.directory, "evidence.json"), "utf8")).outcome,
        "agent_error",
      );
    });
});

test("collector timeout and cancellation terminate execution and retain errors", async (t) => {
  for (const cancel of [false, true])
    await t.test(cancel ? "cancel" : "timeout", async (sub) => {
      const value = await fixture(sub);
      fs.writeFileSync(path.join(value.root, "collect.mjs"), "setInterval(()=>{},1000)");
      prepare(value);
      const scenario = requireDefined(
        requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
        "value.specs[0].scenarios[0]",
      );
      scenario.collect!.timeoutSeconds = cancel ? 10 : 0.1;
      const controller = new AbortController();
      const timer = cancel
        ? setTimeout(() => controller.abort(new Error("test cancellation")), 100)
        : undefined;
      try {
        await assert.rejects(
          withCancellation(controller.signal, () =>
            collectCommand(value.config, scenario, value.directory),
          ),
          cancel ? /cancellation|interrupt|abort/i : /timed out/,
        );
      } finally {
        clearTimeout(timer);
      }
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(value.directory, "evidence.json"), "utf8")).outcome,
        "agent_error",
      );
    });
});

test("collector validation rejects wrong modes, unknown candidate labels and external sources before execution", async (t) => {
  const value = await fixture(t);
  const scenario = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  );
  scenario.kind = "workspace";
  assert.throws(
    () => assertScenarioTargetCompatibility(value.specs, value.config.target),
    /collect requires command mode/,
  );
  scenario.kind = "command";
  scenario.collect!.images = ["other"];
  await assert.rejects(
    validateVisualInputs(value.config, value.specs),
    /undeclared collector image/,
  );
  scenario.collect!.sources.artifact = "../outside.png";
  await assert.rejects(
    validateVisualInputs(value.config, value.specs),
    /Build the artifact before running AEK/,
  );
  scenario.collect!.sources.artifact = "evalkit.yaml";
  fs.symlinkSync(process.execPath, path.join(value.root, "external-source"));
  scenario.collect!.sources.artifact = "external-source";
  assert.throws(() => collectorInputs(value.config, value.specs), /escapes project.root/);
  scenario.collect!.sources.artifact = "source.png";
  const inputs = collectorInputs(value.config, value.specs);
  assert.equal(Object.keys(inputs).length, 1);
});

test("matrix command images feed deterministic graders without model scores", async (t) => {
  const value = await fixture(t);
  const raw = YAML.parse(fs.readFileSync(value.specFile, "utf8"));
  raw.scenarios[0].cases = [{ id: "first" }, { id: "second" }];
  raw.rubric = [
    {
      id: "DISTINCT",
      criterion: "Exports differ",
      weight: 1,
      scenarios: ["EXPORT"],
      grader: { type: "image-distinctness", candidate: "export", minimumDistance: 0.01 },
      passCriteria: "Exported images visibly differ",
    },
  ];
  fs.writeFileSync(value.specFile, YAML.stringify(raw));
  value.specs = loadSpecs(value.specFile);
  const result = await runEvaluation(value);
  assert.equal(result.report!.overallCoveragePct, 100);
  assert.equal(
    result.report!.overallScorePct,
    0,
    "identical exported images are an observed distinctness failure",
  );
  assert.deepEqual(
    requireDefined(result.report!.areas[0], "result.report!.areas[0]").scenarios.map(
      (s) => s.caseId,
    ),
    ["first", "second"],
  );
  assert.ok(result.report!.receipt.inputs.collectorSources!["EXPORT--first/artifact"]);
  assert.ok(result.report!.receipt.inputs.collectorSources!["EXPORT--second/artifact"]);
});

test("collector method bytes affect compatibility while offline rescore retains the sealed method", async (t) => {
  const value = await fixture(t);
  const result = await runEvaluation(value);
  const before = result.report!.receipt;
  const key = "EXPORT/collect.mjs";
  assert.ok(before.inputs.collectorMethods![key]);
  assert.equal(
    fs.readFileSync(collectorInputPath(result.runDir, key, "methods"), "utf8"),
    collector,
  );
  fs.appendFileSync(
    path.join(value.root, "collect.mjs"),
    "\n// changed extraction implementation\n",
  );
  const after = buildRunReceipt({ ...value, split: "development" });
  assert.notEqual(after.evaluationFingerprint, before.evaluationFingerprint);
  assert.notEqual(after.inputs.methodSha256, before.inputs.methodSha256);
  await assert.rejects(
    runEvaluation({ ...value, resumeDir: result.runDir }),
    /changed since this run began/,
  );
  fs.unlinkSync(path.join(value.root, "collect.mjs"));
  const offline = buildRunReceipt({ ...value, split: "development", evidenceProvenance: before });
  assert.equal(offline.evaluationFingerprint, before.evaluationFingerprint);
  assert.deepEqual(offline.inputs.collectorMethods, before.inputs.collectorMethods);
});

test("collector rejects method changes after snapshot and during execution", async (t) => {
  for (const during of [false, true])
    await t.test(during ? "during execution" : "before execution", async (sub) => {
      const value = await fixture(sub);
      if (during)
        fs.writeFileSync(
          path.join(value.root, "collect.mjs"),
          collector + "\nfs.appendFileSync(new URL(import.meta.url), '// changed');\n",
        );
      prepare(value);
      if (!during) fs.appendFileSync(path.join(value.root, "collect.mjs"), "// changed");
      await assert.rejects(
        collectCommand(
          value.config,
          requireDefined(
            requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
            "value.specs[0].scenarios[0]",
          ),
          value.directory,
        ),
        /Collector method changed/,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(value.directory, "evidence.json"), "utf8")).outcome,
        "agent_error",
      );
    });
});

test("scenario selection skips unavailable collector inputs and preserves blocked coverage", async (t) => {
  const value = await fixture(t);
  const raw = YAML.parse(fs.readFileSync(value.specFile, "utf8"));
  raw.scenarios.push({
    ...raw.scenarios[0],
    id: "UNSELECTED",
    collect: {
      ...raw.scenarios[0].collect,
      sources: { missing: "missing.pdf" },
      methodFiles: ["missing-extractor.mjs"],
    },
  });
  raw.rubric.push({ ...raw.rubric[0], id: "SKIPPED", scenarios: ["UNSELECTED"] });
  fs.writeFileSync(value.specFile, YAML.stringify(raw));
  value.specs = loadSpecs(value.specFile);
  await assert.rejects(validateVisualInputs(value.config, value.specs), /missing.pdf/);
  const options = { ...value, scenarioIds: ["EXPORT"] };
  const result = await runEvaluation(options);
  assert.deepEqual(Object.keys(result.report!.receipt.inputs.collectorSources!), [
    "EXPORT/artifact",
  ]);
  assert.deepEqual(Object.keys(result.report!.receipt.inputs.collectorMethods!), [
    "EXPORT/collect.mjs",
  ]);
  assert.equal(
    requireDefined(result.report!.areas[0], "result.report!.areas[0]").scenarios.find(
      (s) => s.scenarioId === "UNSELECTED",
    )!.outcome,
    "blocked",
  );
  const resumed = await runEvaluation({ ...options, resumeDir: result.runDir });
  assert.equal(
    requireDefined(
      requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").scenarios[0],
      "resumed.report!.areas[0].scenarios[0]",
    ).startedAt,
    requireDefined(
      requireDefined(result.report!.areas[0], "result.report!.areas[0]").scenarios[0],
      "result.report!.areas[0].scenarios[0]",
    ).startedAt,
  );
});

test("collector input selection accepts both matrix template and materialized case IDs", async (t) => {
  const value = await fixture(t);
  const scenario = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  );
  scenario.cases = [
    { id: "first", variables: {}, strata: [] },
    { id: "second", variables: {}, strata: [] },
  ];
  assert.deepEqual(
    Object.keys(collectorInputs(value.config, value.specs, "all", ["EXPORT--second"])),
    ["EXPORT--second/artifact"],
  );
  assert.deepEqual(Object.keys(collectorInputs(value.config, value.specs, "all", ["EXPORT"])), [
    "EXPORT--first/artifact",
    "EXPORT--second/artifact",
  ]);
});

test("offline rescore rejects missing or invalid required collector provenance without reading original artifacts", async (t) => {
  const value = await fixture(t);
  const before = buildRunReceipt(value);
  fs.unlinkSync(path.join(value.root, "source.png"));
  fs.unlinkSync(path.join(value.root, "collect.mjs"));
  const offline = buildRunReceipt({ ...value, evidenceProvenance: before });
  assert.deepEqual(offline.inputs.collectorSources, before.inputs.collectorSources);
  assert.deepEqual(offline.inputs.collectorMethods, before.inputs.collectorMethods);
  for (const [field, key] of [
    ["collectorSources", "EXPORT/artifact"],
    ["collectorMethods", "EXPORT/collect.mjs"],
  ] as const) {
    for (const corruption of [
      "missing map",
      "missing entry",
      "invalid hash",
      "missing bytes",
      "negative bytes",
    ]) {
      const damaged = structuredClone(before);
      const entries = damaged.inputs[field]!;
      if (corruption === "missing map") delete damaged.inputs[field];
      else if (corruption === "missing entry") delete entries[key];
      else if (corruption === "invalid hash")
        requireDefined(entries[key], "entries[key]").sha256 = "not-a-hash";
      else if (corruption === "missing bytes")
        Reflect.deleteProperty(requireDefined(entries[key], "entries[key]"), "bytes");
      else requireDefined(entries[key], "entries[key]").bytes = -1;
      assert.throws(
        () => buildRunReceipt({ ...value, evidenceProvenance: damaged }),
        /Saved collector .* provenance is missing or invalid.*offline rescore cannot reconstruct provenance/,
        `${field}: ${corruption}`,
      );
    }
  }
});

test("collector declarations skip non-collectors but never substitute empty required fields", async (t) => {
  const value = await fixture(t);
  const scenario = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  );
  const collect = scenario.collect!;
  delete scenario.collect;
  scenario.kind = "workspace";
  assert.deepEqual(collectorInputDefinitions(value.specs), {});
  assert.deepEqual(collectorInputDefinitions(value.specs, "all", undefined, "methods"), {});
  scenario.kind = "command";
  scenario.collect = { ...collect, methodFiles: [] };
  assert.deepEqual(collectorInputDefinitions(value.specs, "all", undefined, "methods"), {});
  Reflect.deleteProperty(scenario.collect, "methodFiles");
  assert.throws(() => collectorInputDefinitions(value.specs, "all", undefined, "methods"));
  scenario.collect = { ...collect };
  Reflect.deleteProperty(scenario.collect, "sources");
  assert.throws(() => collectorInputDefinitions(value.specs));
});

test("offline collector provenance requirements follow split and scenario selection", async (t) => {
  const value = await fixture(t);
  requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  ).cases = [
    { id: "dev", split: "development", variables: {}, strata: [] },
    { id: "eval", split: "evaluation", variables: {}, strata: [] },
  ];
  const options = { ...value, split: "development" as const, scenarioIds: ["EXPORT--dev"] };
  const before = buildRunReceipt(options);
  fs.unlinkSync(path.join(value.root, "source.png"));
  fs.unlinkSync(path.join(value.root, "collect.mjs"));
  assert.doesNotThrow(() => buildRunReceipt({ ...options, evidenceProvenance: before }));
  delete before.inputs.collectorSources!["EXPORT--dev/artifact"];
  assert.throws(
    () => buildRunReceipt({ ...options, evidenceProvenance: before }),
    /EXPORT--dev\/artifact/,
  );
});
