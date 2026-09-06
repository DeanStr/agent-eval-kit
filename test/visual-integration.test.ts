import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecs } from "../src/specs.js";
import { runEvaluation } from "../src/runner.js";
import { verifyArtifactIndex } from "../src/integrity.js";
import { promoteBaseline, loadPromotedBaseline } from "../src/baselines.js";
import { loadComparisonInput } from "../src/compare.js";
import { visualInputs } from "../src/visual/inputs.js";
import { startLifecycle } from "../src/lifecycle.js";
import { controlledCapture } from "../src/visual/capture.js";
import { withCancellation } from "../src/cancellation.js";
import { BrowserSession } from "../src/browser/session.js";
import { readDiagnostics } from "../src/browser/diagnostics.js";
import {
  captureSchema,
  distinctnessSchema,
  imageRegressionSchema,
} from "../src/visual/contracts.js";

const html = `<!doctype html><style>body{margin:0;background:white}#bar{width:30px;height:30px;background:#2475c8;position:absolute;top:20px;left:20px}</style><div id="bar"></div><script>
let position = 20, count = 0;
window.__AEK_EVAL__ = {
reset(){position=20;count=0;document.querySelector('#bar').style.left=position+'px'},
setSeed(seed){if(seed!==1337)throw Error('unexpected seed')},configure(settings){window.settings=settings;if(settings.offset){position+=settings.offset;document.querySelector('#bar').style.left=position+'px'}if(settings.subtle)document.body.style.background='rgb(100,100,100)'},
waitUntilStable(){if(window.settings?.hang)return new Promise(()=>{})},
advance(seconds){count++;if(window.settings?.subtle){const c=100+count;document.body.style.background='rgb('+c+','+c+','+c+')';return}position+=seconds*10;document.querySelector('#bar').style.left=position+'px'},
getMetrics(){return {errors:window.settings?.broken?count:0}}
};</script>`;

async function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-visual-integration-"));
  const project = path.join(root, "project"),
    bin = path.join(root, "bin");
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const counter = path.join(root, "counter"),
    fail = path.join(root, "fail");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex fixture 1');process.exit(0)}
const count=Number(fs.existsSync(${JSON.stringify(counter)})?fs.readFileSync(${JSON.stringify(counter)},'utf8'):0)+1;
fs.writeFileSync(${JSON.stringify(counter)},String(count));
if(count===2&&fs.existsSync(${JSON.stringify(fail)})){process.exit(19)}
const result={preferred:'equivalent',confidence:0.95,reasoning:'The supplied panels are equivalent in this test fixture.',findings:[]};
const text=JSON.stringify(result);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
`,
    { mode: 0o755 },
  );
  await sharp({ create: { width: 160, height: 100, channels: 3, background: "#ffffff" } })
    .png()
    .toFile(path.join(project, "reference.png"));
  const configFile = path.join(project, "evalkit.yaml"),
    specFile = path.join(project, "spec.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Visual fixture" },
      target: { kind: "web", url },
      agent: { provider: "mock" },
      judge: { provider: "codex", timeoutSeconds: 10 },
      paths: { specs: "spec.yaml" },
      browser: { viewport: { width: 160, height: 100 } },
    }),
  );
  fs.writeFileSync(
    specFile,
    YAML.stringify({
      id: "visual",
      title: "Visual",
      weight: 100,
      description: "Visual checks",
      scenarios: [
        {
          id: "SCENE",
          name: "Controlled scene",
          instructions: "Collect stable frames",
          capture: { frames: 2, minimumMovement: 0.001, metrics: { errors: { max: 0 } } },
        },
      ],
      rubric: [
        {
          id: "CHECKS",
          criterion: "Deterministic behavior",
          weight: 1,
          scenarios: ["SCENE"],
          grader: { type: "capture" },
          gate: true,
          passCriteria: "All checks pass",
        },
        {
          id: "VISUAL",
          criterion: "Readable design",
          weight: 1,
          scenarios: ["SCENE"],
          grader: {
            type: "pairwise",
            candidate: "frame-001",
            policy: "non_regression",
            references: [{ file: "reference.png" }],
            panel: { width: 160, height: 100 },
            voting: { minimumVotes: 2, maximumVotes: 3 },
          },
          gate: true,
          passCriteria: "The presentation is clear",
        },
      ],
    }),
  );
  t.after(async () => {
    process.env.PATH = previousPath;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    configFile,
    specFile,
    counter,
    fail,
    config: loadConfig(configFile),
    specs: loadSpecs(specFile),
  };
}

test("controlled collection, blind votes, interrupted resume and image baselines share sealed run artifacts", async (t) => {
  const value = await fixture(t);
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  };
  fs.writeFileSync(value.fail, "fail once");
  await assert.rejects(runEvaluation(options), /Pairwise judge execution failed/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const evidenceFile = path.join(runDir, "SCENE/evidence.json");
  const collected = fs.readFileSync(evidenceFile, "utf8");
  const voteFile = path.join(runDir, "areas/visual/pairwise/VISUAL/SCENE/1/vote-01/vote.json");
  const firstVote = fs.readFileSync(voteFile, "utf8");
  fs.rmSync(value.fail);
  const resumed = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(
    Number(fs.readFileSync(value.counter, "utf8")),
    3,
    "resume must reuse the first vote",
  );
  assert.equal(
    fs.readFileSync(evidenceFile, "utf8"),
    collected,
    "resume must reuse captured pixels",
  );
  assert.equal(fs.readFileSync(voteFile, "utf8"), firstVote);
  assert.equal(resumed.report?.overallScorePct, 100);
  assert.equal(resumed.report?.overallCoveragePct, 100);
  assert.equal(resumed.report?.gates.passed, true);
  const scenario = requireDefined(
    requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").scenarios[0],
    "resumed.report!.areas[0].scenarios[0]",
  );
  assert.equal(scenario.collector, "controlled");
  assert.ok(scenario.captureChecks!.every((check) => check.pass));
  assert.ok(scenario.screenshots.every((shot) => shot.path.endsWith(".png")));
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);
  assert.equal(
    requireDefined(
      requireDefined(
        loadComparisonInput(runDir).report.areas[0],
        "loadComparisonInput(runDir).report.areas[0]",
      ).items[1],
      "loadComparisonInput(runDir).report.areas[0].items[1]",
    ).votes?.attempted,
    2,
  );
  const promoted = promoteBaseline({
    config: value.config,
    runDir,
    name: "visual",
    reviewer: "fixture",
    includeImages: true,
  });
  assert.ok(
    Object.values(promoted.promotion.images!).some(
      (image) => image.scenario === "SCENE" && image.label === "frame-001",
    ),
  );
  const pairwise = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").rubric[1],
    "value.specs[0].rubric[1]",
  ).grader;
  assert.equal(pairwise.type, "pairwise");
  if (pairwise.type !== "pairwise") return;
  pairwise.references = [{ baseline: "visual", label: "frame-001" }];
  assert.ok(visualInputs(value.config, value.specs)["VISUAL/SCENE/0"]);
  const image = requireDefined(
    Object.values(promoted.promotion.images!)[0],
    "Object.values(promoted.promotion.images!)[0]",
  );
  fs.writeFileSync(path.join(promoted.directory, image.file), "changed");
  assert.throws(() => loadPromotedBaseline(value.config, "visual"), /image checksum changed/);
});

test("named checkpoints replay irregular adapter times across independent browser passes", async (t) => {
  const value = await fixture(t);
  const scenario = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  );
  const checkpoints = [
    { label: "before", timeSeconds: 0.5 },
    { label: "at", timeSeconds: 1 },
    { label: "after", timeSeconds: 1.25 },
  ];
  scenario.capture = captureSchema.parse({ checkpoints });
  const directory = path.join(value.root, "named-capture");
  const evidence = await controlledCapture(value.config, scenario, directory);
  assert.equal(evidence.outcome, "completed");
  assert.deepEqual(
    evidence.transcript
      .filter((entry) => entry.tool === "adapter.advance")
      .map((entry) => entry.input.value),
    [0.5, 0.5, 0.25, 0.5, 0.5, 0.25],
  );
  assert.deepEqual(
    evidence.screenshots
      .filter((shot) => !shot.label.includes("contact-sheet"))
      .map((shot) => [shot.label, shot.timeSeconds]),
    [
      ["before", 0.5],
      ["at", 1],
      ["after", 1.25],
      ["pass-02/before", 0.5],
      ["pass-02/at", 1],
      ["pass-02/after", 1.25],
    ],
  );
  assert.ok(evidence.captureChecks!.every((check) => check.pass));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, "capture.json"), "utf8")).schedule,
    checkpoints,
  );
  const pairwise = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").rubric[1],
    "value.specs[0].rubric[1]",
  ).grader;
  if (pairwise.type !== "pairwise") throw new Error("Expected pairwise fixture");
  pairwise.candidate = "after";
  const { validateVisualInputs } = await import("../src/visual/inputs.js");
  await validateVisualInputs(value.config, value.specs);
  pairwise.candidate = "frame-001";
  await assert.rejects(
    validateVisualInputs(value.config, value.specs),
    /invalid controlled screenshot label/,
  );
});

test("instrumented behavior failures are scores; adapter failures and interrupted captures are execution errors", async (t) => {
  const value = await fixture(t);
  const scenario = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  );
  const broken = await controlledCapture(
    value.config,
    { ...scenario, capture: { ...scenario.capture!, setup: { broken: true } } },
    path.join(value.root, "broken"),
  );
  assert.equal(broken.outcome, "completed");
  assert.ok(broken.captureChecks!.some((check) => !check.pass));
  await assert.rejects(
    controlledCapture(
      value.config,
      { ...scenario, capture: { ...scenario.capture!, metrics: { absent: { max: 0 } } } },
      path.join(value.root, "missing"),
    ),
    /missing or non-numeric/,
  );
  const partial = JSON.parse(
    fs.readFileSync(path.join(value.root, "missing/capture.json"), "utf8"),
  );
  assert.equal(partial.passes.length, 1);
  assert.equal(
    partial.passes[0].frames.length,
    1,
    "retain the frame and its measured image statistics when a later adapter call fails",
  );
  assert.equal(partial.passes[0].images.length, 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test cancellation")), 1200);
  try {
    await assert.rejects(
      withCancellation(controller.signal, () =>
        controlledCapture(
          value.config,
          { ...scenario, capture: { ...scenario.capture!, setup: { hang: true } } },
          path.join(value.root, "cancelled"),
        ),
      ),
      /test cancellation/,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(value.root, "cancelled/evidence.json"), "utf8")).outcome,
    "agent_error",
  );
});

test("browser diagnostic gates stay unavailable when a mock collector never starts a browser", async (t) => {
  const value = await fixture(t);
  delete requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
    "value.specs[0].scenarios[0]",
  ).capture;
  requireDefined(value.specs[0], "value.specs[0]").rubric = [
    requireDefined(
      requireDefined(value.specs[0], "value.specs[0]").rubric[0],
      "value.specs[0].rubric[0]",
    ),
  ];
  value.config.judge.provider = "mock";
  value.config.browser.diagnostics = { failOn: ["console", "http"], ignoreUrls: [] };
  const result = await runEvaluation({
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  });
  assert.equal(
    requireDefined(
      requireDefined(result.report!.areas[0], "result.report!.areas[0]").items[0],
      "result.report!.areas[0].items[0]",
    ).verdict,
    "cannot_judge",
  );
  assert.equal(result.report!.overallCoveragePct, 0);
  assert.equal(result.report!.gates.passed, false);
});

test("invalid controlled labels fail before run creation or provider execution", async (t) => {
  const value = await fixture(t);
  const grader = requireDefined(
    requireDefined(value.specs[0], "value.specs[0]").rubric[1],
    "value.specs[0].rubric[1]",
  ).grader;
  if (grader.type !== "pairwise") throw new Error("Expected pairwise grader");
  grader.candidate = "frame-999";
  await assert.rejects(
    runEvaluation({
      config: value.config,
      configFile: value.configFile,
      specs: value.specs,
      fixtures: {},
    }),
    /invalid controlled screenshot label frame-999/,
  );
  assert.equal(fs.existsSync(value.config.paths.runs), false);
  assert.equal(fs.existsSync(value.counter), false);
});

test("missing pairwise image views abort without recording a vote; explicit abstention remains resumable", async (t) => {
  const value = await fixture(t);
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(value.root, "empty-claude-config");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  t.after(() => {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  });
  value.config.judge.provider = "claude";
  fs.writeFileSync(value.fail, "return an uninspected decision");
  fs.writeFileSync(
    path.join(value.root, "bin/claude"),
    `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('claude fixture 1');process.exit(0)}
const n=Number(fs.existsSync(${JSON.stringify(value.counter)})?fs.readFileSync(${JSON.stringify(value.counter)},'utf8'):0)+1;
fs.writeFileSync(${JSON.stringify(value.counter)},String(n));
const result={preferred:fs.existsSync(${JSON.stringify(value.fail)})?'equivalent':'abstain',confidence:0.1,reasoning:'Fixture judge did not inspect the images.',findings:[]};
console.log(JSON.stringify({type:'result',structured_output:result,result:JSON.stringify(result)}));
`,
    { mode: 0o755 },
  );
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  };
  await assert.rejects(runEvaluation(options), /Pairwise judge contract violation/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const voteDir = path.join(runDir, "areas/visual/pairwise/VISUAL/SCENE/1/vote-01");
  assert.equal(fs.existsSync(path.join(voteDir, "vote.json")), false);
  assert.equal(
    fs.existsSync(path.join(voteDir, "provider-run.json")),
    true,
    "retain failed provider diagnostics",
  );
  assert.equal(Number(fs.readFileSync(value.counter, "utf8")), 1);
  const captured = fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8");
  fs.rmSync(value.fail);
  const resumed = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8"), captured);
  assert.equal(
    requireDefined(
      requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").items[1],
      "resumed.report!.areas[0].items[1]",
    ).verdict,
    "cannot_judge",
  );
  assert.equal(
    requireDefined(
      requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").items[1],
      "resumed.report!.areas[0].items[1]",
    ).votes!.attempted,
    3,
  );
  assert.equal(
    requireDefined(
      requireDefined(resumed.report!.areas[0], "resumed.report!.areas[0]").items[1],
      "resumed.report!.areas[0].items[1]",
    ).votes!.judgeable,
    0,
  );
  assert.equal(Number(fs.readFileSync(value.counter, "utf8")), 4);
});

test("resume rejects changed completed votes instead of silently deleting and replacing them", async (t) => {
  const value = await fixture(t);
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  };
  fs.writeFileSync(value.fail, "fail once");
  await assert.rejects(runEvaluation(options), /Pairwise judge execution failed/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const voteDir = path.join(runDir, "areas/visual/pairwise/VISUAL/SCENE/1/vote-01");
  for (const name of ["vote.json", "attachments/A.png"]) {
    const file = path.join(voteDir, name),
      original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, "changed");
      await assert.rejects(
        runEvaluation({ ...options, resumeDir: runDir }),
        /Completed vote artifact changed/,
      );
      assert.equal(
        fs.readFileSync(file, "utf8"),
        "changed",
        "retain corrupt artifacts for investigation",
      );
      assert.equal(
        Number(fs.readFileSync(value.counter, "utf8")),
        2,
        "do not invoke a replacement judge",
      );
    } finally {
      fs.writeFileSync(file, original);
    }
  }
  fs.rmSync(value.fail);
  const resumed = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(resumed.report!.overallScorePct, 100);
  assert.equal(Number(fs.readFileSync(value.counter, "utf8")), 3);
});

test("controlled movement ignores configured pixel noise and image-health failures remain observed checks", async (t) => {
  const value = await fixture(t),
    scenario = requireDefined(
      requireDefined(value.specs[0], "value.specs[0]").scenarios[0],
      "value.specs[0].scenarios[0]",
    );
  const capture = captureSchema.parse({
    frames: 2,
    setup: { subtle: true },
    channelTolerance: 0,
    movementChannelTolerance: 2,
    minimumMovement: 0.5,
  });
  const noisy = await controlledCapture(
    value.config,
    { ...scenario, capture },
    path.join(value.root, "noise"),
  );
  assert.equal(noisy.outcome, "completed");
  assert.ok(
    noisy
      .captureChecks!.filter((check) => check.name.endsWith("repeatability"))
      .every((check) => check.pass),
  );
  assert.ok(
    noisy
      .captureChecks!.filter((check) => check.name.endsWith("minimumMovement"))
      .every((check) => !check.pass),
  );
  const sensitive = await controlledCapture(
    value.config,
    { ...scenario, capture: { ...capture, movementChannelTolerance: 0 } },
    path.join(value.root, "sensitive"),
  );
  assert.ok(
    sensitive.captureChecks!.every((check) => check.pass),
    "strict temporal comparison sees the one-level background change",
  );
  const health = await controlledCapture(
    value.config,
    {
      ...scenario,
      capture: captureSchema.parse({
        frames: 2,
        minimumEntropy: 8,
        movementCrop: { x: 0, y: 0.8, width: 1, height: 0.2 },
        rejectDuplicateFrames: true,
        imageHealth: { metrics: { highlightPixelFraction: { max: 0.5 } } },
      }),
    },
    path.join(value.root, "health"),
  );
  assert.equal(health.outcome, "completed");
  for (const name of [
    "minimumEntropy",
    "distinctTemporalFrame",
    "imageHealth/metric.highlightPixelFraction",
  ])
    assert.ok(health.captureChecks!.some((check) => check.name.endsWith(name) && !check.pass));
});

test("generic visual checks run without a model and baseline statistics use pinned promoted images", async (t) => {
  const value = await fixture(t);
  value.config.judge.provider = "mock";
  const spec = requireDefined(value.specs[0], "value.specs[0]");
  requireDefined(spec.scenarios[0], "spec.scenarios[0]").capture!.frames = 1;
  delete requireDefined(spec.scenarios[0], "spec.scenarios[0]").capture!.minimumMovement;
  spec.scenarios.push({
    ...requireDefined(spec.scenarios[0], "spec.scenarios[0]"),
    id: "OTHER",
    capture: {
      ...requireDefined(spec.scenarios[0], "spec.scenarios[0]").capture!,
      setup: { offset: 40 },
    },
  });
  spec.rubric = [requireDefined(spec.rubric[0], "spec.rubric[0]")];
  requireDefined(spec.rubric[0], "spec.rubric[0]").scenarios = ["SCENE", "OTHER"];
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  };
  const initial = await runEvaluation(options);
  assert.equal(initial.report?.overallScorePct, 100);
  const promoted = promoteBaseline({
    config: value.config,
    runDir: initial.runDir,
    name: "approved",
    reviewer: "fixture",
    includeImages: true,
  });
  spec.rubric.push({
    ...requireDefined(spec.rubric[0], "spec.rubric[0]"),
    id: "DISTINCT",
    grader: distinctnessSchema.parse({
      type: "image-distinctness",
      candidate: "frame-001",
      minimumDistance: 0.001,
    }),
  });
  spec.rubric.push({
    ...requireDefined(spec.rubric[0], "spec.rubric[0]"),
    id: "STATS",
    grader: imageRegressionSchema.parse({
      type: "image-regression",
      candidate: "frame-001",
      baseline: "approved",
      metrics: { entropy: { perScene: { min: -0.2 }, mean: { min: -0.08 } } },
    }),
  });
  const evaluated = await runEvaluation(options);
  assert.equal(evaluated.report?.overallCoveragePct, 100);
  assert.equal(evaluated.report?.overallScorePct, 100);
  assert.equal(evaluated.report?.gates.passed, true);
  assert.deepEqual(
    requireDefined(evaluated.report!.areas[0], "evaluated.report!.areas[0]").items.map(
      (item) => item.source,
    ),
    ["capture", "image-distinctness", "image-regression"],
  );
  assert.equal(verifyArtifactIndex(evaluated.runDir, { require: true }).ok, true);
  assert.equal(
    requireDefined(
      requireDefined(
        loadComparisonInput(evaluated.runDir).report.areas[0],
        "loadComparisonInput(evaluated.runDir).report.areas[0]",
      ).items[2],
      "loadComparisonInput(evaluated.runDir).report.areas[0].items[2]",
    ).verdict,
    "pass",
    "report schema accepts deterministic image sources",
  );
  assert.ok(evaluated.report!.receipt.inputs.visual?.["STATS/OTHER/0"]);
  const reportHtml = fs.readFileSync(path.join(evaluated.runDir, "report.html"), "utf8");
  assert.match(reportHtml, /image-distinctness\/DISTINCT\/comparison.html/);
  assert.match(reportHtml, /image-regression\/STATS\/comparison.html/);
  const snapshot = path.join(
    evaluated.runDir,
    "areas/visual/image-regression/STATS/diagnostics.json",
  );
  const diagnostic = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  assert.equal(diagnostic.axes.entropy.mean, 0);
  assert.equal(diagnostic.axes.entropy.expectedSamples, 2);
  assert.equal(fs.existsSync(value.counter), false, "no judge provider was called");
  const baselineImage = requireDefined(
    Object.values(promoted.promotion.images!)[0],
    "Object.values(promoted.promotion.images!)[0]",
  );
  fs.writeFileSync(path.join(promoted.directory, baselineImage.file), "tampered");
  await assert.rejects(runEvaluation(options), /image checksum changed/);
});

test("managed targets reject occupied endpoints and reuse them only when explicitly configured", async (t) => {
  const value = await fixture(t);
  value.config.target.start = { command: "exit 19" };
  await assert.rejects(
    startLifecycle(value.config, path.join(value.root, "lifecycle")),
    /already in use/,
  );
  value.config.target.allowExternalServer = true;
  const lifecycle = await startLifecycle(value.config, path.join(value.root, "lifecycle"));
  lifecycle.assertRunning();
  await lifecycle.stop();
});

test("repeated rubric judges reuse fixed scenario evidence and completed votes after interruption", async (t) => {
  const value = await fixture(t);
  const spec = requireDefined(value.specs[0], "value.specs[0]");
  delete requireDefined(spec.scenarios[0], "spec.scenarios[0]").capture;
  requireDefined(spec.scenarios[0], "spec.scenarios[0]").kind = "workspace";
  spec.rubric = [
    {
      id: "RUBRIC",
      criterion: "Source contract",
      weight: 1,
      tags: [],
      scenarios: ["SCENE"],
      grader: { type: "llm" },
      passCriteria: "The source meets its contract",
    },
  ];
  value.config.judge.voting = {
    minimumVotes: 2,
    maximumVotes: 3,
    agreement: 0.8,
    minimumConfidence: 0.55,
  };
  const output = {
    items: [
      {
        id: "RUBRIC",
        verdict: "pass",
        confidence: "high",
        reasoning: "Fixture judgement",
        evidenceRefs: ["SCENE/evidence.json"],
      },
    ],
    cases: [
      {
        rubricId: "RUBRIC",
        caseId: "default",
        verdict: "pass",
        confidence: "high",
        reasoning: "Fixture judgement",
        evidenceRefs: ["SCENE/evidence.json"],
      },
    ],
    defects: [],
    notes: "",
  };
  const executable = path.join(value.root, "bin", "codex");
  const fake = fs
    .readFileSync(executable, "utf8")
    .replace(
      "const result={preferred:'equivalent',confidence:0.95,reasoning:'The supplied panels are equivalent in this test fixture.',findings:[]};",
      `const result=${JSON.stringify(output)};`,
    );
  fs.writeFileSync(executable, fake);
  fs.writeFileSync(value.fail, "fail once");
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: [spec],
    fixtures: {},
  };
  await assert.rejects(runEvaluation(options), /Judge exited 19/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const collected = fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8");
  fs.rmSync(value.fail);
  const result = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(result.report?.overallScorePct, 100);
  assert.equal(
    requireDefined(
      requireDefined(result.report?.areas[0], "result.report?.areas[0]").items[0],
      "(result.report?.areas[0]).items[0]",
    ).votes?.attempted,
    2,
  );
  assert.equal(fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8"), collected);
  assert.equal(Number(fs.readFileSync(value.counter, "utf8")), 3);
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);
});

test("ordinary browser PNG capture preserves its format when clipping and retains diagnostic checks", async (t) => {
  const value = await fixture(t);
  const directory = path.join(value.root, "png");
  const session = new BrowserSession(
    directory,
    true,
    value.config.target.url!,
    undefined,
    value.config.target.allowedOrigins,
    { width: 160, height: 100 },
    1000,
    "same-origin",
    { lossless: true },
  );
  try {
    await session.start();
    await session.navigate(value.config.target.url!);
    await session.page.evaluate(() => {
      document.body.style.width = "3000px";
      console.error("fixture rendering error");
    });
    const shot = await session.screenshot("wide", true);
    const metadata = await sharp(Buffer.from(shot.base64, "base64")).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 1900);
    assert.match(shot.relPath, /\.png$/);
    const diagnostics = readDiagnostics(directory, { failOn: ["console"], ignoreUrls: [] });
    assert.ok(diagnostics.diagnostics.some((entry) => entry.message === "fixture rendering error"));
    assert.equal(requireDefined(diagnostics.checks[0], "diagnostics.checks[0]").pass, false);
  } finally {
    await session.stop();
  }
});

test("resumed mixed-grader areas require fresh ordinary image views and retain completed pairwise votes", async (t) => {
  const value = await fixture(t);
  value.config.judge.provider = "claude";
  const readable = {
    id: "READABLE",
    criterion: "Readable",
    weight: 1,
    tags: [],
    scenarios: ["SCENE"],
    grader: { type: "llm" as const },
    passCriteria: "Readable image",
  };
  requireDefined(value.specs[0], "value.specs[0]").rubric.unshift(readable);
  const ordinaryCount = path.join(value.root, "ordinary-count"),
    repair = path.join(value.root, "repair");
  fs.writeFileSync(value.fail, "fail second pair vote");
  fs.writeFileSync(
    path.join(value.root, "bin", "claude"),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('--version')){console.log('claude fixture 1');process.exit(0)}
const mcp=JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.evidence;
const context=JSON.parse(fs.readFileSync(mcp.args.at(-1),'utf8'));
const pair=Object.hasOwn(context.screenshots,'A');
const counter=pair?${JSON.stringify(value.counter)}:${JSON.stringify(ordinaryCount)};
const count=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;
fs.writeFileSync(counter,String(count));
if(pair&&count===2&&fs.existsSync(${JSON.stringify(value.fail)}))process.exit(19);
if(pair||count===1||fs.existsSync(${JSON.stringify(repair)})){
 for(const reference of Object.keys(context.screenshots))fs.appendFileSync(context.transcriptFile,JSON.stringify({at:new Date().toISOString(),tool:'view_screenshot',reference,result:'Viewed'})+'\\n');
}
const ref=Object.keys(context.screenshots)[0];
const judgement={verdict:'pass',confidence:'high',reasoning:'Readable',evidenceRefs:[ref]};
const result=pair?{preferred:'equivalent',confidence:0.95,reasoning:'Equivalent',findings:[]}:
 {items:[{id:'READABLE',...judgement}],cases:[{rubricId:'READABLE',caseId:'default',...judgement}],defects:[],notes:''};
console.log(JSON.stringify({type:'result',structured_output:result}));
`,
    { mode: 0o755 },
  );
  const options = {
    config: value.config,
    configFile: value.configFile,
    specs: value.specs,
    fixtures: {},
  };
  await assert.rejects(runEvaluation(options), /Pairwise judge execution failed/);
  const runDir = path.join(
    value.config.paths.runs,
    requireDefined(
      fs.readdirSync(value.config.paths.runs)[0],
      "fs.readdirSync(value.config.paths.runs)[0]",
    ),
  );
  const transcript = "areas/visual/_judge/evidence-transcript.ndjson";
  const index = JSON.parse(fs.readFileSync(path.join(runDir, "artifact-index.json"), "utf8"));
  assert.ok(
    index.entries.some((entry: { path: string }) => entry.path === transcript),
    "the old ordinary views were sealed by the first pair vote",
  );
  const voteFile = path.join(runDir, "areas/visual/pairwise/VISUAL/SCENE/1/vote-01/vote.json");
  const vote = fs.readFileSync(voteFile, "utf8");
  const evidence = fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8");
  fs.rmSync(value.fail);
  await assert.rejects(
    runEvaluation({ ...options, resumeDir: runDir }),
    /screenshot contract violation/,
  );
  fs.writeFileSync(repair, "view images on next attempt");
  const resumed = await runEvaluation({ ...options, resumeDir: runDir });
  assert.equal(
    requireDefined(resumed.report?.areas[0], "resumed.report?.areas[0]").items.find(
      (item) => item.id === "READABLE",
    )?.verdict,
    "pass",
  );
  assert.equal(fs.readFileSync(voteFile, "utf8"), vote);
  assert.equal(fs.readFileSync(path.join(runDir, "SCENE/evidence.json"), "utf8"), evidence);
  assert.equal(Number(fs.readFileSync(value.counter, "utf8")), 3, "reuse completed pair vote");
  assert.equal(verifyArtifactIndex(runDir, { require: true }).ok, true);
});
