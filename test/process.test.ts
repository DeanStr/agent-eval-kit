import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { terminateWindowsTree, windowsTaskkillArguments } from "../src/process-tree.js";
import { shellInvocation, spawnCaptured, subscriptionEnvironment } from "../src/providers/process.js";

test("Windows process-tree termination targets descendants and escalates explicitly", () => {
  assert.deepEqual(windowsTaskkillArguments(4321, false), ["/pid", "4321", "/t"]);
  assert.deepEqual(windowsTaskkillArguments(4321, true), ["/pid", "4321", "/t", "/f"]);
});

test("Windows process-tree termination rejects when taskkill fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-taskkill-"));
  const taskkill = path.join(root, "taskkill");
  fs.writeFileSync(taskkill, "#!/bin/sh\necho cannot-terminate >&2\nexit 7\n");
  fs.chmodSync(taskkill, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
  try {
    await assert.rejects(terminateWindowsTree(4321, true), /exit 7: cannot-terminate/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("Windows shell invocations propagate the configured command's native exit status", () => {
  const invocation = shellInvocation("pnpm test", "win32");
  assert.equal(invocation.command, "powershell");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(invocation.args[3], /pnpm test[\s\S]*\$\?[\s\S]*\$LASTEXITCODE/);
  assert.match(invocation.args[3], /exit \$_aekNativeExitCode/);
});

test("subscription provider environments expose only required runtime settings", () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_URL",
    "AEK_TEST_PROJECT_SECRET",
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "must-not-be-inherited";
  try {
    const environment = subscriptionEnvironment("claude");
    for (const name of names) assert.equal(environment[name], undefined, name);
    assert.equal(environment.PATH, process.env.PATH);
    assert.equal(environment.NO_COLOR, "1");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("subscription provider environments fail fast on credential-bearing proxies", () => {
  const original = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "https://proxy-user:proxy-password@proxy.example.test:8443";
  try {
    assert.throws(
      () => subscriptionEnvironment("codex"),
      /credential-bearing provider proxy setting HTTPS_PROXY/,
    );
  } finally {
    if (original === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = original;
  }
});

test("captured process output is fully flushed before returning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-"));
  const expectedBytes = 2 * 1024 * 1024;
  const stdoutFile = path.join(root, "stdout.log");
  const result = await spawnCaptured({
    command: process.execPath,
    args: ["-e", `process.stdout.write("x".repeat(${expectedBytes}))`],
    cwd: root,
    timeoutSeconds: 10,
    stdoutFile,
    stderrFile: path.join(root, "stderr.log"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.statSync(stdoutFile).size, expectedBytes);
  assert.equal(result.stdout.length, expectedBytes);
});

test("captured process output preserves UTF-8 split across pipe chunks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-utf8-"));
  const stdoutFile = path.join(root, "stdout.log");
  const stderrFile = path.join(root, "stderr.log");
  const expected = `${JSON.stringify({ message: "café 😀" })}\n`;
  const lines: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  try {
    const result = await spawnCaptured({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require("node:fs");for(const byte of Buffer.from(${JSON.stringify(expected)})){fs.writeSync(1,Buffer.from([byte]));fs.writeSync(2,Buffer.from([byte]));}`,
      ],
      cwd: root,
      timeoutSeconds: 10,
      stdoutFile,
      stderrFile,
      onLine: (stream, line) => lines[stream].push(line),
    });
    assert.equal(result.stdout, expected);
    assert.equal(result.stderr, expected);
    assert.equal(fs.readFileSync(stdoutFile, "utf8"), expected);
    assert.equal(fs.readFileSync(stderrFile, "utf8"), expected);
    assert.deepEqual(lines.stdout, [expected.trim()]);
    assert.deepEqual(lines.stderr, [expected.trim()]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
