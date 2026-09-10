import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProvider } from "../src/providers/index.js";
import { cursorAuthPath } from "../src/providers/cursor.js";
import { loadConfig, loadResolvedConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { providerVersion } from "../src/receipts.js";
import type { ProviderInvocation } from "../src/types.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-cursor-test-"));
  const original = { ...process.env };
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = path.join(root, "source-home");
  process.env.XDG_CONFIG_HOME = path.join(root, "source-xdg");
  process.env.CURSOR_CONFIG_DIR = path.join(root, "untrusted-settings");
  process.env.CURSOR_API_KEY = "must-not-leak";
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const auth = cursorAuthPath();
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  fs.writeFileSync(auth, JSON.stringify({ accessToken: "fixture", generation: 0 }));
  const invocation: ProviderInvocation = {
    purpose: "judge",
    cwd: root,
    promptFile: path.join(root, "prompt.md"),
    outputSchemaFile: path.join(root, "schema.json"),
    outputFile: path.join(root, "output.json"),
    eventLogFile: path.join(root, "events.ndjson"),
    stderrFile: path.join(root, "stderr.log"),
    timeoutSeconds: 10,
    extraArgs: [],
    allowWorkspaceTools: false,
  };
  fs.writeFileSync(invocation.promptFile, "Judge supplied evidence.");
  fs.writeFileSync(invocation.outputSchemaFile, '{"type":"object"}');
  return {
    root,
    auth,
    invocation,
    executable(source: string) {
      fs.writeFileSync(path.join(bin, "cursor-agent"), `#!/usr/bin/env node\n${source}`, {
        mode: 0o755,
      });
    },
    cleanup() {
      process.env = original;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Cursor dispatch preserves isolation, MCP policy, final answer and refreshed credentials", async () => {
  const f = fixture();
  try {
    const mcpFile = path.join(f.root, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { evidence: { command: "fixture" } } }));
    f.invocation.mcp = {
      name: "evidence",
      command: "fixture",
      args: [],
      configFile: mcpFile,
      toolNames: ["view"],
    };
    f.invocation.model = "test-model";
    f.executable(`
const fs = require('node:fs'), path = require('node:path');
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json')));
  const auth = path.join(process.platform === 'darwin' ? path.join(process.env.HOME, '.cursor') : path.join(process.env.XDG_CONFIG_HOME, 'cursor'), 'auth.json');
  const credentials = JSON.parse(fs.readFileSync(auth));
  fs.writeFileSync(auth, JSON.stringify({...credentials, generation: credentials.generation + 1}));
  fs.writeFileSync(${JSON.stringify(path.join(f.root, "capture.json"))}, JSON.stringify({cwd:process.cwd(), env:process.env, args:process.argv.slice(2), config, prompt, mcp:JSON.parse(fs.readFileSync('.cursor/mcp.json'))}));
  const emit = event => console.log(JSON.stringify(event));
  emit({type:'assistant', message:{content:[{type:'text',text:'Inspecting evidence.'}]}});
  emit({type:'tool_call',subtype:'started',tool_call:{getMcpToolsToolCall:{args:{}},hookAdditionalContexts:[],toolCallId:'discovery',startedAtMs:'1789072118298'}});
  emit({type:'tool_call',subtype:'started',tool_call:{mcpToolCall:{args:{providerIdentifier:'evidence',toolName:'view'}},hookAdditionalContexts:[],toolCallId:'view',startedAtMs:'1789072118298',completedAtMs:'1789072118300'}});
  emit({type:'assistant',message:{content:[{type:'text',text:'{"verdict":"cannot_judge"}'}]}});
  emit({type:'result',subtype:'success',is_error:false,result:'Inspecting evidence.{"verdict":"cannot_judge"}',session_id:'session-1'});
});`);
    const result = await runProvider("cursor", f.invocation);
    assert.deepEqual(result.structured, { verdict: "cannot_judge" });
    assert.equal(result.sessionId, "session-1");
    assert.deepEqual(result.policyViolations, []);
    const capture = JSON.parse(fs.readFileSync(path.join(f.root, "capture.json"), "utf8"));
    assert.notEqual(capture.cwd, f.root);
    assert.equal(fs.existsSync(capture.cwd), false);
    assert.equal(capture.env.CURSOR_API_KEY, undefined);
    assert.equal(capture.env.DIRENV_DISABLE, "1");
    assert.notEqual(capture.env.CURSOR_CONFIG_DIR, process.env.CURSOR_CONFIG_DIR);
    assert.deepEqual(capture.config.permissions, {
      allow: ["Mcp(evidence:view)"],
      deny: ["Write(**)", "WebFetch(*)", "Read(**)", "Shell(*)"],
    });
    assert.match(capture.prompt, /JSON Schema/);
    assert.match(capture.prompt, /"type":"object"/);
    assert.ok(capture.args.includes("test-model"));
    assert.deepEqual(capture.mcp.mcpServers.evidence, {
      command: "fixture",
      args: [],
      env: { PLAYWRIGHT_BROWSERS_PATH: capture.env.PLAYWRIGHT_BROWSERS_PATH },
    });
    assert.equal(typeof capture.mcp.mcpServers.evidence.env.PLAYWRIGHT_BROWSERS_PATH, "string");
    assert.equal(JSON.parse(fs.readFileSync(f.auth, "utf8")).generation, 1);
  } finally {
    f.cleanup();
  }
});

test("Cursor rejects unsupported settings before spawning", async () => {
  const f = fixture();
  try {
    for (const settings of [
      { effort: "high" },
      { maxTurns: 2 },
      { extraArgs: ["--force"] },
      { images: ["image.png"] },
    ])
      await assert.rejects(runProvider("cursor", { ...f.invocation, ...settings }), /Cursor/);
    fs.rmSync(f.auth);
    await assert.rejects(runProvider("cursor", f.invocation), /cursor-agent login/);
  } finally {
    f.cleanup();
  }
});

test("Cursor retains tool violations and rejects failed or malformed streams", async () => {
  const f = fixture();
  try {
    f.executable(
      `console.log(JSON.stringify({type:'tool_call',subtype:'completed',tool_call:{shellToolCall:{args:{}}}})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{}'}));`,
    );
    assert.deepEqual((await runProvider("cursor", f.invocation)).policyViolations, [
      "shellToolCall",
    ]);
    for (const source of [
      "console.log('not json')",
      "console.log('{}')",
      "console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'{}'}))",
      "console.log(JSON.stringify({type:'assistant',message:{content:[]}}))",
    ]) {
      f.executable(source);
      await assert.rejects(runProvider("cursor", f.invocation), /Cursor/);
    }
    f.executable("process.exit(7)");
    assert.equal((await runProvider("cursor", f.invocation)).exitCode, 7);
    f.executable("setInterval(() => {}, 1000)");
    assert.equal(
      (await runProvider("cursor", { ...f.invocation, timeoutSeconds: 0.1 })).timedOut,
      true,
    );
  } finally {
    f.cleanup();
  }
});

test("Cursor doctor and receipts use cursor-agent rather than the ambiguous agent binary", () => {
  const f = fixture();
  try {
    f.executable(
      "if (process.argv.includes('--version')) console.log('2026.09.08-cursor'); else process.exit(1)",
    );
    assert.equal(providerVersion("cursor"), "2026.09.08-cursor");
    assert.equal(
      doctor({ providers: ["cursor"] }).find((check) => check.name === "cursor subscription auth")
        ?.ok,
      true,
    );
    fs.rmSync(f.auth);
    assert.equal(
      doctor({ providers: ["cursor"] }).find((check) => check.name === "cursor subscription auth")
        ?.ok,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("Cursor selections survive configuration resolution and saved config loading", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "evalkit.yaml");
    fs.writeFileSync(
      file,
      `version: 1
project: { name: Cursor test, root: . }
target: { kind: repository }
agent: { provider: cursor, model: selected-model }
judge: { provider: cursor }
`,
    );
    const config = loadConfig(file);
    assert.equal(config.agent.provider, "cursor");
    assert.equal(config.judge.provider, "cursor");
    assert.equal(config.agent.model, "selected-model");
    const saved = path.join(f.root, "resolved.json");
    fs.writeFileSync(saved, JSON.stringify(config));
    assert.equal(loadResolvedConfig(saved).judge.provider, "cursor");
  } finally {
    f.cleanup();
  }
});

test("Cursor permits session todos without weakening evidence tool restrictions", async () => {
  const f = fixture();
  try {
    const events = [
      {
        type: "tool_call",
        subtype: "started",
        tool_call: {
          updateTodosToolCall: {
            args: {
              todos: [{ id: "inspect", content: "Inspect evidence", status: "in_progress" }],
              merge: false,
            },
          },
          hookAdditionalContexts: [],
          toolCallId: "todo-update",
          startedAtMs: "1789072118298",
        },
      },
      {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          readTodosToolCall: {
            args: { statusFilter: [], idFilter: [] },
            result: { success: { todos: [], totalCount: 0 } },
          },
          hookAdditionalContexts: [],
          toolCallId: "todo-read",
          completedAtMs: "1789072118300",
        },
      },
    ];
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"verdict":"cannot_judge"}',
    };
    const emit = (values: unknown[]) =>
      f.executable(
        values.map((value) => `console.log(${JSON.stringify(JSON.stringify(value))});`).join("\n"),
      );
    emit([...events, result]);
    for (const purpose of ["scenario", "judge"] as const) {
      const answer = await runProvider("cursor", { ...f.invocation, purpose });
      assert.deepEqual(answer.policyViolations, []);
      assert.deepEqual(answer.structured, { verdict: "cannot_judge" });
      assert.equal("usage" in answer, false);
    }
    emit([
      ...events,
      {
        type: "tool_call",
        subtype: "started",
        tool_call: { readToolCall: { args: { path: "/target/hidden-rubric.md" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          mcpToolCall: { args: { providerIdentifier: "unapproved", toolName: "read" } },
        },
      },
      result,
    ]);
    assert.deepEqual((await runProvider("cursor", f.invocation)).policyViolations, [
      "readToolCall",
      "mcpToolCall",
    ]);
  } finally {
    f.cleanup();
  }
});

test("Cursor preserves terminal usage as reported, including nested provider metadata", async () => {
  const f = fixture();
  try {
    // The token keys match the installed CLI's live smoke-test result. Keep
    // arbitrary nested fields too, as required by the shared ProviderUsage contract.
    const usage = {
      inputTokens: 40507,
      outputTokens: 1267,
      cacheReadTokens: 54272,
      cacheWriteTokens: 0,
      details: { reasoningTokens: 123, iterations: [{ tokens: 7 }] },
    };
    const result = { type: "result", subtype: "success", is_error: false, result: "{}", usage };
    f.executable(`console.log(${JSON.stringify(JSON.stringify(result))});`);
    assert.deepEqual((await runProvider("cursor", f.invocation)).usage, usage);
    f.executable(`console.log(${JSON.stringify(JSON.stringify({ ...result, usage: [] }))});`);
    await assert.rejects(runProvider("cursor", f.invocation), /malformed stream-json/);
  } finally {
    f.cleanup();
  }
});
