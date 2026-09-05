import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shellInvocation, spawnCaptured, subscriptionEnvironment } from "../src/providers/process.js";
import { withCancellation } from "../src/cancellation.js";

for (const reason of ["timeout", "cancellation"] as const) {
  test(`${reason} waits for descendants after the captured leader exits`, { skip: process.platform === "win32", timeout: 15_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-descendant-"));
    const controller = new AbortController();
    let descendantPid = 0;
    // The descendant closes inherited pipes and acknowledges installing its
    // signal handler before its parent announces readiness to the harness.
    const descendant = `process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000);`;
    const parent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',pid=>console.log(pid)); setInterval(()=>{},1000);`;
    try {
      const invocation = withCancellation(controller.signal, () => spawnCaptured({
        command: process.execPath, args: ["-e", parent], cwd: root,
        timeoutSeconds: reason === "timeout" ? 1 : 30,
        stdoutFile: path.join(root, "stdout.log"), stderrFile: path.join(root, "stderr.log"),
        onLine: (stream, line) => {
          if (stream !== "stdout") return;
          descendantPid = Number(line);
          if (reason === "cancellation") controller.abort(new Error("test interruption"));
        },
      }));
      if (reason === "timeout") assert.equal((await invocation).timedOut, true);
      else await assert.rejects(invocation, /test interruption/);
      assert.ok(descendantPid > 0, "descendant started before termination");
      assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
    } finally {
      if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ } }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("shell execution rejects native Windows instead of guessing at process cleanup", () => {
  assert.throws(() => shellInvocation("pnpm test", "win32"), /Native Windows evaluation is not supported/);
  assert.deepEqual(shellInvocation("pnpm test", "linux"), { command: "bash", args: ["--noprofile", "--norc", "-c", "pnpm test"] });
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
