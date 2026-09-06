import { requireDefined } from "../src/invariants.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { personaAuthPath } from "../src/auth.js";
import { executeScenario } from "../src/scenario.js";
import type { EvalConfig, EvalSpec, Scenario, ScenarioEvidence } from "../src/types.js";

async function failedScenario(
  options: Parameters<typeof executeScenario>[0],
): Promise<ScenarioEvidence> {
  await assert.rejects(executeScenario(options), /retained scenario diagnostics/);
  return JSON.parse(fs.readFileSync(path.join(options.directory, "evidence.json"), "utf8"));
}

function workspaceFixture(root: string): {
  config: EvalConfig;
  spec: EvalSpec;
  scenario: Scenario;
} {
  const scenario: Scenario = {
    id: "S1",
    name: "Inspect",
    kind: "workspace",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const config: EvalConfig = {
    version: 1,
    project: { name: "Provider failure", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Provider failure",
    scenarios: [scenario],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  return { config, spec, scenario };
}

test("scenario provider launch failures propagate instead of becoming agent_error evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-launch-"));
  const bin = path.join(root, "empty-bin");
  fs.mkdirSync(bin);
  const { config, spec, scenario } = workspaceFixture(root);
  const originalPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    await assert.rejects(
      executeScenario({
        config,
        spec,
        scenario,
        fixtures: {},
        directory: path.join(root, "evidence"),
      }),
      /spawn claude ENOENT/,
    );
    assert.equal(fs.existsSync(path.join(root, "evidence", "evidence.json")), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("malformed scenario transcripts abort evidence ingestion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-transcript-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = { outcome: "completed", summary: "Done", observations: [], evidenceRefs: [] };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = path.dirname(args[args.lastIndexOf("--mcp-config") + 1]);
fs.writeFileSync(path.join(directory, "workspace-result.json"), JSON.stringify({outcome:"completed",summary:"Done",observations:[],finishedAt:new Date().toISOString()}));
fs.writeFileSync(path.join(directory, "workspace-transcript.ndjson"), "not-json\\n");
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  const { config, spec, scenario } = workspaceFixture(root);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    await assert.rejects(
      executeScenario({
        config,
        spec,
        scenario,
        fixtures: {},
        directory: path.join(root, "evidence"),
      }),
      /Invalid NDJSON .*workspace-transcript\.ndjson at line 1/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("successful evidence publications cannot disappear into empty metadata defaults", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-missing-metadata-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const tool of ["checkpoint", "download", "publish_output"]) {
    const { config, spec, scenario } = workspaceFixture(root);
    const kind = tool === "download" ? "browser" : "workspace";
    scenario.kind = kind;
    scenario.checkpoints = { saved: "Saved" };
    scenario.outputs = { record: { type: "string" } };
    if (kind === "browser")
      config.target = { kind: "web", url: "http://app.test", allowedOrigins: ["http://app.test"] };
    const result = {
      outcome: "blocked",
      summary: "Later check blocked",
      observations: [],
      evidenceRefs: [],
    };
    const transcript = [
      {
        step: 1,
        at: "now",
        tool: kind === "browser" ? "navigate" : "read_file",
        input: {},
        result: "Observed",
      },
      {
        step: 2,
        at: "now",
        tool,
        input:
          tool === "download"
            ? { label: "export" }
            : {
                name: tool === "checkpoint" ? "saved" : "record",
                value: "42",
                evidenceRefs: ["step:1"],
              },
        result: "Published",
      },
    ];
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=path.dirname(args[args.lastIndexOf('--mcp-config')+1]);
fs.writeFileSync(path.join(dir, '${kind}-result.json'), JSON.stringify({...${JSON.stringify(result)},finishedAt:new Date().toISOString()}));
fs.writeFileSync(path.join(dir, '${kind}-transcript.ndjson'), ${JSON.stringify(transcript.map((entry) => JSON.stringify(entry)).join("\n") + "\n")});
console.log(JSON.stringify({type:'result',structured_output:${JSON.stringify(result)}}));
`,
      { mode: 0o755 },
    );
    const directory = path.join(root, tool);
    await assert.rejects(
      executeScenario({ config, spec, scenario, fixtures: {}, directory }),
      /missing its (matching |file )?metadata/,
    );
    assert.ok(fs.existsSync(path.join(directory, `${kind}-transcript.ndjson`)));
  }
});

test("real providers cannot claim completion without MCP evidence finalization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-finalization-"));
  const bin = path.join(root, "bin");
  const directory = path.join(root, "evidence");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    outcome: "completed",
    summary: "Claimed completion without using the MCP.",
    observations: ["Unverified observation"],
    evidenceRefs: ["invented:reference"],
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
    project: { name: "Finalization", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const scenario: Scenario = {
    id: "S1",
    name: "Inspect",
    kind: "workspace",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Finalization",
    scenarios: [scenario],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const result = await failedScenario({ config, spec, scenario, fixtures: {}, directory });
    assert.equal(result.outcome, "agent_error");
    assert.match(result.summary, /did not finalize evidence through the workspace MCP done tool/);
    assert.match(result.error ?? "", /did not call the workspace MCP done tool/);
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.evidenceRefs, []);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real providers cannot claim completion with only an MCP done call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-terminal-only-"));
  const bin = path.join(root, "bin");
  const directory = path.join(root, "evidence");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    outcome: "completed",
    summary: "Claimed completion after only finalizing.",
    observations: [],
    evidenceRefs: [],
  };
  const finalized = {
    outcome: "completed",
    summary: "No target inspection occurred.",
    observations: [],
    finishedAt: "2026-01-01T00:00:00.000Z",
  };
  const doneEntry = {
    step: 1,
    at: "2026-01-01T00:00:00.000Z",
    tool: "done",
    input: { outcome: "completed", summary: "No target inspection occurred." },
    result: "Scenario evidence finalized.",
  };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = path.dirname(args[args.lastIndexOf("--mcp-config") + 1]);
fs.writeFileSync(path.join(directory, "workspace-result.json"), ${JSON.stringify(JSON.stringify(finalized))});
fs.writeFileSync(path.join(directory, "workspace-transcript.ndjson"), ${JSON.stringify(`${JSON.stringify(doneEntry)}\n`)});
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Terminal only", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const scenario: Scenario = {
    id: "S1",
    name: "Inspect",
    kind: "workspace",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Activity requirement",
    scenarios: [scenario],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const result = await failedScenario({ config, spec, scenario, fixtures: {}, directory });
    assert.equal(result.outcome, "agent_error");
    assert.match(result.summary, /without first collecting evidence through the workspace MCP/);
    assert.match(
      result.error ?? "",
      /did not perform a successful workspace evidence-gathering MCP action/,
    );
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.evidenceRefs, []);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed real providers cannot preserve a completed MCP outcome", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-failed-provider-"));
  const bin = path.join(root, "bin");
  const directory = path.join(root, "evidence");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    outcome: "completed",
    summary: "Structured completion from a failed process.",
    observations: ["Untrusted structured observation"],
    evidenceRefs: ["invented:reference"],
  };
  const finalized = {
    outcome: "completed",
    summary: "MCP completion before the provider failed.",
    observations: [],
    finishedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = path.dirname(args[args.lastIndexOf("--mcp-config") + 1]);
fs.writeFileSync(path.join(directory, "workspace-result.json"), ${JSON.stringify(JSON.stringify(finalized))});
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
process.exit(1);
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Failed provider", root },
    target: { kind: "repository", allowedOrigins: [] },
    agent: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const scenario: Scenario = {
    id: "S1",
    name: "Inspect",
    kind: "workspace",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Failure handling",
    scenarios: [scenario],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const result = await failedScenario({ config, spec, scenario, fixtures: {}, directory });
    assert.equal(result.outcome, "agent_error");
    assert.match(result.summary, /provider exited 1/);
    assert.match(result.error ?? "", /Provider exited 1/);
    assert.deepEqual(result.observations, []);
    assert.deepEqual(result.evidenceRefs, []);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser state is promoted only after the provider succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-state-promotion-"));
  const bin = path.join(root, "bin");
  const fakeClaude = path.join(bin, "claude");
  fs.mkdirSync(bin);
  const structured = {
    outcome: "completed",
    summary: "Navigation completed.",
    observations: [],
    evidenceRefs: [],
  };
  const finalized = {
    outcome: "completed",
    summary: "Navigation completed.",
    observations: [],
    finalUrl: "https://app.example.test/after",
    finishedAt: "2026-01-01T00:00:00.000Z",
  };
  const navigation = {
    step: 1,
    at: "2026-01-01T00:00:00.000Z",
    tool: "navigate",
    input: { url: "https://app.example.test" },
    result: "Allowed page",
  };
  const writeProvider = (
    fail: boolean,
    providerOutput: unknown = structured,
    badOutputs = false,
    badTranscript = false,
  ) => {
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = path.dirname(args[args.lastIndexOf("--mcp-config") + 1]);
fs.writeFileSync(path.join(directory, "browser-result.json"), ${JSON.stringify(JSON.stringify(finalized))});
fs.writeFileSync(path.join(directory, "browser-transcript.ndjson"), ${JSON.stringify(`${JSON.stringify(navigation)}\n`)});
fs.writeFileSync(path.join(directory, ".storage-state.candidate.json"), ${JSON.stringify(JSON.stringify({ cookies: [{ name: "candidate" }], origins: [] }))});
${badOutputs ? 'fs.writeFileSync(path.join(directory, "outputs.json"), JSON.stringify({unknown:{value:"bad",evidenceRefs:["step:1"]}}));' : ""}
${badTranscript ? 'fs.writeFileSync(path.join(directory, "browser-transcript.ndjson"), "not-json");' : ""}
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(providerOutput))},structured_output:${JSON.stringify(providerOutput)}}));
${fail ? "process.exit(1);" : ""}
`,
    );
    fs.chmodSync(fakeClaude, 0o755);
  };
  const config: EvalConfig = {
    version: 1,
    project: { name: "State promotion", root },
    target: {
      kind: "web",
      url: "https://app.example.test",
      allowedOrigins: ["https://app.example.test"],
    },
    agent: { provider: "claude", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const scenario: Scenario = {
    id: "S1",
    name: "Inspect",
    kind: "browser",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "State promotion",
    scenarios: [
      scenario,
      {
        id: "S2",
        name: "Continue",
        kind: "browser",
        instructions: "Continue",
        successSignals: [],
        dependsOn: ["S1"],
        requiresAuth: false,
      },
    ],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  const sharedState = path.join(root, ".state", "core", "S1.json");
  fs.mkdirSync(path.dirname(sharedState), { recursive: true });
  fs.writeFileSync(sharedState, JSON.stringify({ cookies: [{ name: "trusted" }], origins: [] }));
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    writeProvider(true);
    const failedDirectory = path.join(root, "failed");
    const failed = await failedScenario({
      config,
      spec,
      scenario,
      fixtures: {},
      directory: failedDirectory,
    });
    assert.equal(failed.outcome, "agent_error");
    assert.match(fs.readFileSync(sharedState, "utf8"), /trusted/);
    assert.equal(fs.existsSync(path.join(failedDirectory, ".storage-state.candidate.json")), false);

    writeProvider(false, { outcome: "completed" });
    const malformedDirectory = path.join(root, "malformed");
    const malformed = await failedScenario({
      config,
      spec,
      scenario,
      fixtures: {},
      directory: malformedDirectory,
    });
    assert.equal(malformed.outcome, "agent_error");
    assert.match(malformed.summary, /invalid structured output/i);
    assert.match(fs.readFileSync(sharedState, "utf8"), /trusted/);
    assert.equal(
      fs.existsSync(path.join(malformedDirectory, ".storage-state.candidate.json")),
      false,
    );

    writeProvider(false, structured, true);
    const badOutputDirectory = path.join(root, "bad-outputs");
    const badOutputs = await failedScenario({
      config,
      spec,
      scenario,
      fixtures: {},
      directory: badOutputDirectory,
    });
    assert.match(badOutputs.summary, /Invalid scenario outputs/);
    assert.match(fs.readFileSync(sharedState, "utf8"), /trusted/);
    assert.equal(
      fs.existsSync(path.join(badOutputDirectory, ".storage-state.candidate.json")),
      false,
    );

    writeProvider(false, structured, false, true);
    const badTranscriptDirectory = path.join(root, "bad-transcript");
    await assert.rejects(
      executeScenario({ config, spec, scenario, fixtures: {}, directory: badTranscriptDirectory }),
      /Invalid NDJSON/,
    );
    assert.match(fs.readFileSync(sharedState, "utf8"), /trusted/);
    assert.equal(
      fs.existsSync(path.join(badTranscriptDirectory, ".storage-state.candidate.json")),
      false,
    );

    writeProvider(false);
    const succeededDirectory = path.join(root, "succeeded");
    const succeeded = await executeScenario({
      config,
      spec,
      scenario,
      fixtures: {},
      directory: succeededDirectory,
    });
    assert.equal(succeeded.outcome, "completed");
    assert.match(fs.readFileSync(sharedState, "utf8"), /candidate/);
    if (process.platform !== "win32") assert.equal(fs.statSync(sharedState).mode & 0o777, 0o600);
    assert.equal(
      fs.existsSync(path.join(succeededDirectory, ".storage-state.candidate.json")),
      false,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an uncaptured persona uses chain-local state without creating trusted authentication state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-scenario-anonymous-persona-"));
  const bin = path.join(root, "bin");
  const directory = path.join(root, "scenario");
  fs.mkdirSync(bin);
  const fakeClaude = path.join(bin, "claude");
  const structured = {
    outcome: "completed",
    summary: "Anonymous page inspected.",
    observations: [],
    evidenceRefs: [],
  };
  const finalized = {
    outcome: "completed",
    summary: "Anonymous page inspected.",
    observations: [],
    finalUrl: "https://app.example.test/",
    finishedAt: "2026-01-01T00:00:00.000Z",
  };
  const navigation = {
    step: 1,
    at: "2026-01-01T00:00:00.000Z",
    tool: "navigate",
    input: { url: "https://app.example.test" },
    result: "Public page",
  };
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const directory = path.dirname(args[args.lastIndexOf("--mcp-config") + 1]);
const context = JSON.parse(fs.readFileSync(path.join(directory, "browser-context.json"), "utf8"));
fs.writeFileSync(path.join(directory, "browser-result.json"), ${JSON.stringify(JSON.stringify(finalized))});
fs.writeFileSync(path.join(directory, "browser-transcript.ndjson"), ${JSON.stringify(`${JSON.stringify(navigation)}\n`)});
if (context.storageStateCandidatePath) fs.writeFileSync(context.storageStateCandidatePath, JSON.stringify({cookies:[{name:"chain"}],origins:[]}));
console.log(JSON.stringify({type:"result",result:${JSON.stringify(JSON.stringify(structured))},structured_output:${JSON.stringify(structured)}}));
`,
  );
  fs.chmodSync(fakeClaude, 0o755);
  const config: EvalConfig = {
    version: 1,
    project: { name: "Anonymous persona", root },
    target: {
      kind: "web",
      url: "https://app.example.test",
      allowedOrigins: ["https://app.example.test"],
    },
    agent: { provider: "claude", maxTurns: 1, timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: path.join(root, "runs"), auth: path.join(root, "auth") },
    browser: { headless: true, viewport: { width: 800, height: 600 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const scenario: Scenario = {
    id: "S1",
    name: "Public persona view",
    kind: "browser",
    persona: "buyer",
    instructions: "Inspect",
    successSignals: [],
    dependsOn: [],
    requiresAuth: false,
  };
  const spec: EvalSpec = {
    id: "core",
    title: "Core",
    weight: 100,
    optional: false,
    description: "Anonymous persona",
    scenarios: [
      scenario,
      { ...scenario, id: "S2", name: "Continue persona flow", dependsOn: ["S1"] },
    ],
    rubric: [],
    sourceFile: path.join(root, "unused.yaml"),
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    const result = await executeScenario({ config, spec, scenario, fixtures: {}, directory });
    assert.equal(result.outcome, "completed");
    const context = JSON.parse(
      fs.readFileSync(path.join(directory, "browser-context.json"), "utf8"),
    );
    assert.equal(context.storageStatePath, undefined);
    assert.match(context.storageStateCandidatePath, /\.storage-state\.candidate\.json$/);
    assert.equal(
      context.maxToolCalls,
      undefined,
      "Claude maxTurns must remain a provider-turn limit",
    );
    assert.equal(fs.existsSync(personaAuthPath(config, "buyer")), false);
    const chainState = path.join(root, ".state", "core", "S1.json");
    assert.match(fs.readFileSync(chainState, "utf8"), /chain/);

    const dependentDirectory = path.join(root, "S2");
    const dependent = await executeScenario({
      config,
      spec,
      scenario: requireDefined(spec.scenarios[1], "spec.scenarios[1]"),
      fixtures: {},
      directory: dependentDirectory,
    });
    assert.equal(dependent.outcome, "completed");
    const dependentContext = JSON.parse(
      fs.readFileSync(path.join(dependentDirectory, "browser-context.json"), "utf8"),
    );
    assert.equal(dependentContext.storageStatePath, chainState);
    assert.equal(fs.existsSync(personaAuthPath(config, "buyer")), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persona-switching scenarios block missing initial authentication even without requiresAuth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-persona-initial-"));
  try {
    const { config, spec, scenario } = workspaceFixture(root);
    config.target = {
      kind: "web",
      url: "https://app.example.test",
      allowedOrigins: ["https://app.example.test"],
    };
    scenario.kind = "browser";
    scenario.persona = "organizer";
    scenario.allowedPersonas = ["organizer", "reviewer"];
    scenario.dependsOn = ["CREATE"];
    scenario.inputs = { record: { from: "CREATE", output: "record" } };
    const inputs = {
      record: {
        value: "record-42",
        evidenceRefs: ["step:1"],
        scenarioId: "CREATE",
        output: "record",
      },
    };
    const directory = path.join(root, "evidence");
    const result = await executeScenario({
      config,
      spec,
      scenario,
      fixtures: {},
      directory,
      inputs,
    });
    assert.equal(result.outcome, "blocked");
    assert.deepEqual(result.inputs, inputs);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8")).inputs,
      inputs,
    );
    assert.match(result.summary, /No saved browser session.*organizer/);
    assert.equal(fs.existsSync(path.join(directory, "provider-run.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
