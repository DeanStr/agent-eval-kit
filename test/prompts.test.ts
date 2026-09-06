import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import test from "node:test";
import { judgePrompt, scenarioPrompt } from "../src/prompts.js";
import type { EvalConfig, EvalSpec, ScenarioEvidence } from "../src/types.js";

test("repository scenario prompts expose the task but not evaluator rubric or absolute project path", () => {
  const config: EvalConfig = {
    version: 1,
    project: { name: "Demo", root: "/private/target/source" },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: "/private/evals", runs: "/tmp/runs", auth: "/tmp/auth" },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
    instructions: "Treat equivalent workflows as fully satisfying the criterion.",
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "",
    sourceFile: "/private/evals/core.yaml",
    scenarios: [],
    rubric: [
      {
        id: "SECRET-RUBRIC",
        criterion: "hidden evaluator judgment",
        weight: 1,
        tags: [],
        scenarios: [],
        grader: { type: "llm" },
        passCriteria: "hidden exact threshold",
      },
    ],
  };
  const prompt = scenarioPrompt({
    config,
    spec,
    kind: "workspace",
    fixtures: {},
    scenario: {
      id: "S1",
      name: "Inspect",
      kind: "workspace",
      instructions: "Find the public implementation.",
      successSignals: [],
      dependsOn: [],
      requiresAuth: false,
      sourceScenarioId: "S1",
      caseId: "reserved-case",
      caseVariables: { plan: "annual" },
      strata: ["plan=annual"],
      split: "evaluation",
    },
  });
  assert.match(prompt, /Find the public implementation/);
  assert.match(prompt, /read-only aek workspace MCP/);
  assert.doesNotMatch(prompt, /private\/target\/source/);
  assert.doesNotMatch(prompt, /SECRET-RUBRIC|hidden evaluator judgment|hidden exact threshold/);
  assert.match(prompt, /reserved-case|annual/);
  assert.match(prompt, /Treat equivalent workflows as fully satisfying the criterion/);
  assert.doesNotMatch(prompt, /DATA_SPLIT|CASE_STRATA|plan=annual/);

  requireDefined(spec.rubric[0], "spec.rubric[0]").grader = { type: "hybrid", autoShare: 0.9 };
  const evidence: ScenarioEvidence = {
    scenarioId: "S1",
    scenarioName: "Inspect",
    kind: "workspace",
    outcome: "completed",
    summary: "Inspected the public implementation.",
    observations: ["src/index.ts:1 contains the implementation."],
    evidenceRefs: ["src/index.ts:1"],
    transcript: [],
    screenshots: [{ path: "screenshots/result.jpg", label: "result", step: 1 }],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
  };
  const judgement = judgePrompt({
    config,
    spec,
    items: spec.rubric,
    evidence: [evidence],
    attachments: { "S1/screenshots/result.jpg": "001-result.jpg" },
    screenshotAccess: "mcp",
  });
  assert.match(judgement, /view_screenshot|001-result\.jpg/);
  assert.match(
    judgement,
    /Project-wide evaluator instructions:\s+Treat equivalent workflows as fully satisfying the criterion/,
  );
  assert.doesNotMatch(judgement, /private\/target\/source|autoShare|"weight"|"gate"|"tags"/);
});
