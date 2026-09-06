import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { judgeArea } from "../src/graders.js";
import type { EvalConfig, EvalSpec, RubricItem, ScenarioEvidence } from "../src/types.js";

function command(code: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

test("zero-share hybrids do not invoke the automatic judge or create case results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-manual-only-judge-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Manual only", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    // If this were invoked, the nonexistent executable would make the test fail.
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Manual only",
    scenarios: [],
    sourceFile: path.join(root, "unused.yaml"),
    rubric: [
      {
        id: "H0",
        criterion: "Human check",
        weight: 1,
        tags: [],
        scenarios: [],
        grader: { type: "hybrid", autoShare: 0 },
        passCriteria: "A human confirms it",
        manualInstructions: "Confirm it",
      },
    ],
  };
  const result = await judgeArea({
    commands: { mode: "execute" },
    config,
    spec,
    evidence: [],
    runDir: root,
    areaDirectory: path.join(root, "area"),
  });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.cases, []);
  assert.equal(fs.existsSync(path.join(root, "area", "_judge")), false);
});

test("judge provider launch failures propagate instead of becoming cannot_judge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-launch-"));
  const bin = path.join(root, "empty-bin");
  fs.mkdirSync(bin);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Judge launch", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Judge launch",
    scenarios: [],
    sourceFile: path.join(root, "unused.yaml"),
    rubric: [
      {
        id: "LLM",
        criterion: "Works",
        weight: 1,
        tags: [],
        scenarios: [],
        grader: { type: "llm" },
        passCriteria: "Works",
      },
    ],
  };
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [],
        runDir: root,
        areaDirectory: path.join(root, "area"),
      }),
      /spawn claude ENOENT/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("command graders enforce explicit output contracts and fail on execution errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-graders-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Graders", root },
    target: { kind: "command", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const optimistic =
    "console.log(JSON.stringify({verdict:'pass',reasoning:'optimistic',evidenceRefs:[]}))";
  const items: RubricItem[] = [
    {
      id: "TIMEOUT",
      criterion: "Must finish",
      weight: 1,
      tags: [],
      scenarios: [],
      grader: {
        type: "command",
        methodFiles: [],
        output: "exit-code",
        command: command(`${optimistic};setInterval(function(){},1000)`),
        timeoutSeconds: 0.05,
      },
      passCriteria: "The command exits successfully.",
    },
    {
      id: "NONZERO",
      criterion: "Must exit zero",
      weight: 1,
      tags: [],
      scenarios: [],
      grader: {
        type: "command",
        methodFiles: [],
        output: "exit-code",
        command: command(`${optimistic};process.exit(1)`),
      },
      passCriteria: "The command exits successfully.",
    },
  ];
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Command status",
    scenarios: [],
    rubric: items,
    sourceFile: path.join(root, "unused.yaml"),
  };

  const grade = (item: RubricItem) =>
    judgeArea({
      commands: { mode: "execute" },
      config,
      spec: { ...spec, rubric: [item] },
      evidence: [],
      runDir: root,
      areaDirectory: path.join(root, "area"),
    });
  await assert.rejects(grade(requireDefined(items[0], "items[0]")), /timed out/);
  assert.equal(
    requireDefined(
      (await grade(requireDefined(items[1], "items[1]"))).items[0],
      "(await grade(items[1])).items[0]",
    ).verdict,
    "fail",
  );
  for (const [exit, verdict] of [
    "pass",
    "fail",
    "partial",
    "cannot_judge",
    "not_found",
  ].entries()) {
    const result = await grade({
      ...requireDefined(items[1], "items[1]"),
      grader: {
        type: "command",
        methodFiles: [],
        output: "exit-code",
        command: command(`process.exit(${exit})`),
      },
    });
    assert.equal(requireDefined(result.items[0], "result.items[0]").verdict, verdict);
  }
  for (const [code, expected] of [
    [
      'console.log(JSON.stringify({verdict:"faill",reasoning:"broken output"}))',
      /invalid structured output/,
    ],
    ['console.log("{broken")', /exact JSON object/],
    [
      'console.log(String.fromCharCode(96).repeat(3)+"json\\n{}\\n"+String.fromCharCode(96).repeat(3))',
      /exact JSON object/,
    ],
    [`${optimistic};process.exit(1)`, /JSON grader exited 1/],
    [
      'console.log(JSON.stringify({verdict:"pass",reasoning:"ok",unexpected:true}))',
      /invalid structured output/,
    ],
  ] as const) {
    await assert.rejects(
      grade({
        ...requireDefined(items[1], "items[1]"),
        grader: { type: "command", methodFiles: [], output: "json", command: command(code) },
      }),
      expected,
    );
  }
  const json = await grade({
    ...requireDefined(items[1], "items[1]"),
    grader: {
      type: "command",
      methodFiles: [],
      output: "json",
      command: command('console.log(JSON.stringify({verdict:"fail",reasoning:"Real defect"}))'),
    },
  });
  assert.equal(requireDefined(json.items[0], "json.items[0]").verdict, "fail");
  await assert.rejects(
    grade({
      ...requireDefined(items[1], "items[1]"),
      grader: {
        type: "command",
        methodFiles: [],
        output: "exit-code",
        command: command("process.exit(127)"),
      },
    }),
    /unexpected exit code 127/,
  );
  assert.ok(fs.existsSync(path.join(root, "area", "graders", "TIMEOUT.stdout.txt")));
});

test("judge policy violations abort while retaining diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-policy-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const fakeCodex = path.join(bin, "codex");
  const structured = {
    items: [
      {
        id: "LLM",
        verdict: "pass",
        confidence: "high",
        reasoning: "Used forbidden access",
        evidenceRefs: ["S1/evidence.json"],
      },
    ],
    cases: [
      {
        rubricId: "LLM",
        caseId: "default",
        verdict: "pass",
        confidence: "high",
        reasoning: "Used forbidden access",
        evidenceRefs: ["S1/evidence.json"],
      },
    ],
    defects: [],
    notes: "",
  };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"StructuredOutput"},{type:"tool_use",name:"Read"}]}}));
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"pwd"}}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(JSON.stringify(structured))}}}));
fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(structured))});
`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const screenshot = path.join(root, "S1", "screenshots", "result.jpg");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  fs.writeFileSync(screenshot, "not-a-real-jpeg-but-readable");
  const config: EvalConfig = {
    version: 1,
    project: { name: "Policy", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Policy",
    sourceFile: path.join(root, "unused.yaml"),
    scenarios: [],
    rubric: [
      {
        id: "LLM",
        criterion: "Must stay bounded",
        weight: 1,
        tags: [],
        scenarios: ["S1"],
        grader: { type: "llm" },
        passCriteria: "Works",
      },
    ],
  };
  const evidence: ScenarioEvidence = {
    scenarioId: "S1",
    scenarioName: "Inspect",
    kind: "workspace",
    outcome: "completed",
    summary: "Done",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [{ path: "screenshots/result.jpg", label: "Result", step: 1 }],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1_000,
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    await assert.rejects(
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [evidence],
        runDir: root,
        areaDirectory: path.join(root, "area"),
      }),
      /evidence-boundary violation.*Read/,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, "area", "_judge", "provider-run.json"), "utf8"))
        .policyViolations,
      ["Read"],
    );

    await assert.rejects(
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [{ ...evidence, screenshots: [] }],
        runDir: root,
        areaDirectory: path.join(root, "area-no-mcp"),
      }),
      /evidence-boundary violation.*Read/,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(root, "area-no-mcp", "_judge", "provider-run.json"), "utf8"),
      ).policyViolations,
      ["Read"],
    );

    const codexConfig: EvalConfig = { ...config, judge: { ...config.judge, provider: "codex" } };
    await assert.rejects(
      judgeArea({
        commands: { mode: "execute" },
        config: codexConfig,
        spec,
        evidence: [evidence],
        runDir: root,
        areaDirectory: path.join(root, "area-codex"),
      }),
      /evidence-boundary violation.*command_execution/,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(root, "area-codex", "_judge", "provider-run.json"), "utf8"),
      ).policyViolations,
      ["command_execution"],
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("aggregate LLM judgements can cite only their rubric's scenarios", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-rubric-evidence-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    items: [
      {
        id: "SCOPED",
        verdict: "pass",
        confidence: "high",
        reasoning: "Wrong scenario",
        evidenceRefs: ["S2/evidence.json"],
      },
      {
        id: "VALID",
        verdict: "pass",
        confidence: "high",
        reasoning: "Right scenario",
        evidenceRefs: ["S1/evidence.json"],
      },
      {
        id: "AREA_WIDE",
        verdict: "pass",
        confidence: "high",
        reasoning: "No scenario restriction",
        evidenceRefs: ["S2/evidence.json"],
      },
    ],
    cases: [
      {
        rubricId: "SCOPED",
        caseId: "default",
        verdict: "pass",
        confidence: "high",
        reasoning: "Wrong scenario",
        evidenceRefs: ["S2/evidence.json"],
      },
      {
        rubricId: "VALID",
        caseId: "default",
        verdict: "pass",
        confidence: "high",
        reasoning: "Right scenario",
        evidenceRefs: ["S1/evidence.json"],
      },
    ],
    defects: [
      { severity: "major", description: "Reached defect", evidenceRefs: ["S1/evidence.json"] },
      { severity: "major", description: "Blocked-only claim", evidenceRefs: ["S3/evidence.json"] },
      {
        severity: "minor",
        description: "Mixed claim",
        evidenceRefs: ["S1/evidence.json", "S3/evidence.json"],
      },
    ],
    notes: "",
  };
  const emit = () =>
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"StructuredOutput"}]}}));
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
    );
  emit();
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Rubric evidence", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const rubric = (id: string, scenarios: string[]): RubricItem => ({
    id,
    criterion: id,
    weight: 1,
    tags: [],
    scenarios,
    grader: { type: "llm" },
    passCriteria: "Works",
  });
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Scope",
    sourceFile: path.join(root, "unused.yaml"),
    scenarios: [],
    rubric: [rubric("SCOPED", ["S1"]), rubric("VALID", ["S1"]), rubric("AREA_WIDE", [])],
  };
  const scenarioEvidence = (
    scenarioId: string,
    outcome: ScenarioEvidence["outcome"] = "completed",
  ): ScenarioEvidence => ({
    scenarioId,
    scenarioName: scenarioId,
    kind: "workspace",
    outcome,
    summary: "Done",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1_000,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const grade = () =>
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [
          scenarioEvidence("S1"),
          scenarioEvidence("S2"),
          scenarioEvidence("S3", "blocked"),
        ],
        runDir: root,
        areaDirectory: path.join(root, "area"),
      });
    await assert.rejects(grade(), /rubric item SCOPED.*S2\/evidence.json/);
    requireDefined(structured.items[0], "structured.items[0]").evidenceRefs = ["S1/evidence.json"];
    requireDefined(structured.cases[0], "structured.cases[0]").evidenceRefs = ["S1/evidence.json"];
    emit();
    await assert.rejects(grade(), /defect 2.*S3\/evidence.json/);
    structured.defects.splice(1, 1);
    emit();
    await assert.rejects(grade(), /defect 2.*S3\/evidence.json/);
    requireDefined(structured.defects[1], "structured.defects[1]").evidenceRefs = [
      "S1/evidence.json",
    ];
    emit();
    const result = await grade();
    assert.ok(result.items.every((item) => item.verdict === "pass"));
    assert.deepEqual(result.items.find((item) => item.id === "AREA_WIDE")?.evidenceRefs, [
      "S2/evidence.json",
    ]);
    assert.deepEqual(result.defects, structured.defects);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("case judgements cannot cite evidence from another matrix case", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-case-evidence-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    items: [
      {
        id: "LLM",
        verdict: "pass",
        confidence: "high",
        reasoning: "Aggregate",
        evidenceRefs: ["S--a/evidence.json"],
      },
    ],
    cases: [
      {
        rubricId: "LLM",
        caseId: "a",
        verdict: "pass",
        confidence: "high",
        reasoning: "Case A",
        evidenceRefs: ["S--b/evidence.json"],
      },
      {
        rubricId: "LLM",
        caseId: "b",
        verdict: "pass",
        confidence: "high",
        reasoning: "Case B",
        evidenceRefs: ["S--b/evidence.json"],
      },
      {
        rubricId: "LLM",
        caseId: "c",
        verdict: "pass",
        confidence: "high",
        reasoning: "Case C",
        evidenceRefs: ["SHARED/evidence.json"],
      },
    ],
    defects: [],
    notes: "",
  };
  const emit = () =>
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
    );
  emit();
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Case evidence", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Case isolation",
    sourceFile: path.join(root, "unused.yaml"),
    scenarios: [],
    rubric: [
      {
        id: "LLM",
        criterion: "Each case works",
        weight: 1,
        tags: [],
        scenarios: ["SHARED", "S--a", "S--b", "S--c"],
        grader: { type: "llm" },
        passCriteria: "Works",
      },
    ],
  };
  const evidence = (
    scenarioId: string,
    caseId: string,
    outcome: ScenarioEvidence["outcome"] = "completed",
  ): ScenarioEvidence => ({
    scenarioId,
    caseId,
    sourceScenarioId: "S",
    scenarioName: caseId,
    kind: "workspace",
    outcome,
    summary: "Done",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1_000,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const shared: ScenarioEvidence = {
      scenarioId: "SHARED",
      scenarioName: "Shared setup",
      kind: "workspace",
      outcome: "completed",
      summary: "Done",
      observations: [],
      evidenceRefs: [],
      transcript: [],
      screenshots: [],
      artifacts: {},
      provider: "mock",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      durationMs: 1_000,
    };
    const grade = () =>
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [
          shared,
          evidence("S--a", "a"),
          evidence("S--b", "b"),
          evidence("S--c", "c", "blocked"),
        ],
        runDir: root,
        areaDirectory: path.join(root, "area"),
      });
    await assert.rejects(grade(), /case LLM\/a.*S--b\/evidence.json/);
    requireDefined(structured.cases[0], "structured.cases[0]").evidenceRefs = [
      "S--a/evidence.json",
    ];
    emit();
    const result = await grade();
    assert.equal(result.cases.find((item) => item.caseId === "a")?.verdict, "pass");
    assert.equal(result.cases.find((item) => item.caseId === "b")?.verdict, "pass");
    assert.deepEqual(result.cases.find((item) => item.caseId === "b")?.evidenceRefs, [
      "S--b/evidence.json",
    ]);
    assert.equal(result.cases.find((item) => item.caseId === "c")?.verdict, "cannot_judge");
    assert.match(
      result.cases.find((item) => item.caseId === "c")?.reasoning ?? "",
      /case-specific scenario evidence were not reached/,
    );
    assert.deepEqual(result.cases.find((item) => item.caseId === "c")?.evidenceRefs, []);
    assert.equal(requireDefined(result.items[0], "result.items[0]").verdict, "cannot_judge");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate judge rubric and case identities invalidate the judgement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-judge-duplicate-identities-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const item = {
    id: "LLM",
    verdict: "pass",
    confidence: "high",
    reasoning: "Claimed pass",
    evidenceRefs: ["S--a/evidence.json"],
  };
  const judgedCase = {
    rubricId: "LLM",
    caseId: "a",
    verdict: "pass",
    confidence: "high",
    reasoning: "Claimed case pass",
    evidenceRefs: ["S--a/evidence.json"],
  };
  const structured = {
    items: [item, { ...item, verdict: "fail", reasoning: "Conflicting fail" }],
    cases: [judgedCase, { ...judgedCase, verdict: "fail", reasoning: "Conflicting case fail" }],
    defects: [],
    notes: "",
  };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Duplicate judge identities", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Duplicate identities",
    sourceFile: path.join(root, "unused.yaml"),
    scenarios: [],
    rubric: [
      {
        id: "LLM",
        criterion: "Works",
        weight: 1,
        tags: [],
        scenarios: ["S--a"],
        grader: { type: "llm" },
        passCriteria: "Works",
      },
    ],
  };
  const evidence: ScenarioEvidence = {
    scenarioId: "S--a",
    sourceScenarioId: "S",
    scenarioName: "Case A",
    caseId: "a",
    kind: "workspace",
    outcome: "completed",
    summary: "Done",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1_000,
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    await assert.rejects(
      judgeArea({
        commands: { mode: "execute" },
        config,
        spec,
        evidence: [evidence],
        runDir: root,
        areaDirectory: path.join(root, "area"),
      }),
      /duplicate rubric item IDs \(LLM\).*duplicate case identities \(LLM\/a\)/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
