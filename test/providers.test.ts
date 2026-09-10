import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runClaude } from "../src/providers/claude.js";
import { runCodex } from "../src/providers/codex.js";
import { runGrok } from "../src/providers/grok.js";
import { playwrightBrowsersPath } from "../src/providers/process.js";
import type { ProviderInvocation } from "../src/types.js";

function providerInvocation(root: string): ProviderInvocation {
  const promptFile = path.join(root, "prompt.md");
  const outputSchemaFile = path.join(root, "schema.json");
  fs.writeFileSync(promptFile, "Return structured output.");
  fs.writeFileSync(outputSchemaFile, "{}");
  return {
    purpose: "judge",
    cwd: root,
    promptFile,
    outputFile: path.join(root, "provider-final.json"),
    outputSchemaFile,
    eventLogFile: path.join(root, "events.ndjson"),
    stderrFile: path.join(root, "stderr.log"),
    timeoutSeconds: 10,
    extraArgs: [],
    allowWorkspaceTools: false,
  };
}

test("Claude carries rotated isolated credentials into the next invocation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-claude-refresh-"));
  const bin = path.join(root, "bin");
  const config = path.join(root, "config");
  fs.mkdirSync(bin);
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, ".credentials.json"), JSON.stringify({ generation: 0 }), {
    mode: 0o600,
  });
  const executable = path.join(bin, "claude");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
const { generation } = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.writeFileSync(file, JSON.stringify({ generation: generation + 1 }));
console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ generation }), structured_output: { generation }, usage: { input_tokens: 12, output_tokens_details: { reasoning_tokens: 4 }, service_tier: 'standard', iterations: [{ tokens: 3 }] } }));
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  const originalConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const first = await runClaude(providerInvocation(root));
    assert.deepEqual(first.structured, { generation: 0 });
    assert.deepEqual(first.usage, {
      input_tokens: 12,
      output_tokens_details: { reasoning_tokens: 4 },
      service_tier: "standard",
      iterations: [{ tokens: 3 }],
    });
    assert.deepEqual((await runClaude(providerInvocation(root))).structured, { generation: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config, ".credentials.json"), "utf8")), {
      generation: 2,
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Playwright browser path is resolved before provider HOME isolation", () => {
  const root = path.join(os.tmpdir(), "aek-playwright-cache-origin");
  assert.equal(
    playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "relative-cache", INIT_CWD: root }),
    path.resolve(root, "relative-cache"),
  );
  assert.equal(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" }), "0");

  const expectedCache =
    process.platform === "linux"
      ? path.join(os.homedir(), ".cache", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
        : path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  assert.equal(playwrightBrowsersPath({}), expectedCache);
});

for (const [provider, run] of [
  ["Codex", runCodex],
  ["Claude", runClaude],
] as const) {
  test(`${provider} rejects malformed structured event output`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `aek-${provider.toLowerCase()}-events-`));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const executable = path.join(bin, provider.toLowerCase());
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' not-json\n");
    fs.chmodSync(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    try {
      await assert.rejects(run(providerInvocation(root)), /malformed .* output at line 1/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
}

test("provider extra arguments cannot weaken evidence isolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-provider-boundary-"));
  try {
    await assert.rejects(
      runCodex({ ...providerInvocation(root), extraArgs: ["--sandbox=danger-full-access"] }),
      /codex extraArgs cannot include evidence-boundary option/,
    );
    await assert.rejects(
      runClaude({ ...providerInvocation(root), extraArgs: ["--tools", "Bash"] }),
      /claude extraArgs cannot include evidence-boundary option/,
    );
    await assert.rejects(
      runGrok({ ...providerInvocation(root), extraArgs: ["--cwd", root] }),
      /grok extraArgs cannot include evidence-boundary option/,
    );
    for (const extraArgs of [
      ["resume", "session"],
      ["--image", path.join(root, "context.png")],
    ]) {
      await assert.rejects(
        runCodex({ ...providerInvocation(root), extraArgs }),
        /codex extraArgs cannot include evidence-boundary option/,
      );
    }
    for (const extraArgs of [
      ["--agent", path.join(root, "agent.md")],
      ["--resume", "session"],
      ["-c"],
    ]) {
      await assert.rejects(
        runClaude({ ...providerInvocation(root), extraArgs }),
        /claude extraArgs cannot include evidence-boundary option/,
      );
    }
    for (const extraArgs of [
      ["--agent", path.join(root, "agent.md")],
      ["--rules", "external"],
      ["-r", "session"],
    ]) {
      await assert.rejects(
        runGrok({ ...providerInvocation(root), extraArgs }),
        /grok extraArgs cannot include evidence-boundary option/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex and Claude execute outside target-controlled instruction scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-provider-instructions-"));
  const project = path.join(root, "project");
  const invocationDir = path.join(project, ".agent-eval", "run", "scenario");
  const bin = path.join(project, "bin");
  const sourceClaudeConfig = path.join(root, "source-claude-config");
  fs.mkdirSync(invocationDir, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(sourceClaudeConfig);
  fs.writeFileSync(path.join(project, "AGENTS.md"), "Target-controlled Codex instructions\n");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "Target-controlled Claude instructions\n");
  fs.writeFileSync(path.join(sourceClaudeConfig, ".credentials.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(
    path.join(sourceClaudeConfig, "CLAUDE.md"),
    "User-controlled Claude instructions\n",
  );
  fs.writeFileSync(path.join(sourceClaudeConfig, "settings.json"), "{}\n");
  const codexCapture = path.join(root, "codex-capture.json");
  const claudeCapture = path.join(root, "claude-capture.json");

  const fakeProvider = (provider: "codex" | "claude") => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let cursor = process.cwd();
let instructionFound = false;
while (true) {
  instructionFound ||= fs.existsSync(path.join(cursor, "AGENTS.md")) || fs.existsSync(path.join(cursor, "CLAUDE.md"));
  const parent = path.dirname(cursor);
  if (parent === cursor) break;
  cursor = parent;
}
fs.writeFileSync(${JSON.stringify(provider === "codex" ? codexCapture : claudeCapture)}, JSON.stringify({
  cwd: process.cwd(),
  cwdArg: args[args.lastIndexOf("--cd") + 1],
  instructionFound,
  home: process.env.HOME,
  playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
  claudeConfig: process.env.CLAUDE_CONFIG_DIR,
  credentials: process.env.CLAUDE_CONFIG_DIR ? fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json")) : false,
  userMemory: process.env.CLAUDE_CONFIG_DIR ? fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "CLAUDE.md")) : false,
  settings: process.env.CLAUDE_CONFIG_DIR ? fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json")) : false,
  args,
}));
${
  provider === "codex"
    ? `fs.writeFileSync(args[args.lastIndexOf("--output-last-message") + 1], JSON.stringify({ ok: true }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "isolated" }));`
    : `console.log(JSON.stringify({ type: "result", result: JSON.stringify({ ok: true }), structured_output: { ok: true } }));`
}
`;
  for (const provider of ["codex", "claude"] as const) {
    const executable = path.join(bin, provider);
    fs.writeFileSync(executable, fakeProvider(provider));
    fs.chmodSync(executable, 0o755);
  }

  const originalPath = process.env.PATH;
  const originalClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.CLAUDE_CONFIG_DIR = sourceClaudeConfig;
  try {
    assert.deepEqual(
      (
        await runCodex({
          ...providerInvocation(invocationDir),
          timeoutSeconds: 240,
          mcp: {
            name: "browser",
            command: "true",
            args: [],
            configFile: "unused",
            toolNames: ["authenticate_email"],
          },
        })
      ).structured,
      { ok: true },
    );
    assert.deepEqual((await runClaude(providerInvocation(invocationDir))).structured, { ok: true });
    const codex = JSON.parse(fs.readFileSync(codexCapture, "utf8"));
    const claude = JSON.parse(fs.readFileSync(claudeCapture, "utf8"));
    for (const capture of [codex, claude]) {
      assert.equal(capture.cwd.startsWith(`${project}${path.sep}`), false);
      assert.equal(capture.instructionFound, false);
      assert.equal(
        fs.existsSync(capture.cwd),
        false,
        "provider working directory should be removed",
      );
    }
    assert.equal(codex.cwdArg, codex.cwd);
    assert.ok(codex.args.includes("mcp_servers.browser.tool_timeout_sec=240"));
    assert.equal(claude.args.includes("--safe-mode"), false);
    assert.equal(claude.home.startsWith(project), false);
    assert.equal(claude.playwrightBrowsersPath, playwrightBrowsersPath());
    assert.equal(claude.claudeConfig.startsWith(project), false);
    assert.equal(claude.credentials, true);
    assert.equal(claude.userMemory, false);
    assert.equal(claude.settings, false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Grok runs outside target and user instruction scopes while retaining subscription auth and MCP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-grok-provider-"));
  const project = path.join(root, "project");
  const invocationDir = path.join(project, ".agent-eval", "run", "scenario");
  const bin = path.join(root, "bin");
  const sourceGrokHome = path.join(root, "source-grok-home");
  fs.mkdirSync(invocationDir, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(sourceGrokHome);
  fs.writeFileSync(path.join(project, "AGENTS.md"), "Target-controlled instructions\n");
  fs.writeFileSync(path.join(sourceGrokHome, "config.toml"), "rules = ['user-controlled']\n");
  fs.writeFileSync(path.join(sourceGrokHome, "auth.json"), "{}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(sourceGrokHome, "agent_id"), "test-agent\n");

  const captureFile = path.join(root, "capture.json");
  const fakeGrok = path.join(bin, "grok");
  fs.writeFileSync(
    fakeGrok,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const lastValue = (flag) => args[args.lastIndexOf(flag) + 1];
let cursor = process.cwd();
let instructionFound = false;
while (true) {
  instructionFound ||= fs.existsSync(path.join(cursor, "AGENTS.md"));
  const parent = path.dirname(cursor);
  if (parent === cursor) break;
  cursor = parent;
}
fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  cwd: process.cwd(),
  cwdArg: lastValue("--cwd"),
  home: process.env.HOME,
  playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
  grokHome: process.env.GROK_HOME,
  auth: fs.existsSync(path.join(process.env.GROK_HOME, "auth.json")),
  userConfig: fs.existsSync(path.join(process.env.GROK_HOME, "config.toml")),
  mcp: fs.existsSync(path.join(process.cwd(), ".mcp.json")),
  instructionFound,
  tools: lastValue("--tools"),
  maxTurns: lastValue("--max-turns"),
  claudeInstructionsEnabled: process.env.GROK_CLAUDE_AGENTS_ENABLED,
}));
console.log(JSON.stringify({ structured_output: { ok: true }, result: "ok" }));
`,
  );
  fs.chmodSync(fakeGrok, 0o755);

  const promptFile = path.join(invocationDir, "prompt.md");
  const outputFile = path.join(invocationDir, "provider-final.json");
  const outputSchemaFile = path.join(invocationDir, "schema.json");
  const mcpConfig = path.join(invocationDir, ".mcp.json");
  fs.writeFileSync(promptFile, "Evaluate only supplied evidence.");
  fs.writeFileSync(outputSchemaFile, "{}");
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({ mcpServers: { evidence: { command: "true", args: [] } } }),
  );

  const originalPath = process.env.PATH;
  const originalGrokHome = process.env.GROK_HOME;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  process.env.GROK_HOME = sourceGrokHome;
  try {
    const result = await runGrok({
      purpose: "judge",
      cwd: invocationDir,
      promptFile,
      outputFile,
      outputSchemaFile,
      eventLogFile: path.join(invocationDir, "events.ndjson"),
      stderrFile: path.join(invocationDir, "stderr.log"),
      timeoutSeconds: 10,
      extraArgs: ["--max-turns", "100"],
      maxTurns: 20,
      allowWorkspaceTools: false,
      mcp: {
        name: "evidence",
        command: "true",
        args: [],
        configFile: mcpConfig,
        toolNames: ["view_screenshot"],
      },
    });
    assert.deepEqual(result.structured, { ok: true });
    const capture = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(capture.cwd, capture.cwdArg);
    assert.equal(capture.cwd.startsWith(project), false);
    assert.equal(capture.home.startsWith(project), false);
    assert.equal(capture.playwrightBrowsersPath, playwrightBrowsersPath());
    assert.equal(capture.auth, true);
    assert.equal(capture.userConfig, false);
    assert.equal(capture.mcp, true);
    assert.equal(capture.instructionFound, false);
    assert.equal(capture.tools, "");
    assert.equal(capture.maxTurns, "20");
    assert.equal(capture.claudeInstructionsEnabled, "0");
    assert.equal(
      fs.existsSync(capture.cwd),
      false,
      "isolated Grok directory should be removed after the run",
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Grok removes isolated credentials when setup fails after copying auth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-grok-cleanup-"));
  const temporaryRoot = path.join(root, "tmp");
  const sourceGrokHome = path.join(root, "source-grok-home");
  fs.mkdirSync(temporaryRoot);
  fs.mkdirSync(sourceGrokHome);
  fs.writeFileSync(path.join(sourceGrokHome, "auth.json"), "{}\n", { mode: 0o600 });
  const promptFile = path.join(root, "prompt.md");
  const schemaFile = path.join(root, "schema.json");
  fs.writeFileSync(promptFile, "Evaluate only supplied evidence.");
  fs.writeFileSync(schemaFile, "{}");

  const priorEnvironment = Object.fromEntries(
    ["GROK_HOME", "TMPDIR", "TEMP", "TMP"].map((name) => [name, process.env[name]]),
  );
  process.env.GROK_HOME = sourceGrokHome;
  process.env.TMPDIR = temporaryRoot;
  process.env.TEMP = temporaryRoot;
  process.env.TMP = temporaryRoot;
  try {
    await assert.rejects(
      runGrok({
        purpose: "judge",
        cwd: root,
        promptFile,
        outputFile: path.join(root, "provider-final.json"),
        outputSchemaFile: schemaFile,
        eventLogFile: path.join(root, "events.ndjson"),
        stderrFile: path.join(root, "stderr.log"),
        timeoutSeconds: 10,
        extraArgs: [],
        allowWorkspaceTools: false,
        mcp: {
          name: "evidence",
          command: "true",
          args: [],
          configFile: path.join(root, "missing-mcp.json"),
          toolNames: ["view_screenshot"],
        },
      }),
      /ENOENT|no such file/i,
    );
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  } finally {
    for (const [name, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex preserves graceful-exit timeout results instead of missing or truncated output errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-codex-timeout-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "codex");
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    for (const partialEvent of [false, true]) {
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(0));
${partialEvent ? `process.stdout.write(${JSON.stringify('{"type":')});` : ""}
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      const result = await runCodex({ ...providerInvocation(root), timeoutSeconds: 1 });
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.finalText, "");
      assert.equal(result.structured, undefined);
    }
    fs.writeFileSync(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
    await assert.rejects(
      runCodex(providerInvocation(root)),
      /completed without writing its required output file/,
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
