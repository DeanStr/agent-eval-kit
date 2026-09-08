import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";
import { loadSpecFile, loadSpecs, materializeSpecs } from "../src/specs.js";
import { buildExecutionPlan, formatExecutionPlan } from "../src/execution-plan.js";

test("mixed execution preview batches ordinary judges and counts selected text cases and image references", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Plan", root: "." },
      target: {
        kind: "web",
        url: "http://localhost:3000",
        setup: { command: "prepare", env: { TEST_SECRET: "private value" } },
        ready: { command: "ready" },
      },
      agent: { provider: "codex" },
      judge: { provider: "claude", voting: { minimumVotes: 3, maximumVotes: 7 } },
      paths: { specs: "spec.yaml" },
    }),
  );
  const rubric = (id: string, grader: object, scenarios: string[] = []) => ({
    id,
    weight: 1,
    criterion: id,
    passCriteria: id,
    manualInstructions: "Inspect retained evidence",
    scenarios,
    grader,
  });
  fs.writeFileSync(
    path.join(root, "spec.yaml"),
    YAML.stringify({
      id: "core",
      title: "Core",
      description: "Preview",
      weight: 100,
      scenarios: [
        {
          id: "REVIEW",
          name: "Review",
          instructions: "Review saved record",
          dependsOn: ["CREATE"],
        },
        { id: "CREATE", name: "Create", instructions: "Create record" },
      ],
      datasets: {
        drafts: [
          { id: "one", inputs: { draft: { text: "First draft" } } },
          { id: "two", inputs: { draft: { text: "Second draft" } } },
          { id: "reserved", split: "evaluation", inputs: { draft: { text: "Reserved draft" } } },
        ],
      },
      rubric: [
        rubric("WORKS", { type: "llm" }, ["REVIEW"]),
        rubric("HYBRID", { type: "hybrid", autoShare: 0.5 }, ["REVIEW"]),
        rubric(
          "VISUAL",
          {
            type: "pairwise",
            candidate: "final",
            policy: "non_regression",
            references: [{ file: "a.png" }, { file: "b.png" }],
          },
          ["REVIEW"],
        ),
        {
          ...rubric("VOICE", {
            type: "text-pairwise",
            candidate: "{{inputs.draft}}",
            references: [{ file: "a.txt" }, { file: "b.txt" }],
            policy: "preference",
            voting: { minimumVotes: 2, maximumVotes: 4 },
          }),
          dataset: "drafts",
        },
        {
          ...rubric("QUALITY", {
            type: "text-rubric",
            inputs: { draft: { file: "{{inputs.draft}}" } },
          }),
          dataset: "drafts",
        },
        rubric("CHECK", {
          type: "command",
          output: "exit-code",
          command: "check",
          methodFiles: [],
        }),
        rubric("HUMAN", { type: "manual" }),
      ],
    }),
  );
  const config = loadConfig(configFile);
  const specs = loadSpecs(config.paths.specs);
  const options = {
    config,
    configFile,
    specs,
    fixtures: {},
    split: "development" as const,
    textCaseIds: ["core/drafts/one"],
  };
  const materialized = materializeSpecs(specs, "development");
  const plan = buildExecutionPlan(options, materialized);
  assert.equal(plan.version, 2);
  assert.equal(plan.judgeCalls.minimum, 20);
  assert.equal(plan.judgeCalls.maximum, 40);
  assert.deepEqual(plan.areas[0]!.judgeGroups[0]!.ids, ["WORKS", "HYBRID"]);
  assert.deepEqual(
    plan.executionOrder.filter((step) => step.kind === "collector").map((step) => step.ids[0]),
    ["CREATE", "REVIEW"],
  );
  assert.equal(plan.services.browser.required, true);
  assert.deepEqual(
    plan.services.providers.map((p) => p.provider),
    ["codex", "claude"],
  );
  assert.equal(plan.services.providers[0]!.maxTurns, 50);
  assert.equal(plan.areas[0]!.graders.find((g) => g.id === "VOICE")!.cases!.length, 2);
  assert.match(formatExecutionPlan(plan), /CHECK \[command\].*planned — check/);
  assert.doesNotMatch(JSON.stringify(plan), /private value/);
  assert.equal(fs.existsSync(path.join(root, ".agent-eval")), false);

  const campaign = buildExecutionPlan({ ...options, previewRepetitions: 3 }, materialized);
  assert.equal(campaign.mode, "campaign");
  assert.equal(campaign.judgeCalls.maximum, 120);
  assert.deepEqual(campaign.judgeCalls.perRepetition, { minimum: 20, maximum: 40 });
  const { textCaseIds: _textCaseIds, ...collectionOptions } = options;
  const collect = buildExecutionPlan({ ...collectionOptions, collectOnly: true }, materialized);
  assert.equal(collect.judgeCalls.maximum, 0);
  assert.deepEqual(
    collect.services.providers.map((p) => p.role),
    ["agent"],
  );
  assert.equal(collect.areas[0]!.graders.find((g) => g.id === "CHECK")!.status, "planned");
  assert.equal(collect.areas[0]!.graders.find((g) => g.id === "WORKS")!.status, "deferred");
  const filtered = buildExecutionPlan({ ...options, scenarioIds: ["REVIEW"] }, materialized);
  assert.deepEqual(filtered.areas[0]!.skippedScenarios, ["CREATE"]);
  assert.equal(filtered.areas[0]!.scenarios[0]!.status, "blocked-by-selection");
  assert.equal(filtered.services.browser.required, true);
  assert.equal(filtered.services.browser.collectionPlanned, false);
  assert.equal(filtered.services.providers[0]!.purpose, "version-only");
  assert.equal(filtered.judgeCalls.maximum, 22);
  const missingDataset = structuredClone(materialized);
  delete missingDataset[0]!.datasets;
  assert.throws(
    () => buildExecutionPlan({ ...collectionOptions, collectOnly: true }, missingDataset),
    /Missing required value: core\/VOICE dataset drafts/,
  );
});

test("collector preview includes declared outputs and effective provider limits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-collector-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "evalkit.yaml");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      version: 1,
      project: { name: "Collector", root: "." },
      target: { kind: "command" },
      judge: { provider: "codex", maxTurns: 12, effort: "high" },
    }),
  );
  const specFile = path.join(root, "spec.yaml");
  fs.writeFileSync(
    specFile,
    YAML.stringify({
      id: "core",
      title: "Core",
      description: "Command collector",
      weight: 100,
      scenarios: [
        {
          id: "RENDER",
          name: "Render",
          kind: "command",
          instructions: "Render artifact",
          checkpoints: { rendered: "Rendered the document" },
          collect: {
            command: "render",
            methodFiles: [],
            sources: { document: "source.pdf" },
            images: ["page"],
            files: ["transcript"],
          },
        },
      ],
      rubric: [
        {
          id: "QUALITY",
          weight: 1,
          criterion: "Readable",
          passCriteria: "Readable document",
          scenarios: ["RENDER"],
          checkpoints: { RENDER: ["rendered"] },
          grader: { type: "llm" },
        },
      ],
    }),
  );
  const config = loadConfig(configFile);
  const specs = [loadSpecFile(specFile)];
  const plan = buildExecutionPlan(
    { config, configFile, specs, fixtures: {} },
    materializeSpecs(specs),
  );
  const collector = plan.areas[0]!.scenarios[0]!;
  assert.equal(collector.cwd, root);
  assert.equal(collector.timeoutSeconds, 300);
  assert.deepEqual(collector.images, ["page"]);
  assert.deepEqual(collector.files, ["transcript"]);
  assert.deepEqual(collector.requiredCheckpoints, ["rendered"]);
  const judge = plan.services.providers.find((provider) => provider.role === "judge")!;
  assert.equal(judge.maxTurns, null);
  assert.equal(judge.effort, "high");
  const formatted = formatExecutionPlan(plan);
  assert.match(formatted, /required checkpoints: rendered/);
  assert.match(formatted, /images: page/);
  assert.match(formatted, /files: transcript/);
});
