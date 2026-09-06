import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startLifecycle } from "../src/lifecycle.js";
import type { EvalConfig } from "../src/types.js";

test("readiness is checked for an already-running target without a start command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-ready-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Ready", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      ready: { command: "echo ready", timeoutSeconds: 2, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const handle = await startLifecycle(config, root);
  await handle.stop();
  assert.match(fs.readFileSync(path.join(root, "lifecycle", "ready.stdout.log"), "utf8"), /ready/);
});

test("readiness polling does not sleep past its configured deadline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-ready-deadline-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Ready deadline", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      ready: { command: "exit 1", timeoutSeconds: 0.05, intervalMs: 2_000 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  const started = Date.now();
  await assert.rejects(() => startLifecycle(config, root), /within 0\.05s/);
  assert.ok(Date.now() - started < 1_000, "readiness failure slept beyond its deadline");
});

test("a readiness command cannot become successful by exiting zero after its timeout", {
  skip: process.platform === "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-ready-timeout-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Ready timeout", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      ready: {
        command: "trap 'exit 0' TERM; while :; do :; done",
        timeoutSeconds: 0.05,
        intervalMs: 10,
      },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  await assert.rejects(() => startLifecycle(config, root), /readiness command timed out/);
});

test("a setup command cannot become successful by exiting zero after its timeout", {
  skip: process.platform === "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-setup-timeout-"));
  const config: EvalConfig = {
    version: 1,
    project: { name: "Setup timeout", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      setup: {
        command: "trap 'exit 0' TERM; while :; do :; done",
        timeoutSeconds: 0.05,
      },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  await assert.rejects(() => startLifecycle(config, root), /setup command timed out after 0\.05s/);
});

test("a signal-terminated start command is rejected with and without a readiness probe", {
  skip: process.platform === "win32",
}, async () => {
  for (const ready of [undefined, { command: "exit 1", timeoutSeconds: 2, intervalMs: 10 }]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-signaled-start-"));
    const config: EvalConfig = {
      version: 1,
      project: { name: "Signaled", root },
      target: {
        kind: "command",
        allowedOrigins: [],
        start: { command: "kill -TERM $$" },
        ...(ready ? { ...(ready === undefined ? {} : { ready: ready }) } : {}),
      },
      agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
      judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
      paths: { specs: root, runs: root, auth: root },
      browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
      scoring: { partialCredit: 0.5, minimumCoverage: 60 },
      variables: {},
    };
    await assert.rejects(() => startLifecycle(config, root), /signal SIGTERM/);
  }
});

test("stopping a managed target kills descendants that outlive the start shell", {
  skip: process.platform === "win32",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-start-descendant-"));
  const pidFile = path.join(root, "descendant.pid");
  const command = `sh -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done' & wait`;
  const config: EvalConfig = {
    version: 1,
    project: { name: "Start descendant", root },
    target: {
      kind: "command",
      allowedOrigins: [],
      start: { command },
      ready: { command: `test -f ${JSON.stringify(pidFile)}`, timeoutSeconds: 2, intervalMs: 10 },
    },
    agent: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    judge: { provider: "mock", timeoutSeconds: 10, extraArgs: [] },
    paths: { specs: root, runs: root, auth: root },
    browser: { headless: true, viewport: { width: 1280, height: 800 }, actionTimeoutMs: 1_000 },
    scoring: { partialCredit: 0.5, minimumCoverage: 60 },
    variables: {},
  };
  let descendantPid = 0;
  try {
    const handle = await startLifecycle(config, root);
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    await handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    if (descendantPid > 0) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
