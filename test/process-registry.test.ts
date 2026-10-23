import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drainProcessRegistry, runningProcessGroups } from "../src/process-registry.js";

test("invalid process registries fail before signaling any group", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signal = t.mock.method(process, "kill", () => true);
  const file = path.join(root, "processes.json");
  for (const invalid of [{}, [0], [-1], [1.5], ["2"], [null], [1, 0]]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => runningProcessGroups(file), /Invalid process group registry/);
    await assert.rejects(drainProcessRegistry(file), /Invalid process group registry/);
  }
  assert.equal(signal.mock.callCount(), 0);
});

test("worker inspection reports live or inaccessible groups without terminating or rewriting them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aek-process-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "processes.json");
  const contents = JSON.stringify([123, 456, 789]);
  fs.writeFileSync(file, contents);
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    if (pid === -456) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (pid === -789) throw Object.assign(new Error("inaccessible"), { code: "EPERM" });
    assert.equal(pid, -123);
    return true;
  });
  assert.deepEqual(runningProcessGroups(file), [123, 789]);
  assert.equal(fs.readFileSync(file, "utf8"), contents);
});
