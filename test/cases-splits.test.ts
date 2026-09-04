import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { caseJudgeRequests } from "../src/prompts.js";
import { loadSpecs, materializeSpec } from "../src/specs.js";
import type { ScenarioEvidence } from "../src/types.js";

function caseEvidence(scenario: ReturnType<typeof materializeSpec>["scenarios"][number]): ScenarioEvidence {
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    kind: scenario.kind ?? "workspace",
    sourceScenarioId: scenario.sourceScenarioId,
    caseId: scenario.caseId,
    strata: scenario.strata,
    split: scenario.split,
    outcome: "completed",
    summary: "Done",
    observations: [],
    evidenceRefs: [],
    transcript: [],
    screenshots: [],
    artifacts: {},
    provider: "mock",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
  };
}

test("case matrices normalize strata, preserve stable identities, and filter development/evaluation splits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-cases-"));
  fs.writeFileSync(path.join(root, "cases.yaml"), `id: core
title: Core
weight: 100
description: Matrix
scenarios:
  - id: CREATE
    name: Create
    instructions: Create the record
    cases:
      - id: monthly
        split: development
        variables: { plan: monthly }
        strata: { plan: monthly, state: active }
      - id: annual
        split: evaluation
        variables: { plan: annual }
        strata: [state=active, plan=annual, state=active]
  - id: VERIFY
    name: Verify
    instructions: Verify the record
    dependsOn: [CREATE]
    cases:
      - id: monthly
        split: development
        variables: { plan: monthly }
        strata: { plan: monthly, state: active }
      - id: annual
        split: evaluation
        variables: { plan: annual }
        strata: [plan=annual, state=active]
rubric:
  - id: R1
    criterion: Works
    weight: 1
    scenarios: [CREATE, VERIFY]
    grader: { type: llm }
    passCriteria: Works for every case
`);
  const [source] = loadSpecs(root);
  assert.deepEqual(source.scenarios[0].cases?.[0].strata, ["plan=monthly", "state=active"]);
  const evaluation = materializeSpec(source, "evaluation");
  assert.deepEqual(evaluation.scenarios.map((scenario) => scenario.id), ["CREATE--annual", "VERIFY--annual"]);
  assert.deepEqual(evaluation.scenarios[1].dependsOn, ["CREATE--annual"]);
  assert.deepEqual(evaluation.rubric[0].scenarios, ["CREATE--annual", "VERIFY--annual"]);
  assert.equal(evaluation.scenarios[0].caseVariables?.plan, "annual");
  assert.deepEqual(caseJudgeRequests(evaluation.rubric, evaluation.scenarios.map(caseEvidence)), [{
    rubricId: "R1",
    caseId: "annual",
    scenarioIds: ["CREATE--annual", "VERIFY--annual"],
    strata: ["plan=annual", "state=active"],
    split: "evaluation",
  }]);
});

test("case validation rejects missing dependency cases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-bad-cases-"));
  fs.writeFileSync(path.join(root, "bad.yaml"), `id: core
title: Core
weight: 100
description: Matrix
scenarios:
  - id: FIRST
    name: First
    instructions: First
    cases:
      - { id: one, variables: { x: 1 }, strata: [kind=one], split: development }
  - id: SECOND
    name: Second
    instructions: Second
    dependsOn: [FIRST]
    cases:
      - { id: two, variables: { x: 2 }, strata: [kind=two], split: evaluation }
rubric:
  - id: R1
    criterion: Works
    weight: 1
    scenarios: [SECOND]
    grader: { type: llm }
    passCriteria: Works
`);
  assert.throws(() => loadSpecs(root), /SECOND\/two has no matching dependency case FIRST\/two/);
});

test("unrelated scenarios may reuse case ids with different strata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-independent-cases-"));
  fs.writeFileSync(path.join(root, "valid.yaml"), `id: core
title: Core
weight: 100
description: Independent matrices
scenarios:
  - id: FIRST
    name: First
    instructions: First
    cases: [{ id: smoke, strata: [surface=api] }]
  - id: SECOND
    name: Second
    instructions: Second
    cases: [{ id: smoke, strata: [surface=ui] }]
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [FIRST, SECOND], grader: { type: llm }, passCriteria: Works }
`);
  const materialized = materializeSpec(loadSpecs(root)[0]);
  const requests = caseJudgeRequests(materialized.rubric, materialized.scenarios.map(caseEvidence));
  assert.deepEqual(requests.map(({ caseId, scenarioIds, strata }) => ({ caseId, scenarioIds, strata })), [
    { caseId: "FIRST/smoke", scenarioIds: ["FIRST--smoke"], strata: ["surface=api"] },
    { caseId: "SECOND/smoke", scenarioIds: ["SECOND--smoke"], strata: ["surface=ui"] },
  ]);
});

test("materialized scenario ids must be unique across areas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-global-case-ids-"));
  fs.writeFileSync(path.join(root, "one.yaml"), `id: one
title: One
weight: 50
description: Matrix
scenarios:
  - id: S1
    name: Matrix scenario
    instructions: Run it
    cases: [{ id: caseA }]
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [S1], grader: { type: llm }, passCriteria: Works }
`);
  fs.writeFileSync(path.join(root, "two.yaml"), `id: two
title: Two
weight: 50
description: Plain scenario
scenarios:
  - { id: S1--caseA, name: Plain scenario, instructions: Run it }
rubric:
  - { id: R2, criterion: Works, weight: 1, scenarios: [S1--caseA], grader: { type: llm }, passCriteria: Works }
`);
  assert.throws(() => loadSpecs(root), /expanded scenario id S1--caseA collides with another scenario or case across the spec set/);
});

test("matching dependency cases must be available in the same split", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-split-dependency-"));
  fs.writeFileSync(path.join(root, "invalid.yaml"), `id: core
title: Core
weight: 100
description: Split mismatch
scenarios:
  - id: FIRST
    name: First
    instructions: First
    cases: [{ id: smoke, strata: [kind=smoke], split: development }]
  - id: SECOND
    name: Second
    instructions: Second
    dependsOn: [FIRST]
    cases: [{ id: smoke, strata: [kind=smoke], split: evaluation }]
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [SECOND], grader: { type: llm }, passCriteria: Works }
`);
  assert.throws(() => loadSpecs(root), /SECOND\/smoke has split evaluation but dependency FIRST\/smoke has split development/);
});

test("an all-splits scenario cannot depend on a split-specific prerequisite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-unscoped-dependency-"));
  fs.writeFileSync(path.join(root, "invalid.yaml"), `id: core
title: Core
weight: 100
description: Unavailable evaluation dependency
scenarios:
  - id: FIRST
    name: First
    instructions: First
    split: development
  - id: SECOND
    name: Second
    instructions: Second
    dependsOn: [FIRST]
rubric:
  - { id: R1, criterion: Works, weight: 1, scenarios: [SECOND], grader: { type: llm }, passCriteria: Works }
`);
  assert.throws(() => loadSpecs(root), /SECOND runs in every split but dependency FIRST has split development/);
});
