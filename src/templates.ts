import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const configTemplate = `version: 1
project:
  name: Example project
  root: .

target:
  # web | repository | command
  kind: web
  url: http://127.0.0.1:3000
  # Exact origins by default. Wildcards must be explicit, e.g. https://*.example.com
  allowedOrigins: [http://127.0.0.1:3000]
  # Uncomment for a local application managed by the eval run.
  # setup: pnpm install --frozen-lockfile
  # start: pnpm dev
  # ready:
  #   url: http://127.0.0.1:3000
  #   timeoutSeconds: 120

agent:
  provider: codex
  # model: gpt-5.6-sol
  effort: high
  # Claude/Grok provider turns; Codex MCP interactions.
  maxTurns: 60
  timeoutSeconds: 1800

judge:
  provider: codex
  # Keep the judge independent by selecting claude or grok if desired.
  effort: high
  timeoutSeconds: 900

paths:
  specs: evals/specs
  fixtures: evals/fixtures.yaml
  runs: .agent-eval/runs
  auth: .agent-eval/auth
  baselines: evals/baselines

browser:
  headless: true
  viewport: { width: 1280, height: 800 }
  actionTimeoutMs: 10000

scoring:
  partialCredit: 0.5
  minimumCoverage: 60

variables: {}
instructions: Judge equivalent functionality regardless of naming or visual design.
`;

export const specTemplate = `id: core
title: Core workflow
weight: 100
description: The smallest end-to-end workflow that proves the project works.

scenarios:
  - id: CORE-S1
    name: Complete the primary workflow
    kind: browser
    instructions: |
      1. Open the application and identify its primary user workflow.
      2. Create a uniquely named test record using the fixture value.
      3. Complete the workflow and capture the result state.
      4. Reload or revisit the relevant screen and prove the result persisted.
    successSignals:
      - A screenshot before submission and after successful completion
      - The unique fixture value remains visible after reload
    # Optional case matrix example:
    # cases:
    #   - id: monthly-active
    #     split: development
    #     variables: { plan: monthly, accountState: active }
    #     strata: { plan: monthly, account_state: active }
    #   - id: annual-past-due
    #     split: evaluation
    #     variables: { plan: annual, accountState: past_due }
    #     strata: { plan: annual, account_state: past_due }

rubric:
  - id: CORE-01
    criterion: A user can complete the primary workflow end to end and its result persists
    weight: 3
    gate: true
    tags: [workflow, persistence]
    scenarios: [CORE-S1]
    grader: { type: llm }
    passCriteria: The workflow reaches a clear success state and the created result remains after reload.
    evidence: Before/after screenshots plus the persisted unique fixture value.

  - id: CORE-02
    criterion: The project's deterministic test suite passes
    weight: 2
    tags: [correctness]
    scenarios: []
    grader:
      type: command
      output: exit-code
      command: pnpm test
      timeoutSeconds: 300
    passCriteria: The configured test command exits successfully.

  - id: CORE-03
    criterion: A real external side effect is delivered
    weight: 1
    tags: [side-effect]
    scenarios: [CORE-S1]
    grader:
      type: hybrid
      autoShare: 0.5
    passCriteria: The UI confirms the side effect and it is independently received.
    evidence: UI confirmation from the browser scenario.
    manualInstructions: Check the destination system and confirm the side effect arrived exactly once.
`;

export const fixturesTemplate = `data:
  uniqueRecordName: AEK verification record 2026

# Upload tools accept only names declared here. Paths are relative to this file.
files: {}
`;

export function initializeProject(directory: string): string[] {
  const root = path.resolve(directory);
  const files: Array<{ target: string; content: string; staged?: string }> = [
    { target: path.join(root, "evalkit.yaml"), content: configTemplate },
    { target: path.join(root, "evals", "specs", "core.yaml"), content: specTemplate },
    { target: path.join(root, "evals", "fixtures.yaml"), content: fixturesTemplate },
  ];
  const conflicts = files.filter(({ target }) => fs.existsSync(target)).map(({ target }) => target);
  if (conflicts.length) {
    throw new Error(`Refusing to overwrite existing files:\n  - ${conflicts.join("\n  - ")}`);
  }

  const published: string[] = [];
  const createdDirectories = [root, path.join(root, "evals"), path.join(root, "evals", "specs")]
    .filter((directoryPath) => !fs.existsSync(directoryPath));
  try {
    // Stage every complete file before making any of them visible at its final path.
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.target), { recursive: true });
      file.staged = path.join(
        path.dirname(file.target),
        `.aek-init-${process.pid}-${crypto.randomUUID()}.tmp`,
      );
      fs.writeFileSync(file.staged, file.content, { flag: "wx" });
    }

    // A hard link publishes without an overwrite race. Rollback below makes the
    // multi-file operation all-or-nothing from the caller's point of view.
    for (const file of files) {
      fs.linkSync(file.staged!, file.target);
      published.push(file.target);
      fs.unlinkSync(file.staged!);
      file.staged = undefined;
    }
    return files.map(({ target }) => target);
  } catch (error) {
    for (const file of files) {
      try {
        if (file.staged && fs.existsSync(file.staged)) fs.unlinkSync(file.staged);
      } catch {
        // Preserve the original initialization error.
      }
    }
    for (const target of published.reverse()) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {
        // Preserve the original initialization error.
      }
    }
    for (const directoryPath of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directoryPath);
      } catch {
        // Remove only directories that are still empty.
      }
    }
    throw error;
  }
}
