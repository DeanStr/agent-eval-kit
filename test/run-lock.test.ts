import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { withRunLock } from "../src/run/state.js";

test("stale run recovery excludes contenders throughout acquisition and permits recovery after owner death", {
  timeout: 15_000,
}, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-lock-race-"));
  const worker = path.join(root, "worker.mjs");
  fs.writeFileSync(
    path.join(root, ".run.lock"),
    JSON.stringify({ pid: 2147483647, token: "stale" }),
  );
  fs.writeFileSync(
    worker,
    `
    import fs from 'node:fs';
    import { withRunLock } from ${JSON.stringify(new URL("../src/run/state.ts", import.meta.url).href)};
    const root = process.argv[2];
    const original = fs.readFileSync;
    let first = true;
    fs.readFileSync = function(file, ...args) {
      const result = original.call(this, file, ...args);
      if (first && String(file).endsWith('.run.lock')) {
        first = false;
        process.send('read-stale-lock');
        while (!fs.existsSync(root + '/continue')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return result;
    };
    await withRunLock(root, async () => {
      process.send('entered');
      await new Promise(() => {});
    });
  `,
  );
  const child = fork(worker, [root], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    assert.deepEqual(await once(child, "message", { signal: context.signal }), [
      "read-stale-lock",
      undefined,
    ]);
    await assert.rejects(
      withRunLock(root, () => assert.fail("concurrent acquisition entered")),
      /acquisition is in progress/,
    );
    const entered = once(child, "message", { signal: context.signal });
    fs.writeFileSync(path.join(root, "continue"), "");
    assert.deepEqual(await entered, ["entered", undefined]);
    await assert.rejects(
      withRunLock(root, () => assert.fail("active lock entered")),
      /locked by active process/,
    );
    child.kill("SIGKILL");
    await exited;
    let recovered = false;
    await withRunLock(root, () => {
      recovered = true;
    });
    assert.equal(recovered, true);
    assert.equal(fs.existsSync(path.join(root, ".run.lock")), false);
    assert.equal(fs.existsSync(path.join(root, ".run.lock-acquisition")), false);
  } finally {
    child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted acquisition guards are never automatically reclaimed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-lock-guard-"));
  try {
    fs.mkdirSync(path.join(root, ".run.lock-acquisition"));
    await assert.rejects(
      withRunLock(root, () => assert.fail("orphan guard reclaimed")),
      /confirming no process/,
    );
    assert.equal(fs.existsSync(path.join(root, ".run.lock-acquisition")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual recovery preserves stale locks until the caller explicitly removes them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-lock-manual-"));
  const file = path.join(root, ".run.lock");
  const owner = JSON.stringify({ pid: 2147483647, token: "stale" });
  fs.writeFileSync(file, owner);
  try {
    await assert.rejects(
      withRunLock(root, () => assert.fail("stale lock reclaimed"), { recoverStale: false }),
      /Stop all processes from the interrupted experiment/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), owner);
    assert.equal(fs.existsSync(path.join(root, ".run.lock-acquisition")), false);
    fs.unlinkSync(file);
    await withRunLock(root, () => {}, { recoverStale: false });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
