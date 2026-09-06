import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertEvaluationPlatform } from "../src/platform.js";
import { spawnCaptured } from "../src/providers/process.js";
import { runEvaluation } from "../src/runner.js";
import { startLifecycle } from "../src/lifecycle.js";
import { BrowserSession } from "../src/browser/session.js";
import { doctor } from "../src/doctor.js";

test("native Windows is rejected before run, lifecycle, browser, or subprocess setup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-platform-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    assert.doesNotThrow(() => assertEvaluationPlatform("linux"));
    assert.doesNotThrow(() => assertEvaluationPlatform("darwin"));
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    await assert.rejects(
      runEvaluation({} as Parameters<typeof runEvaluation>[0]),
      /Native Windows.*WSL\/Linux/,
    );
    await assert.rejects(
      startLifecycle({} as Parameters<typeof startLifecycle>[0], root),
      /Native Windows/,
    );
    await assert.rejects(
      new BrowserSession(root, true, "https://example.test").start(),
      /Native Windows/,
    );
    await assert.rejects(
      spawnCaptured({
        command: process.execPath,
        args: [],
        cwd: root,
        timeoutSeconds: 1,
        stdoutFile: path.join(root, "stdout"),
        stderrFile: path.join(root, "stderr"),
      }),
      /Native Windows/,
    );
    const checks = doctor();
    assert.equal(checks.length, 1, "doctor must not probe executables on an unsupported platform");
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].required, true);
    assert.deepEqual(fs.readdirSync(root), [], "no runtime artifacts should be created");
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows CLI evaluation fails before config loading or campaign directory creation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-cli-platform-"));
  const cli = new URL("../src/cli.ts", import.meta.url).href;
  try {
    for (const args of [
      ["run"],
      ["campaign", "--output", path.join(root, "campaign")],
      ["auth", "--persona", "test"],
    ]) {
      const code = `Object.defineProperty(process, 'platform', {value:'win32'}); process.argv = [process.execPath, 'aek', ...${JSON.stringify(args)}]; await import(${JSON.stringify(cli)});`;
      const result = spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Native Windows evaluation is not supported/);
      assert.doesNotMatch(result.stderr, /No config file/);
    }
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
